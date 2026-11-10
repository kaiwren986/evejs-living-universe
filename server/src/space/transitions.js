"use strict";

const {
  toFiniteNumber,
} = require("../common/numbers");

const path = require("path");
let transitionIDProvider = require("node:crypto").randomUUID;

const { PROXY_NODE_ID } = require(path.join(__dirname, "../network/protocolProfile"));
const log = require(path.join(__dirname, "../utils/logger"));
const sessionRegistry = require(path.join(
  __dirname,
  "../services/chat/sessionRegistry",
));
const {
  describeSessionHydrationState,
  flushPendingCommandSessionEffects,
} = require(path.join(
  __dirname,
  "../services/chat/commandSessionEffects",
));
const {
  queuePostSpaceAttachFittingHydration,
} = require(path.join(__dirname, "./modules/spaceAttachHydration"));
const {
  applyCharacterToSession,
  clearDockedFittingBootstrap,
  clearDeferredDockedShipSessionChange,
  flushCharacterSessionNotificationPlan,
  getCharacterRecord,
  peekCharacterRecord,
  getCharacterShips,
  findCharacterShip,
  getActiveShipRecord,
  updateCharacterRecord,
  syncInventoryItemForSession,
  emitItemsChangedForSession,
} = require(path.join(__dirname, "../services/character/characterState"));
const {
  CAPSULE_TYPE_ID,
  ITEM_FLAGS,
  ensureCapsuleForCharacter,
  findItemById,
  findShipItemById,
  isCapsuleTypeID,
  listContainerItems,
  moveShipToSpace,
  moveShipToSpaceIdempotent,
  getShipSpaceMoveReceipt,
  dockShipToLocation,
  dockShipToStation,
  normalizeShipConditionState,
  removeInventoryItem,
  restoreInventoryItemChangesAtomic,
  setActiveShipForCharacter,
  transferItemToOwnerLocation,
  updateShipItem,
} = require(path.join(__dirname, "../services/inventory/itemStore"));
const {
  SPECIAL_SHIP_HOLD_FLAGS,
} = require(path.join(
  __dirname,
  "../services/inventory/specialShipHoldRegistry",
));
const structureState = require(path.join(
  __dirname,
  "../services/structure/structureState",
));
const {
  getDockedLocationID,
  getDockedLocationKind,
  getSessionStructureID,
  isDockedSession,
  isStructureDockedSession,
} = require(path.join(__dirname, "../services/structure/structureLocation"));
const {
  currentFileTime,
} = require(path.join(__dirname, "../services/_shared/serviceHelpers"));
const {
  getAppliedSkinRecord,
} = require(path.join(__dirname, "../services/ship/shipCosmeticsState"));
const {
  getEnabledCosmeticsEntries,
} = require(path.join(__dirname, "../services/ship/shipLogoFittingState"));
const {
  buildEmergencyWarpReturnSpaceState,
  clearEmergencyWarpReturnState,
  getEmergencyWarpReturnState,
  shipSuppressesEmergencyWarp,
} = require(path.join(__dirname, "../services/_shared/emergencyWarpRuntime"));
const mapTelemetryState = require(path.join(
  __dirname,
  "../services/map/mapTelemetryState",
));
const {
  broadcastStationGuestJoined,
  broadcastStationGuestLeft,
  broadcastStructureGuestJoined,
  broadcastStructureGuestLeft,
} = require(path.join(__dirname, "../services/_shared/guestLists"));
const crimewatchState = require(path.join(__dirname, "../services/security/crimewatchState"));
const worldData = require(path.join(__dirname, "./worldData"));
const spaceRuntime = require(path.join(__dirname, "./runtime"));
const { resolveItemByTypeID } = require("../services/inventory/itemTypeRegistry");
const {
  resetEntityMotion,
} = require("./runtime/destinyMovementEngine");
const { persistShipEntity } = require("./runtime/entitySpacePersistence");
const {
  buildObserverStargateJumpFxOptions,
} = require("./runtime/staticSceneEntity");
const {
  queueOrApplyMovementChange,
} = require("./destiny/commands/movementQueueing.js");
const {
  seedBallSlots,
} = require("./destiny/simulation/evolve.js");
const {
  buildPlayerEgoScopeMetadata,
  canEntitiesInteractLocally,
} = require(path.join(
  __dirname,
  "./destiny/identity/interactionScope.js",
));
const hostileModuleRuntime = require(path.join(
  __dirname,
  "./modules/hostileModuleRuntime",
));
const {
  DESTINY_TICK_INTERVAL_MS,
} = require(path.join(__dirname, "./runtime/destinyTickDriver.js"));
const {
  PILOT_WARP_ACTIVATION_DELAY_DESTINY_TICKS,
} = require(path.join(__dirname, "./destiny/simulation/warpContract.js"));
const {
  resolveStargatePhysicalRadius,
} = require(path.join(__dirname, "./stargateRadius"));
const {
  getStargateSystemForwardDirection,
} = require(path.join(__dirname, "./stargateOrientation"));
const {
  isAbyssalHostLocationID,
} = require("../abyssal").engineSupport.hostLocation;
// TQ holds a normal gate command for roughly four seconds and, independently,
// leaves at least three seconds after JumpOut reaches the client's Destiny
// timeline.  The second floor matters when an accepted warp landing has moved
// the client's history ahead of the scene clock.
const STARGATE_JUMP_COMMAND_HANDOFF_DELAY_MS = 4000;
const STARGATE_JUMP_POST_FX_HANDOFF_DELAY_MS = 3000;
// A deadline converted once with the old TiDi factor can become needlessly
// late when TiDi recovers. Recheck in bounded wallclock slices while keeping
// the authoritative deadline in simulation time.
const STARGATE_JUMP_HANDOFF_RECHECK_MAX_DELAY_MS = 1000;
// A cold destination is woken inside the hold, this long after the Destiny
// tick that sends the JumpOut, so the wake never delays the JumpOut itself.
// The handoff then only attaches, as TQ's arrival does after its hold.
const STARGATE_JUMP_DESTINATION_PREWARM_AFTER_JUMPOUT_MS = 250;
const STARGATE_JUMP_RANGE_METERS = 2500;
// Retail drops an arrival at a random spot the same fixed distance out from
// the gate's hull, so a fleet in matching hulls does not stack on one point.
// The direction is what varies; the distance does not. Scattering the distance
// too would pull every arrival closer to the gate than retail places it, which
// changes approach times and gate-camp coverage for players who are not the
// ones being fixed here.
const STARGATE_JUMP_IN_SURFACE_CLEARANCE_METERS = 12000;
const STARGATE_JUMP_IN_SCATTER_CONE_RADIANS = (45 * Math.PI) / 180;
const STARGATE_JUMP_QUEUE_SPACE = 1000;
const STARGATE_JUMP_QUEUE_TIMEOUT_SECONDS = 180;
const SPACE_BOARDING_RANGE_METERS = 6550;
const SESSION_CHANGE_COOLDOWN_MS = 10000;
const FILETIME_EPOCH_OFFSET = 116444736000000000n;
const FILETIME_TICKS_PER_MS = 10000n;
const UNDOCK_INVULNERABILITY_DURATION_TICKS = 300000000n;
const UNDOCK_INVULNERABILITY_DURATION_MS = Number(
  UNDOCK_INVULNERABILITY_DURATION_TICKS / FILETIME_TICKS_PER_MS,
);
const TYPE_ORCA = 28606;
const stargateJumpQueuesByDestination = new Map();
const DOCKED_SHIP_CONTENT_REFRESH_FLAGS = new Set([
  ITEM_FLAGS.CARGO_HOLD,
  ITEM_FLAGS.DRONE_BAY,
  ITEM_FLAGS.FIGHTER_BAY,
  ITEM_FLAGS.FUEL_BAY,
  ITEM_FLAGS.SHIP_HANGAR,
  ITEM_FLAGS.FLEET_HANGAR,
  ITEM_FLAGS.MOBILE_DEPOT_HOLD,
  ...SPECIAL_SHIP_HOLD_FLAGS,
]);
const SCRIPTED_HIC_STARGATE_BLOCKED_GROUP_IDS = new Set([
  30, // Titan
  485, // Dreadnought
  547, // Carrier
  659, // Supercarrier
  883, // Capital Industrial Ship
  1538, // Force Auxiliary
  4594, // Lancer Dreadnought
  5120, // Command Carrier
]);
const SCRIPTED_HIC_STARGATE_EXEMPT_GROUP_IDS = new Set([
  513, // Freighter
  902, // Jump Freighter
]);
const BOARDED_CAPSULE_REMOVED_JUNK_LOCATION_ID = 10;

let contrabandInspectionRuntimeModule = null;

function getContrabandInspectionRuntimeModule() {
  if (!contrabandInspectionRuntimeModule) {
    contrabandInspectionRuntimeModule = require(path.join(
      __dirname,
      "../services/security/contrabandInspectionRuntime",
    ));
  }
  return contrabandInspectionRuntimeModule;
}

function getCrimewatchReferenceMs(session) {
  if (session && session._space && Number.isFinite(Number(session._space.simTimeMs))) {
    return Number(session._space.simTimeMs);
  }
  return Date.now();
}

function isScriptedHicStargateBlockedShip(ship) {
  const typeID = toInt(ship && ship.typeID, 0);
  const groupID = toInt(ship && ship.groupID, 0);
  if (typeID === TYPE_ORCA) {
    return false;
  }
  if (SCRIPTED_HIC_STARGATE_EXEMPT_GROUP_IDS.has(groupID)) {
    return false;
  }
  return SCRIPTED_HIC_STARGATE_BLOCKED_GROUP_IDS.has(groupID);
}

function topOffShipShieldAndCapacitorForDockingTransition(shipId) {
  return updateShipItem(shipId, (currentShip) => ({
    ...currentShip,
    conditionState: normalizeShipConditionState({
      ...(currentShip.conditionState || {}),
      charge: 1.0,
      shieldCharge: 1.0,
    }),
  }));
}

function deactivateActiveModulesForSpaceTransition(session, reason) {
  if (!session || !session._space) {
    return {
      success: true,
      data: {
        stoppedModuleIDs: [],
        errors: [],
      },
    };
  }

  const result = spaceRuntime.deactivateAllActiveModules(session, {
    reason,
  });
  if (!result || result.success !== true) {
    log.warn(
      `[SpaceTransition] Failed to fully deactivate active modules before ${reason} ` +
      `for ${session.characterName || session.characterID}: ` +
      `${result && result.errorMsg ? result.errorMsg : "ACTIVE_MODULE_DEACTIVATION_FAILED"}`,
    );
  }
  return result || {
    success: false,
    errorMsg: "ACTIVE_MODULE_DEACTIVATION_FAILED",
  };
}

function syncInventoryChangesToSession(session, changes = [], options = {}) {
  if (!session || typeof session.sendNotification !== "function") {
    return 0;
  }

  let syncedCount = 0;
  for (const change of Array.isArray(changes) ? changes : []) {
    if (!change || !change.item) {
      continue;
    }

    syncInventoryItemForSession(
      session,
      change.item,
      change.previousData || change.previousState || {},
      {
        emitCfgLocation: options.emitCfgLocation !== false,
      },
    );
    syncedCount += 1;
  }

  return syncedCount;
}

function buildEmptyDict() {
  return { type: "dict", entries: [] };
}

function buildEnabledCosmeticsDictForShip(shipID) {
  try {
    const entries = getEnabledCosmeticsEntries(shipID);
    return {
      type: "dict",
      entries: entries.map((entry) => [
        Number(entry.backendSlot) || 0,
        Number(entry.cosmeticType) || 0,
      ]),
    };
  } catch (error) {
    log.warn(
      `[SpaceTransition] Failed to build cosmetics dict ship=${shipID}: ${error.message}`,
    );
    return buildEmptyDict();
  }
}

function getAppliedShipSkinID(shipID) {
  try {
    const record = getAppliedSkinRecord(shipID);
    return Number(record && record.skinID) || 0;
  } catch (error) {
    log.warn(
      `[SpaceTransition] Failed to resolve current skin ship=${shipID}: ${error.message}`,
    );
    return 0;
  }
}

function sendShipCosmeticsChanged(session, shipID) {
  const normalizedShipID = Number(shipID || 0) || 0;
  if (
    normalizedShipID <= 0 ||
    !session ||
    typeof session.sendNotification !== "function"
  ) {
    return false;
  }

  session.sendNotification("OnShipCosmeticsChanged", "charid", [
    normalizedShipID,
    buildEnabledCosmeticsDictForShip(normalizedShipID),
  ]);
  return true;
}

function sendCurrentShipSkinChange(session, shipID) {
  const normalizedShipID = Number(shipID || 0) || 0;
  if (
    normalizedShipID <= 0 ||
    !session ||
    typeof session.sendNotification !== "function"
  ) {
    return false;
  }

  session.sendNotification("OnCurrentShipSkinChange", "clientID", [
    normalizedShipID,
    getAppliedShipSkinID(normalizedShipID),
  ]);
  return true;
}

function sendPodOrCorvetteAssembly(session, capsuleItem) {
  const capsuleID = Number(capsuleItem && capsuleItem.itemID) || 0;
  const capsuleTypeID = Number(capsuleItem && capsuleItem.typeID) || CAPSULE_TYPE_ID;
  if (
    capsuleID <= 0 ||
    !session ||
    typeof session.sendNotification !== "function"
  ) {
    return false;
  }

  session.sendNotification("OnPodOrCorvetteAssembly", "charid", [
    capsuleID,
    capsuleTypeID,
  ]);
  return true;
}

function buildBoardedCapsuleRemovedNotificationState(item) {
  if (!item || typeof item !== "object") {
    return null;
  }

  return {
    ...item,
    locationID: BOARDED_CAPSULE_REMOVED_JUNK_LOCATION_ID,
    flagID: 0,
    quantity: Number(item.singleton) === 2 ? -2 : -1,
    stacksize: 1,
    singleton: Number(item.singleton) || 1,
  };
}

function emitBoardedCapsuleItemsChanged(session, capsuleItem, previousState = {}) {
  const removedState = buildBoardedCapsuleRemovedNotificationState(capsuleItem);
  if (!removedState) {
    return false;
  }

  return emitItemsChangedForSession(
    session,
    removedState,
    {
      locationID:
        previousState.locationID !== undefined
          ? previousState.locationID
          : capsuleItem.locationID,
      flagID:
        previousState.flagID !== undefined ? previousState.flagID : capsuleItem.flagID,
      quantity:
        previousState.quantity !== undefined
          ? previousState.quantity
          : capsuleItem.quantity,
      singleton:
        previousState.singleton !== undefined
          ? previousState.singleton
          : capsuleItem.singleton,
      stacksize:
        previousState.stacksize !== undefined
          ? previousState.stacksize
          : capsuleItem.stacksize,
    },
    {
      idType: "charid",
      locationContext: null,
    },
  );
}

function applyTqDockingTransitionSessionChangeShape(plan) {
  if (!plan || !plan.sessionChanges) {
    return plan;
  }
  const sessionChanges = plan.sessionChanges;
  delete sessionChanges.stationid2;

  const orderedChanges = {};
  for (const key of ["stationid", "structureid", "locationid", "solarsystemid"]) {
    if (Object.prototype.hasOwnProperty.call(sessionChanges, key)) {
      orderedChanges[key] = sessionChanges[key];
    }
  }
  for (const [key, value] of Object.entries(sessionChanges)) {
    if (!Object.prototype.hasOwnProperty.call(orderedChanges, key)) {
      orderedChanges[key] = value;
    }
  }
  plan.sessionChanges = orderedChanges;
  return plan;
}

function sendUndockInvulnerabilityUpdated(session, shipID) {
  if (!session || typeof session.sendNotification !== "function") {
    return false;
  }

  const normalizedShipID = Number(shipID || session.shipid || session.shipID || 0);
  if (!Number.isFinite(normalizedShipID) || normalizedShipID <= 0) {
    return false;
  }

  session.sendNotification("OnInvulunOnUndockingUpdated", "shipid", [
    normalizedShipID,
    currentFileTime() + UNDOCK_INVULNERABILITY_DURATION_TICKS,
    UNDOCK_INVULNERABILITY_DURATION_TICKS,
  ]);
  return true;
}

function sendInvulnerabilityCancelled(session, shipID) {
  if (!session || typeof session.sendNotification !== "function") {
    return false;
  }

  const normalizedShipID = Number(shipID || session.shipid || session.shipID || 0);
  if (!Number.isFinite(normalizedShipID) || normalizedShipID <= 0) {
    return false;
  }

  session.sendNotification("OnInvulnCancelled", "shipid", [normalizedShipID]);
  return true;
}

function clearPendingUndockInvulnerability(session) {
  if (!session) {
    return false;
  }
  let cleared = false;
  for (const fieldName of [
    "_undockInvulnerabilityCancelTimer",
    "_timedInvulnerabilityCancelTimer",
  ]) {
    const timer = session[fieldName];
    if (!timer) {
      continue;
    }
    clearTimeout(timer);
    session[fieldName] = null;
    cleared = true;
  }
  return cleared;
}

function markUndockInvulnerabilityState(session, shipID, durationMs) {
  const scene = spaceRuntime.getSceneForSession(session);
  const entity = scene && typeof scene.getEntityByID === "function"
    ? scene.getEntityByID(shipID)
    : null;
  if (!entity) {
    return false;
  }
  const nowMs = scene.getCurrentSimTimeMs();
  entity.undockInvulnerabilityActive = true;
  entity.undockInvulnerabilityUntilMs =
    nowMs + Math.max(0, Number(durationMs) || 0);
  return true;
}

function scheduleUndockInvulnerabilityCancellation(session, shipID, options = {}) {
  clearPendingUndockInvulnerability(session);
  const delayMs = Math.max(
    0,
    Number.isFinite(Number(options.delayMs))
      ? Number(options.delayMs)
      : UNDOCK_INVULNERABILITY_DURATION_MS,
  );
  markUndockInvulnerabilityState(session, shipID, delayMs);
  const timer = setTimeout(() => {
    if (!session || session._undockInvulnerabilityCancelTimer !== timer) {
      return;
    }
    session._undockInvulnerabilityCancelTimer = null;
    const scene = spaceRuntime.getSceneForSession(session);
    sendInvulnerabilityCancelled(session, shipID);
    const entity = scene && typeof scene.getEntityByID === "function"
      ? scene.getEntityByID(shipID)
      : null;
    if (entity) {
      entity.undockInvulnerabilityActive = false;
      entity.undockInvulnerabilityUntilMs = 0;
    }
    if (scene && typeof scene.syncSessionStructureTetherState === "function") {
      const tetherSync = scene.syncSessionStructureTetherState(session, {
        forceReplayFx: true,
        repairOnEngage: true,
        replayFx: false,
      });
      const tetherStructureID =
        tetherSync &&
        tetherSync.success &&
        tetherSync.data &&
        tetherSync.data.active
          ? tetherSync.data.structureID
          : 0;
      if (
        tetherStructureID > 0 &&
        typeof scene.sendTqUndockTetherPresentationToSession === "function"
      ) {
        scene.sendTqUndockTetherPresentationToSession(
          session,
          shipID,
          tetherStructureID,
        );
      }
    }
  }, delayMs);
  if (typeof timer.unref === "function") {
    timer.unref();
  }
  session._undockInvulnerabilityCancelTimer = timer;
  return true;
}

function sendDockingFinished(session, stationID) {
  if (!session || typeof session.sendNotification !== "function") {
    return false;
  }

  const normalizedStationID = Number(stationID || session.stationid || session.stationID || 0);
  if (!Number.isFinite(normalizedStationID) || normalizedStationID <= 0) {
    return false;
  }

  session.sendNotification("OnDockingFinished", "charid", [normalizedStationID]);
  return true;
}

function getStargateJumpQueue(destinationSolarSystemID) {
  const normalizedDestinationID = Number(destinationSolarSystemID || 0);
  if (!Number.isFinite(normalizedDestinationID) || normalizedDestinationID <= 0) {
    return null;
  }
  if (!stargateJumpQueuesByDestination.has(normalizedDestinationID)) {
    stargateJumpQueuesByDestination.set(normalizedDestinationID, new Map());
  }
  return stargateJumpQueuesByDestination.get(normalizedDestinationID);
}

function cleanupStargateJumpQueue(destinationSolarSystemID, nowMs = Date.now()) {
  const normalizedDestinationID = Number(destinationSolarSystemID || 0);
  const queue = stargateJumpQueuesByDestination.get(normalizedDestinationID);
  if (!queue) {
    return null;
  }
  for (const [characterID, entry] of queue.entries()) {
    if (!entry || Number(entry.expiresAtMs || 0) <= nowMs) {
      queue.delete(characterID);
    }
  }
  if (queue.size === 0) {
    stargateJumpQueuesByDestination.delete(normalizedDestinationID);
    return null;
  }
  return queue;
}

function recordStargateJumpQueueEntry(
  destinationSolarSystemID,
  characterID,
  options = {},
) {
  const normalizedCharacterID = Number(characterID || 0);
  if (!Number.isFinite(normalizedCharacterID) || normalizedCharacterID <= 0) {
    return null;
  }
  const nowMs = Number.isFinite(Number(options.nowMs))
    ? Number(options.nowMs)
    : Date.now();
  cleanupStargateJumpQueue(destinationSolarSystemID, nowMs);
  const queue = getStargateJumpQueue(destinationSolarSystemID);
  if (!queue) {
    return null;
  }
  queue.set(normalizedCharacterID, {
    characterID: normalizedCharacterID,
    fileTime:
      options.fileTime === undefined || options.fileTime === null
        ? currentFileTime()
        : options.fileTime,
    expiresAtMs: nowMs + STARGATE_JUMP_QUEUE_TIMEOUT_SECONDS * 1000,
  });
  return queue;
}

function getStargateJumpQueuePayload(destinationSolarSystemID, activeCharacterID) {
  const activeEntryQueue = recordStargateJumpQueueEntry(
    destinationSolarSystemID,
    activeCharacterID,
  );
  const queue =
    activeEntryQueue || cleanupStargateJumpQueue(destinationSolarSystemID) || null;
  if (!queue || queue.size === 0) {
    return null;
  }
  const characterIDs = [];
  const timestampEntries = [];
  for (const [characterID, entry] of queue.entries()) {
    characterIDs.push(characterID);
    timestampEntries.push([characterID, entry.fileTime]);
  }
  return {
    characterIDs,
    timestampEntries,
  };
}

function sendJumpQueueUpdate(session, destinationSolarSystemID) {
  if (!session || typeof session.sendNotification !== "function") {
    return false;
  }

  const normalizedDestinationID = Number(destinationSolarSystemID || 0);
  const characterID = Number(session.characterID || session.charid || session.charID || 0);
  const queuePayload = getStargateJumpQueuePayload(
    normalizedDestinationID,
    characterID,
  );
  if (
    !Number.isFinite(normalizedDestinationID) ||
    normalizedDestinationID <= 0 ||
    !Number.isFinite(characterID) ||
    characterID <= 0 ||
    !queuePayload
  ) {
    return false;
  }

  session.sendNotification("OnJumpQueueUpdate", "clientID", [
    normalizedDestinationID,
    STARGATE_JUMP_QUEUE_SPACE,
    queuePayload.characterIDs,
    {
      type: "dict",
      entries: queuePayload.timestampEntries,
    },
    STARGATE_JUMP_QUEUE_TIMEOUT_SECONDS,
  ]);
  return true;
}

/**
 * The objects a transition leaves bound, by the service they are of. The fleet's object is not where the session is:
 * Tranquility keeps it from GetInitState to LeaveFleet whatever the pilot does between, and lets it go once the pilot
 * has left (Archive/Join Fleet - Receive Boss - Set other as boss - leave fleet.txt: one object for the whole fleet,
 * its OnMachoObjectDisconnect after LeaveFleet), and on a stargate jump lets go of the ballpark's objects and not the
 * others (Archive/Autopilot thru a few systems.txt). The client's fleet service keeps the object CreateFleet answered
 * for as long as it is in the fleet (fleetSvc.py 334), and calls its fleet's writes on it.
 */
const SERVICES_BOUND_ACROSS_TRANSITIONS = new Set(["fleetObjectHandler"]);

/**
 * The objects a dock, an undock and a stargate jump let go of on Tranquility: the ship's and the ballpark's, bound to
 * the place left, and no other. Across the recordings (Missions/Done/Combat/L1 For the Honor of Rouvenor.txt,
 * AvengeAFallenComradeLevel1.txt, Cargo Delivery.txt, Interstellar Railroad (1 of 4).txt, Archive/Autopilot thru a few
 * systems.txt) the disconnects at those name the ship service's object bound to the station at an undock (its
 * MachoBindObject((stationID, 15), 'Undock')), and at a dock or a jump the ballpark's object (beyonce) and the ship
 * service's bound to the system; the entity, invbroker, crimewatch and dogmaIM objects bound to those places stay
 * bound, as the agents', the skills', the corporation's and the fleet's do. The client lets its own location monikers
 * go at the session change itself (invCache.py ProcessSessionChange, 143 to 171: InvalidateCache on a station, a
 * structure or a system change).
 */
const SERVICES_LET_GO_AT_A_MOVE = new Set(["beyonce", "ship"]);

function collectSessionBoundObjectIDs(session, onlyServices = null) {
  const objectIDs = [];
  const seen = new Set();
  const keptBound = new Set();
  // Where only some services' objects go, the others' are kept, whatever slot names them (current, last).
  const letGo = new Set();
  if (session && session._boundObjectIDs && typeof session._boundObjectIDs === "object") {
    for (const [serviceName, value] of Object.entries(session._boundObjectIDs)) {
      if (typeof value !== "string") {
        continue;
      }
      if (SERVICES_BOUND_ACROSS_TRANSITIONS.has(serviceName) || (onlyServices && !onlyServices.has(serviceName))) {
        keptBound.add(value.trim());
      } else if (onlyServices) {
        letGo.add(value.trim());
      }
    }
  }
  if (onlyServices && session && session._boundObjectState && typeof session._boundObjectState === "object") {
    for (const [serviceName, state] of Object.entries(session._boundObjectState)) {
      const objectID = state && typeof state.objectID === "string" ? state.objectID.trim() : "";
      if (objectID && onlyServices.has(serviceName)) {
        letGo.add(objectID);
      } else if (objectID) {
        keptBound.add(objectID);
      }
    }
  }
  const addObjectID = (value) => {
    const objectID = typeof value === "string" ? value.trim() : "";
    if (!objectID || seen.has(objectID) || (keptBound.has(objectID) && !letGo.has(objectID)) || (onlyServices && !letGo.has(objectID))) {
      return;
    }
    seen.add(objectID);
    objectIDs.push(objectID);
  };

  if (session && session._boundObjectIDs && typeof session._boundObjectIDs === "object") {
    for (const value of Object.values(session._boundObjectIDs)) {
      addObjectID(value);
    }
  }
  if (session && session._boundObjectState && typeof session._boundObjectState === "object") {
    for (const [serviceName, state] of Object.entries(session._boundObjectState)) {
      if (!SERVICES_BOUND_ACROSS_TRANSITIONS.has(serviceName) && (!onlyServices || onlyServices.has(serviceName))) {
        addObjectID(state && state.objectID);
      }
    }
  }
  if (session) {
    addObjectID(session.currentBoundObjectID);
    addObjectID(session.lastBoundObjectID);
  }

  return objectIDs;
}

/**
 * An object a move let go, no longer named by the session, so the next move does not let it go again: Tranquility lets
 * each go once (Missions/Done/Combat/L1 For the Honor of Rouvenor.txt: the ship service's object bound to the station,
 * N=2296776:31503, let go at the undock and not at the dock after it, whose disconnect names the ballpark's alone).
 * A bind after it names a fresh one. The call under way keeps its currentBoundObjectID, which the dispatcher puts back
 * as it was when the call ends.
 */
function forgetLetGoObject(session, objectID) {
  const boundObjectIDs = session._boundObjectIDs;
  if (boundObjectIDs && typeof boundObjectIDs === "object") {
    for (const [serviceName, value] of Object.entries(boundObjectIDs)) {
      if (typeof value === "string" && value.trim() === objectID) {
        delete boundObjectIDs[serviceName];
      }
    }
  }
  const boundObjectState = session._boundObjectState;
  if (boundObjectState && typeof boundObjectState === "object") {
    for (const [serviceName, state] of Object.entries(boundObjectState)) {
      if (state && typeof state.objectID === "string" && state.objectID.trim() === objectID) {
        delete boundObjectState[serviceName];
      }
    }
  }
  if (typeof session.lastBoundObjectID === "string" && session.lastBoundObjectID.trim() === objectID) {
    session.lastBoundObjectID = null;
  }
}

function sendMachoObjectDisconnects(session, onlyServices = null) {
  if (!session || typeof session.sendNotification !== "function") {
    return 0;
  }

  const clientID = Number(session.clientID || session.clientid || 0);
  if (!Number.isFinite(clientID) || clientID <= 0) {
    return 0;
  }

  let sentCount = 0;
  for (const objectID of collectSessionBoundObjectIDs(session, onlyServices)) {
    session.sendNotification("OnMachoObjectDisconnect", "+clientID", [
      objectID,
      clientID,
      null,
    ]);
    // A move's alone: an ejection lets go of every object as before.
    if (onlyServices) {
      forgetLetGoObject(session, objectID);
    }
    sentCount += 1;
  }
  return sentCount;
}

// The cargo inspectContrabandForTransition would act on, read without rolling,
// fining or removing anything. Null when it would find nothing.
function findContrabandWarningForTransition(session, shipID, solarSystemID) {
  if (!session || !session.characterID || !shipID || !solarSystemID) {
    return null;
  }
  const { previewCharacterContraband } = getContrabandInspectionRuntimeModule();
  const { authority, contraband } = previewCharacterContraband(
    session.characterID,
    shipID,
    solarSystemID,
  );
  return authority && contraband.length > 0 ? { authority, contraband } : null;
}

function inspectContrabandForTransition(session, shipID, solarSystemID, reason) {
  if (!session || !session.characterID || !shipID || !solarSystemID) {
    return null;
  }
  const { inspectCharacterContraband } = getContrabandInspectionRuntimeModule();
  const result = inspectCharacterContraband(
    session.characterID,
    shipID,
    solarSystemID,
    { reason, deferPenalties: true },
  );
  if (!result || !result.success) {
    log.warn(
      `[SpaceTransition] Contraband inspection failed reason=${reason} char=${session.characterID} ship=${shipID} system=${solarSystemID}: ${(result && result.errorMsg) || "UNKNOWN_ERROR"}`,
    );
    return null;
  }

  const penalties = result.data && result.data.penalties;
  if (penalties && Array.isArray(penalties.removedChanges)) {
    syncInventoryChangesToSession(session, penalties.removedChanges, {
      emitCfgLocation: true,
    });
  }
  return result.data || null;
}

function finalizeBoardedCapsuleConsumption(
  scene,
  session,
  expectedGeneration,
  capsuleEntity,
) {
  if (
    !scene ||
    !session ||
    !expectedGeneration ||
    session._space !== expectedGeneration ||
    !capsuleEntity ||
    capsuleEntity.kind !== "ship"
  ) {
    return {
      success: false,
      errorMsg: "CAPSULE_REMOVAL_DELIVERY_FAILED",
    };
  }
  // The capsule leaves the park now; every Observer of its Grid bubble, the
  // boarding pilot included, gets its RemoveBalls at the next bubble update.
  const removeEntityResult = scene.removeDynamicEntity(capsuleEntity.itemID, {
    allowSessionOwned: true,
  });
  if (!removeEntityResult.success) {
    return removeEntityResult;
  }

  const removeItemResult = removeInventoryItem(capsuleEntity.itemID, {
    removeContents: true,
  });
  if (!removeItemResult.success) {
    return removeItemResult;
  }

  return {
    success: true,
    data: {
      entityID: capsuleEntity.itemID,
      changes:
        removeItemResult.data && Array.isArray(removeItemResult.data.changes)
          ? removeItemResult.data.changes
          : [],
    },
  };
}

function buildBoundResult(session) {
  if (!session) {
    return null;
  }

  const preferredBoundId =
    session.currentBoundObjectID ||
    (session._boundObjectIDs && (session._boundObjectIDs.ship || session._boundObjectIDs.beyonce)) ||
    session.lastBoundObjectID ||
    null;
  if (!preferredBoundId) {
    return null;
  }

  const readyAtMs = Date.now() + SESSION_CHANGE_COOLDOWN_MS;
  const readyAtFileTime =
    BigInt(Math.trunc(readyAtMs)) * FILETIME_TICKS_PER_MS + FILETIME_EPOCH_OFFSET;
  if (typeof spaceRuntime.recordSessionJumpTimingTrace === "function") {
    spaceRuntime.recordSessionJumpTimingTrace(session, "build-bound-result", {
      preferredBoundId,
      readyAtMs,
      readyAtFileTime: readyAtFileTime.toString(),
      cooldownMs: SESSION_CHANGE_COOLDOWN_MS,
    });
  }
  return [preferredBoundId, readyAtFileTime];
}

function buildLocationIdentityPatch(record, solarSystemID, extra = {}) {
  const targetSolarSystemID = Number(solarSystemID || 0) || Number(record.solarSystemID || 30000142) || 30000142;
  const system = worldData.getSolarSystemByID(targetSolarSystemID);

  return {
    ...record,
    ...extra,
    solarSystemID: targetSolarSystemID,
    constellationID:
      Number((system && system.constellationID) || record.constellationID || 0) ||
      20000020,
    regionID:
      Number((system && system.regionID) || record.regionID || 0) ||
      10000002,
    worldSpaceID: 0,
  };
}

function resolveDockableLocation(locationID) {
  const numericLocationID = Number(locationID || 0) || 0;
  if (!numericLocationID) {
    return null;
  }

  const station = worldData.getStationByID(numericLocationID);
  if (station) {
    return {
      kind: "station",
      record: station,
      locationID: station.stationID,
      solarSystemID: station.solarSystemID,
      label: station.stationName || `Station ${station.stationID}`,
    };
  }

  const structure = worldData.getStructureByID(numericLocationID);
  if (structure) {
    return {
      kind: "structure",
      record: structure,
      locationID: structure.structureID,
      solarSystemID: structure.solarSystemID,
      label: structure.itemName || structure.name || `Structure ${structure.structureID}`,
    };
  }

  return null;
}

function beginTransition(session, kind, targetID = 0, options = {}) {
  if (!session) {
    return false;
  }

  const now = Date.now();
  const activeTransition = session._transitionState || null;
  // `_transitionState` is an in-flight mutual-exclusion lock, not the retail
  // next-session-change cooldown. Never replace an active transition: delayed
  // handoffs (notably a TiDi-scaled stargate jump) still need their original
  // state in order to complete safely. The state is cleared by endTransition,
  // so a completed board or other selective sequential transition remains
  // immediately eligible here; its separately advertised cooldown is client
  // session-timer policy rather than an overlapping-operation guard.
  if (activeTransition) {
    return false;
  }

  // An accepted gate handoff may still need its character checkpoint. Settle
  // that intent before another location-changing action can replace the ship
  // location used to recover it. Never inspect it during an in-flight handoff.
  if (options[SHIP_DESTRUCTION_ABYSSAL_TRANSITION_BYPASS] !== true &&
      peekCharacterRecord(session.characterID)?.careerPendingGateArrival) {
    const arrival = require("../services/career/careerExplorationSources")
      .reconcileGateArrival(session.characterID);
    if (!arrival?.success) {
      log.warn(`[SpaceTransition] Pending stargate arrival prevents ${kind}: ${arrival?.errorMsg}`);
      return false;
    }
  }

  session._transitionState = {
    kind,
    transitionID: String(transitionIDProvider()),
    targetID: Number(targetID || 0) || 0,
    startedAt: now,
  };
  return true;
}

function endTransition(session, kind) {
  if (
    session &&
    session._transitionState &&
    session._transitionState.kind === kind
  ) {
    session._transitionState = null;
  }
}

// The handoff deadline of a stargate jump: no earlier than 4 s after the
// command, and 3 s after the pilot's client has the JumpOut effect. The effect
// leaves with the source scene's Destiny tick that carries its stamp, and when
// that tick runs is the scene's Destiny tick driver's to say (ticks fall on
// whole seconds since the scene's first tick, not of sim time).
// `sourceTick`, read off the source scene when the jump out was observed:
// { nextDestinyStamp, jumpOutTickSimTimeMs (the driver's simTimeOfTick of the
// JumpOut's stamp, or null before the scene's first tick), simTimeMs (the
// scene's sim time then) }.
function buildStargateJumpHandoffDeadline(
  commandSessionSimTimeMs,
  jumpOutStamp,
  jumpOutObservedSessionSimTimeMs = commandSessionSimTimeMs,
  sourceTick = {},
) {
  const commandSimTimeMs = Number(commandSessionSimTimeMs);
  const jumpOutObservedSimTimeMs = Number(jumpOutObservedSessionSimTimeMs);
  const nextStamp = Number(sourceTick && sourceTick.nextDestinyStamp);
  if (
    !Number.isFinite(commandSimTimeMs) ||
    !Number.isFinite(jumpOutObservedSimTimeMs) ||
    !Number.isInteger(jumpOutStamp) ||
    !Number.isInteger(nextStamp)
  ) {
    return null;
  }

  // How many Destiny ticks after the next one the JumpOut leaves with.
  const ticksAhead = jumpOutStamp - nextStamp;
  if (ticksAhead > PILOT_WARP_ACTIVATION_DELAY_DESTINY_TICKS) {
    return null;
  }
  const simTimeMs = Number(sourceTick.simTimeMs);
  const tickSimTimeMs = sourceTick.jumpOutTickSimTimeMs === null ||
    sourceTick.jumpOutTickSimTimeMs === undefined
    ? null
    : Number(sourceTick.jumpOutTickSimTimeMs);
  let jumpOutBoundaryDeltaMs = 0;
  if (ticksAhead >= 0) {
    jumpOutBoundaryDeltaMs = Number.isFinite(tickSimTimeMs) && Number.isFinite(simTimeMs)
      ? Math.max(0, tickSimTimeMs - simTimeMs)
      // No tick has run yet: the first is Evolve only and due now, so the
      // JumpOut's tick is `ticksAhead` ticks after it.
      : ticksAhead * DESTINY_TICK_INTERVAL_MS;
  }

  const commandDeadlineSimTimeMs =
    commandSimTimeMs + STARGATE_JUMP_COMMAND_HANDOFF_DELAY_MS;
  const jumpOutBoundarySimTimeMs =
    jumpOutObservedSimTimeMs + jumpOutBoundaryDeltaMs;
  const jumpOutDeadlineSimTimeMs =
    jumpOutBoundarySimTimeMs + STARGATE_JUMP_POST_FX_HANDOFF_DELAY_MS;
  const deadlineSimTimeMs = Math.max(
    commandDeadlineSimTimeMs,
    jumpOutDeadlineSimTimeMs,
  );

  return {
    commandSimTimeMs,
    jumpOutObservedSimTimeMs,
    currentStamp: nextStamp,
    jumpOutStamp,
    jumpOutBoundaryDeltaMs,
    jumpOutBoundarySimTimeMs,
    commandDeadlineSimTimeMs,
    jumpOutDeadlineSimTimeMs,
    deadlineSimTimeMs,
  };
}

function getStargateJumpHandoffWallclockDelayMs(
  remainingSimulationMs,
  timeDilation,
) {
  const remainingMs = Math.max(0, toFiniteNumber(remainingSimulationMs, 0));
  const tidiFactor = Math.min(
    1,
    Math.max(0.1, toFiniteNumber(timeDilation, 1)),
  );
  return Math.max(
    1,
    Math.min(
      STARGATE_JUMP_HANDOFF_RECHECK_MAX_DELAY_MS,
      Math.ceil(remainingMs / tidiFactor),
    ),
  );
}

function cloneVector(source = null, fallback = { x: 0, y: 0, z: 0 }) {
  const vectorSource =
    source && typeof source === "object"
      ? source
      : null;
  return {
    x: toFiniteNumber(vectorSource ? vectorSource.x : undefined, fallback.x),
    y: toFiniteNumber(vectorSource ? vectorSource.y : undefined, fallback.y),
    z: toFiniteNumber(vectorSource ? vectorSource.z : undefined, fallback.z),
  };
}

function addVectors(left, right) {
  return {
    x: left.x + right.x,
    y: left.y + right.y,
    z: left.z + right.z,
  };
}

function subtractVectors(left, right) {
  return {
    x: left.x - right.x,
    y: left.y - right.y,
    z: left.z - right.z,
  };
}

function scaleVector(vector, scalar) {
  return {
    x: vector.x * scalar,
    y: vector.y * scalar,
    z: vector.z * scalar,
  };
}

function normalizeVector(vector, fallback = { x: 1, y: 0, z: 0 }) {
  const length = Math.sqrt((vector.x ** 2) + (vector.y ** 2) + (vector.z ** 2));
  if (!Number.isFinite(length) || length <= 0) {
    return cloneVector(fallback);
  }

  return scaleVector(vector, 1 / length);
}

function crossProduct(left, right) {
  return {
    x: (left.y * right.z) - (left.z * right.y),
    y: (left.z * right.x) - (left.x * right.z),
    z: (left.x * right.y) - (left.y * right.x),
  };
}

function distance(left, right) {
  const delta = subtractVectors(left, right);
  return Math.sqrt((delta.x ** 2) + (delta.y ** 2) + (delta.z ** 2));
}

function magnitude(vector) {
  return Math.sqrt((vector.x ** 2) + (vector.y ** 2) + (vector.z ** 2));
}

function buildSharedWorldPosition(systemPosition, localPosition) {
  return {
    x: toFiniteNumber(systemPosition && systemPosition.x, 0) -
      toFiniteNumber(localPosition && localPosition.x, 0),
    y: toFiniteNumber(systemPosition && systemPosition.y, 0) +
      toFiniteNumber(localPosition && localPosition.y, 0),
    z: toFiniteNumber(systemPosition && systemPosition.z, 0) +
      toFiniteNumber(localPosition && localPosition.z, 0),
  };
}

function getDirectionFromDunRotation(dunRotation) {
  if (!Array.isArray(dunRotation) || dunRotation.length < 2) {
    return null;
  }

  const yaw = toFiniteNumber(dunRotation[0], 0) * (Math.PI / 180);
  const pitch = toFiniteNumber(dunRotation[1], 0) * (Math.PI / 180);
  return normalizeVector({
    x: Math.sin(yaw) * Math.cos(pitch),
    y: -Math.sin(pitch),
    z: Math.cos(yaw) * Math.cos(pitch),
  });
}

function getDerivedStargateForwardDirection(stargate) {
  const sourceSystem = worldData.getSolarSystemByID(stargate && stargate.solarSystemID);
  const destinationGate = worldData.getStargateByID(stargate && stargate.destinationID);
  const destinationSystemID =
    toInt(stargate && stargate.destinationSolarSystemID, 0) ||
    toInt(destinationGate && destinationGate.solarSystemID, 0);
  const destinationSystem = worldData.getSolarSystemByID(
    destinationSystemID,
  );
  if (!sourceSystem || !destinationSystem) {
    return null;
  }

  return getStargateSystemForwardDirection(stargate, sourceSystem, destinationSystem);
}

function getResolvedStargateForwardDirection(stargate) {
  return (
    getDirectionFromDunRotation(stargate && stargate.dunRotation) ||
    getDerivedStargateForwardDirection(stargate) ||
    normalizeVector(cloneVector(stargate && stargate.position), { x: 1, y: 0, z: 0 })
  );
}

function resolveShipRadiusMeters(ship) {
  const directRadius = Math.max(
    0,
    toFiniteNumber(ship && (ship.radius ?? ship.spaceRadius), 0),
  );
  if (directRadius > 0) {
    return directRadius;
  }

  const shipTypeID = Number(ship && (ship.shipTypeID || ship.typeID)) || 0;
  if (shipTypeID <= 0) {
    return 0;
  }

  const movement = worldData.getMovementAttributesForType(shipTypeID);
  return Math.max(0, toFiniteNumber(movement && movement.radius, 0));
}

// Any unit vector that is not parallel to `forward`, so the cross products
// below cannot collapse to zero.
function buildPerpendicularBasis(forward) {
  const reference = Math.abs(forward.x) < 0.9
    ? { x: 1, y: 0, z: 0 }
    : { x: 0, y: 1, z: 0 };
  const right = normalizeVector(crossProduct(reference, forward), { x: 0, y: 1, z: 0 });
  return {
    right,
    up: normalizeVector(crossProduct(forward, right), { x: 0, y: 0, z: 1 }),
  };
}

// Uniform over the spherical cap of half-angle `coneRadians` around `forward`,
// rather than over the angle itself, which would crowd arrivals onto the axis.
function sampleDirectionInCone(forward, coneRadians, random) {
  const cosLimit = Math.cos(coneRadians);
  const cosTheta = 1 - (random() * (1 - cosLimit));
  const sinTheta = Math.sqrt(Math.max(0, 1 - (cosTheta ** 2)));
  const phi = random() * 2 * Math.PI;
  const { right, up } = buildPerpendicularBasis(forward);

  return normalizeVector(
    addVectors(
      scaleVector(forward, cosTheta),
      addVectors(
        scaleVector(right, sinTheta * Math.cos(phi)),
        scaleVector(up, sinTheta * Math.sin(phi)),
      ),
    ),
    forward,
  );
}

function buildGateSpawnState(stargate, ship = null, options = {}) {
  const random = typeof options.random === "function" ? options.random : Math.random;
  const forward = getResolvedStargateForwardDirection(stargate);
  const direction = sampleDirectionInCone(
    forward,
    STARGATE_JUMP_IN_SCATTER_CONE_RADIANS,
    random,
  );
  const offset =
    resolveStargatePhysicalRadius(stargate) +
    resolveShipRadiusMeters(ship) +
    STARGATE_JUMP_IN_SURFACE_CLEARANCE_METERS;

  return {
    direction,
    position: addVectors(
      cloneVector(stargate.position),
      scaleVector(direction, offset),
    ),
  };
}

function buildOffsetSpawnState(anchor, options = {}) {
  const fallbackDirection = cloneVector(
    options.fallbackDirection,
    { x: 1, y: 0, z: 0 },
  );
  const anchorPosition = cloneVector(anchor && anchor.position);
  const direction = normalizeVector(
    magnitude(anchorPosition) > 0 ? anchorPosition : fallbackDirection,
    fallbackDirection,
  );
  const minOffset = Math.max(toFiniteNumber(options.minOffset, 0), 0);
  const clearance = Math.max(toFiniteNumber(options.clearance, 0), 0);
  const offset = Math.max(toFiniteNumber(anchor && anchor.radius, 0) + clearance, minOffset);
  const position = addVectors(anchorPosition, scaleVector(direction, offset));

  return {
    direction,
    position,
  };
}

function buildSolarSystemSpawnState(solarSystemID) {
  const system = worldData.getSolarSystemByID(solarSystemID);
  if (!system) {
    return null;
  }

  const stargates = worldData.getStargatesForSystem(solarSystemID);
  if (stargates.length > 0) {
    const stargate = stargates[0];
    return {
      anchorType: "stargate",
      anchorID: stargate.itemID,
      anchorName: stargate.itemName || `Stargate ${stargate.itemID}`,
      ...buildOffsetSpawnState(stargate, {
        minOffset: Math.max(resolveStargatePhysicalRadius(stargate) * 0.4, 5000),
      }),
    };
  }

  const stations = worldData.getStationsForSystem(solarSystemID);
  if (stations.length > 0) {
    const station = stations[0];
    return {
      anchorType: "station",
      anchorID: station.stationID,
      anchorName: station.stationName || `Station ${station.stationID}`,
      ...buildOffsetSpawnState(station, {
        minOffset: Math.max((station.radius || 15000) * 0.4, 5000),
        clearance: 5000,
      }),
    };
  }

  const celestials = worldData.getCelestialsForSystem(solarSystemID);
  const celestial =
    celestials.find((entry) => entry.kind !== "sun" && entry.groupID !== 6) ||
    celestials.find((entry) => entry.kind === "sun" || entry.groupID === 6) ||
    celestials[0] ||
    null;
  if (celestial) {
    return {
      anchorType: celestial.kind || "celestial",
      anchorID: celestial.itemID,
      anchorName: celestial.itemName || `Celestial ${celestial.itemID}`,
      ...buildOffsetSpawnState(celestial, {
        minOffset: 100000,
        clearance: celestial.kind === "sun" || celestial.groupID === 6
          ? 250000
          : 25000,
      }),
    };
  }

  return {
    anchorType: "fallback",
    anchorID: system.solarSystemID,
    anchorName: system.solarSystemName || `System ${system.solarSystemID}`,
    direction: { x: 1, y: 0, z: 0 },
    position: { x: 1000000, y: 0, z: 0 },
  };
}

function broadcastOnCharNowInStation(session, stationID) {
  broadcastStationGuestJoined(session, stationID);
}

function broadcastOnCharNoLongerInStation(session, stationID) {
  broadcastStationGuestLeft(session, stationID);
}

function broadcastOnCharacterEnteredStructure(session, structureID) {
  broadcastStructureGuestJoined(session, structureID);
}

function broadcastOnCharacterLeftStructure(session, structureID) {
  broadcastStructureGuestLeft(session, structureID);
}

function buildSolarSessionChangeOptions(session, solarSystemID) {
  const sourceNodeID =
    Number(session && session._machoNodeID) ||
    PROXY_NODE_ID;
  if (session && typeof session === "object" && sourceNodeID > 0) {
    session._machoNodeID = sourceNodeID;
  }
  return {
    sourceNodeID,
    nodesOfInterest: [sourceNodeID],
  };
}

function queuePendingSessionEffects(session, options = {}) {
  if (!session || typeof session !== "object") {
    return;
  }

  if (
    options.forceInitialBallpark ||
    options.awaitBeyonceBoundBallpark
  ) {
    session._pendingCommandInitialBallpark = {
      force: options.forceInitialBallpark === true,
      awaitBeyonceBound: options.awaitBeyonceBoundBallpark === true,
    };
  }

  if (Object.prototype.hasOwnProperty.call(options, "previousLocalChannelID")) {
    session._pendingLocalChannelSync = {
      previousChannelID: Number(options.previousLocalChannelID || 0) || 0,
    };
  }

}

function getSurfaceDistanceBetweenEntities(entity, targetEntity) {
  const centerDistance = distance(entity.position, targetEntity.position);
  return Math.max(
    0,
    centerDistance -
      Math.max(0, toFiniteNumber(entity && entity.radius, 0)) -
      Math.max(0, toFiniteNumber(targetEntity && targetEntity.radius, 0)),
  );
}

function buildStoppedSpaceStateFromEntity(entity) {
  const position = cloneVector(entity && entity.position);
  return {
    ...buildPlayerEgoScopeMetadata(entity),
    position,
    direction: normalizeVector(
      cloneVector(entity && entity.direction, { x: 1, y: 0, z: 0 }),
      { x: 1, y: 0, z: 0 },
    ),
    velocity: { x: 0, y: 0, z: 0 },
    speedFraction: 0,
    mode: "STOP",
    targetPoint: position,
  };
}

function buildCloneVatArrivalSpaceState(targetShipItem, targetEntity = null) {
  const sourceState =
    targetEntity && targetEntity.position
      ? {
          position: targetEntity.position,
          direction: targetEntity.direction,
          radius: targetEntity.radius,
        }
      : (targetShipItem && targetShipItem.spaceState) || {};
  const targetPosition = cloneVector(sourceState.position);
  const targetDirection = normalizeVector(
    cloneVector(sourceState.direction, { x: 1, y: 0, z: 0 }),
    { x: 1, y: 0, z: 0 },
  );
  const offsetMeters = Math.max(
    2500,
    toFiniteNumber(
      sourceState.radius,
      toFiniteNumber(targetShipItem && targetShipItem.spaceRadius, 0),
    ) + 1500,
  );
  const position = addVectors(
    targetPosition,
    scaleVector(targetDirection, -offsetMeters),
  );
  return {
    position,
    direction: targetDirection,
    velocity: { x: 0, y: 0, z: 0 },
    speedFraction: 0,
    mode: "STOP",
    targetPoint: position,
  };
}

function captureSpaceSessionState(session) {
  return {
    beyonceBound: Boolean(session && session._space && session._space.beyonceBound),
    initialStateSent: Boolean(
      session && session._space && session._space.initialStateSent,
    ),
    initialBallparkVisualsSent: Boolean(
      session && session._space && session._space.initialBallparkVisualsSent,
    ),
    initialBallparkClockSynced: Boolean(
      session && session._space && session._space.initialBallparkClockSynced,
    ),
  };
}

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

const SHIP_DESTRUCTION_ABYSSAL_TRANSITION_BYPASS = Symbol(
  "shipDestructionAbyssalTransitionBypass",
);

function resolveActiveAbyssalTransitionRestriction(session, action) {
  if (!session || typeof session !== "object") {
    return null;
  }

  const characterID = toInt(
    session.characterID || session.charid || session.characterId,
    0,
  );
  const shipID = toInt(
    session._space && session._space.shipID,
    toInt(session.shipID || session.shipid || session.activeShipID, 0),
  );

  // This lookup is intentionally server-owned and lazy. The transition module
  // is itself used while the Abyssal manager is bootstrapping, and accepting an
  // RPC option or a session boolean here would turn client input into a bypass.
  let abyssalMgrService = null;
  try {
    abyssalMgrService = require("../abyssal").transitionIntegration;
  } catch (error) {
    log.error(
      `[SpaceTransition] Abyssal transition authority unavailable ` +
        `char=${characterID} ship=${shipID} action=${String(action || "unknown")} ` +
        `reason=${error && error.message || "UNKNOWN"}`,
    );
    return isAbyssalHostLocationID(
      session._space && session._space.systemID ||
        session.solarsystemid2 ||
        session.solarsystemid,
    )
      ? {
          blocked: true,
          action: String(action || "unknown"),
          characterID,
          shipID,
          instanceID: 0,
          reason: "ABYSSAL_AUTHORITY_UNAVAILABLE",
        }
      : null;
  }

  const activeRun =
    characterID > 0 &&
    typeof abyssalMgrService.getActiveAbyssalRunForCharacterID === "function"
      ? abyssalMgrService.getActiveAbyssalRunForCharacterID(characterID)
      : null;
  const shipRun =
    !activeRun &&
    shipID > 0 &&
    typeof abyssalMgrService.getActiveAbyssalRunForShipID === "function"
      ? abyssalMgrService.getActiveAbyssalRunForShipID(shipID)
      : null;
  const pocketState = activeRun || shipRun;
  const sceneKind = String(
    session._space && session._space.sceneKind || "",
  ).trim();
  const sceneKey = String(
    session._space && session._space.sceneKey || session.spaceSceneKey || "",
  ).trim();
  const sceneInstanceID = toInt(
    session._space && session._space.instanceID,
    toInt(session.spaceInstanceID, 0),
  );
  const hasAbyssalSceneAuthority = Boolean(
    sceneKind === "abyssal" ||
    /^abyssal-run:\d+$/.test(sceneKey) ||
    isAbyssalHostLocationID(
      session._space && session._space.systemID ||
        session.solarsystemid2 ||
        session.solarsystemid,
    )
  );
  if (!pocketState && !hasAbyssalSceneAuthority) {
    return null;
  }

  return {
    blocked: true,
    action: String(action || "unknown"),
    characterID,
    shipID,
    instanceID: pocketState
      ? toInt(pocketState.instanceID, 0)
      : sceneInstanceID,
    reason: pocketState ? "ABYSSAL_ACTIVE_RUN" : "ABYSSAL_SCENE_AUTHORITY",
  };
}

function buildShipDeathTransitionBlockedResult(session) {
  const shipID = session?._space?.shipID || session?.shipID;
  return shipID && (require("../services/ship/breacherPodDeathRuntime").isShipDeathPending(shipID) ||
    require("../services/ship/airDeathRestrictions").shipPending(session.characterID, shipID))
    ? { success: false, errorMsg: "SHIP_DESTRUCTION_IN_PROGRESS" } : null;
}

function buildActiveAbyssalTransitionBlockedResult(session, action) {
  const restriction = resolveActiveAbyssalTransitionRestriction(session, action);
  if (!restriction) {
    return null;
  }
  return {
    success: false,
    errorMsg: "ABYSSAL_TRANSITION_FORBIDDEN",
    data: restriction,
  };
}

// The client's godma asks GetAllInfo for the new ship's state after an eject
// or a board in space; its first call gets the shipState
// (services/dogma/dogmaService/itemInfo.js _takeInSpaceShipChange).
function markInSpaceShipChange(session, shipID) {
  if (session && session._space) {
    session._space.inSpaceShipChangeShipID = Number(shipID);
  }
}

function repairSameSceneSessionViewState(session) {
  if (!session || !session._space) {
    return false;
  }

  // Same-scene ship swaps happen inside an already-live ballpark. If the local
  // bootstrap flags have drifted false, falling back to a fresh
  // ensureInitialBallpark() rebuild replays stale hull state and forces the
  // client through an owner SetState reset. Repair the bookkeeping instead.
  session._space.initialStateSent = true;
  session._space.initialBallparkVisualsSent = true;
  session._space.initialBallparkClockSynced = true;
  return true;
}

function flushSameSceneShipSwapNotificationPlan(session, plan, options = {}) {
  const sessionChangeOptions = {
    // Normal same-scene ship swaps keep the live session id and use TQ's empty
    // nodes-of-interest routing for the shipid handoff. Combat destruction can
    // opt into the older remote-style session id separately.
    nodesOfInterest: [],
  };
  if (Object.prototype.hasOwnProperty.call(options, "sessionId")) {
    sessionChangeOptions.sessionId = options.sessionId;
  }
  return flushCharacterSessionNotificationPlan(session, plan, {
    sessionChangeOptions,
  });
}

function retargetCharacterSessionNotificationPlanShip(plan, oldShipID, shipID) {
  if (!plan || !plan.sessionChanges) {
    return false;
  }

  const normalizeShipID = (value) => {
    if (value === undefined || value === null) {
      return null;
    }
    const numericValue = Number(value) || 0;
    return numericValue > 0 ? numericValue : null;
  };

  const normalizedShipID = normalizeShipID(shipID);
  const previousShipID =
    normalizeShipID(oldShipID) ?? normalizeShipID(plan.oldShipID);
  if (normalizedShipID === null || previousShipID === null) {
    return false;
  }

  plan.newShipID = normalizedShipID;
  plan.sessionChanges.shipid = [previousShipID, normalizedShipID];
  if (plan.fittingBootstrap && Number(normalizedShipID) > 0) {
    plan.fittingBootstrap.shipID = Number(normalizedShipID);
  }
  return true;
}

function resolveReusableCapsuleForCharacter(
  characterID,
  excludedShipID,
  currentSolarSystemID,
  preferredStationID,
) {
  const excludedItemID = Number(excludedShipID || 0) || 0;
  const ships = getCharacterShips(characterID).filter(
    (shipItem) =>
      isCapsuleTypeID(shipItem && shipItem.typeID) &&
      Number(shipItem && shipItem.itemID) !== excludedItemID,
  );

  const currentSystemCapsule = ships.find(
    (shipItem) =>
      Number(shipItem.locationID) === Number(currentSolarSystemID || 0) &&
      Number(shipItem.flagID) === 0,
  );
  if (currentSystemCapsule) {
    return {
      success: true,
      created: false,
      data: currentSystemCapsule,
    };
  }

  const storedCapsule = ships.find(
    (shipItem) => Number(shipItem.flagID) === ITEM_FLAGS.HANGAR,
  );
  if (storedCapsule) {
    return {
      success: true,
      created: false,
      data: storedCapsule,
    };
  }

  const existingCapsule = ships[0] || null;
  if (existingCapsule && Number(existingCapsule.itemID) !== excludedItemID) {
    return {
      success: true,
      created: false,
      data: existingCapsule,
    };
  }

  return ensureCapsuleForCharacter(characterID, preferredStationID);
}

function completeStargateJump(
  session,
  sourceGate,
  destinationGate,
  activeShip,
) {
  if (
    !session ||
    !session.characterID ||
    !sourceGate ||
    !destinationGate ||
    !activeShip
  ) {
    endTransition(session, "stargate-jump");
    return {
      success: false,
      errorMsg: "INVALID_STARGATE_JUMP_STATE",
    };
  }

  if (
    !session._transitionState ||
    session._transitionState.kind !== "stargate-jump"
  ) {
    return {
      success: false,
      errorMsg: "STARGATE_JUMP_CANCELLED",
    };
  }

  const gateCareerSource = require("../services/career/careerExplorationSources");
  const priorArrival = gateCareerSource.reconcileGateArrival(session.characterID);
  if (!priorArrival?.success) {
    endTransition(session, "stargate-jump");
    return priorArrival;
  }
  const preparedArrival = gateCareerSource.prepareGateArrival(session.characterID, {
    transitionID: session._transitionState.transitionID,
    shipID: activeShip.itemID,
    sourceSystemID: sourceGate.solarSystemID,
    destinationSystemID: destinationGate.solarSystemID,
  });
  if (!preparedArrival?.success) {
    endTransition(session, "stargate-jump");
    return preparedArrival;
  }

  const spawnState = buildGateSpawnState(destinationGate, activeShip);
  const sourceSimTimeMs =
    session && session._space
      ? spaceRuntime.getSimulationTimeMsForSession(session, null)
      : null;
  const sourceTimeDilation =
    session && session._space
      ? spaceRuntime.getSolarSystemTimeDilation(session._space.systemID)
      : null;
  const sourceClockCapturedAtWallclockMs = Date.now();

  deactivateActiveModulesForSpaceTransition(session, "stargate-jump");
  sendMachoObjectDisconnects(session, SERVICES_LET_GO_AT_A_MOVE);
  spaceRuntime.detachSession(session, {
    broadcast: true,
    lifecycleReason: "stargate-jump",
  });

  const move = preparedArrival.skipped ? moveShipToSpace : moveShipToSpaceIdempotent;
  let moveResult = move(activeShip.itemID, destinationGate.solarSystemID, {
    position: spawnState.position,
    direction: spawnState.direction,
    velocity: { x: 0, y: 0, z: 0 },
    speedFraction: 0,
    mode: "STOP",
    targetPoint: spawnState.position,
  }, preparedArrival.identity);
  if (!moveResult.success && moveResult.mutationResult?.success) {
    // The inventory command may have committed before its acknowledgement was
    // lost. Preserve the exact native move result; reconciliation reads its
    // durable receipt before deciding whether arrival can be presented.
    gateCareerSource.reconcileGateArrival(session.characterID);
    // Successful reconciliation may only be holding an in-flight intent, or
    // may already have cleared it. Only the exact permanent inventory receipt
    // proves that this ambiguous movement was actually accepted.
    const proof = getShipSpaceMoveReceipt(preparedArrival.identity);
    if (proof?.success && proof.found && proof.durable === true) moveResult = moveResult.mutationResult;
  }
  if (!moveResult.success) {
    endTransition(session, "stargate-jump");
    return moveResult;
  }

  syncInventoryItemForSession(
    session,
    moveResult.data,
    {
      locationID: moveResult.previousData.locationID,
      flagID: moveResult.previousData.flagID,
      quantity: moveResult.previousData.quantity,
      singleton: moveResult.previousData.singleton,
      stacksize: moveResult.previousData.stacksize,
    },
    {
      emitCfgLocation: false,
    },
  );

  const arrivalCheckpoint = gateCareerSource.reconcileGateArrival(session.characterID);
  if (!arrivalCheckpoint?.success && arrivalCheckpoint?.arrived !== true) {
    endTransition(session, "stargate-jump");
    return arrivalCheckpoint;
  }
  if (!arrivalCheckpoint.success) {
    // The ship owner durably accepted arrival. Keep its prepared character
    // receipt and finish presentation; AIR queries/reconnect replay the same
    // transition instead of stranding the pilot or inventing another jump.
    log.warn(`[SpaceTransition] Accepted stargate arrival awaits career checkpoint: ${arrivalCheckpoint.errorMsg}`);
  }

  const previousLocalChannelID = Number(
    session.solarsystemid2 ||
    session.solarsystemid ||
    getDockedLocationID(session) ||
    0,
  ) || 0;

  const applyResult = applyCharacterToSession(session, session.characterID, {
    emitNotifications: false,
    logSelection: true,
    selectionEvent: false,
  });
  if (!applyResult.success) {
    endTransition(session, "stargate-jump");
    return applyResult;
  }

  spaceRuntime.attachSession(session, moveResult.data, {
    systemID: destinationGate.solarSystemID,
    beyonceBound: false,
    pendingUndockMovement: false,
    stargateJumpCloak: true,
    broadcast: true,
    emitSimClockRebase: false,
    previousSimTimeMs: sourceSimTimeMs,
    initialBallparkPreviousSimTimeMs: sourceSimTimeMs,
    initialBallparkPreviousTimeDilation: sourceTimeDilation,
    initialBallparkPreviousCapturedAtWallclockMs: sourceClockCapturedAtWallclockMs,
    deferInitialBallparkStateUntilBind: true,
    deferUniverseSiteReconcile: true,
    universeSiteReconcileReason: "stargate-jump",
  });
  const observerArrivalFxResult = spaceRuntime.emitStargateArrivalObserverFx(
    session,
    destinationGate.itemID,
    moveResult.data && moveResult.data.itemID,
  );
  if (typeof spaceRuntime.recordSessionJumpTimingTrace === "function") {
    spaceRuntime.recordSessionJumpTimingTrace(session, "stargate-jump-attached", {
      destinationSystemID: destinationGate.solarSystemID,
      shipID: moveResult.data && moveResult.data.itemID,
      spawnState,
      observerArrivalFx: observerArrivalFxResult.success
        ? observerArrivalFxResult.data
        : {
            success: false,
            errorMsg: observerArrivalFxResult.errorMsg,
          },
    });
  }
  queuePostSpaceAttachFittingHydration(session, moveResult.data && moveResult.data.itemID, {
    inventoryBootstrapPending: false,
    hydrationProfile: "stargate",
  });
  flushCharacterSessionNotificationPlan(session, applyResult.notificationPlan);
  queuePendingSessionEffects(session, {
    awaitBeyonceBoundBallpark: true,
    previousLocalChannelID,
  });
  flushPendingCommandSessionEffects(session);
  try {
    mapTelemetryState.recordSolarSystemJump(session, {
      fromSolarSystemID: sourceGate.solarSystemID,
      toSolarSystemID: destinationGate.solarSystemID,
      kind: "stargate",
      shipID: activeShip.itemID,
      sourceID: sourceGate.itemID,
      destinationID: destinationGate.itemID,
    });
  } catch (error) {
    log.warn(
      `[SpaceTransition] Failed to record map jump characterID=${session.characterID || 0} from=${sourceGate.solarSystemID} to=${destinationGate.solarSystemID}: ${error.message}`,
    );
  }

  log.info(
    `[SpaceTransition] Stargate jump ${session.characterName || session.characterID} ship=${activeShip.itemID} from=${sourceGate.itemID} to=${destinationGate.itemID}`,
  );

  // Advance the "Complete N Jumps" AIR daily goal on each successful inter-system
  // jump. Defensive so daily-goal bookkeeping can never disrupt the jump.
  try {
    require(path.join(
      __dirname,
      "../services/dailyGoals/dailyGoalsState",
    )).recordActivity(session.characterID, "space_jump", 1);
  } catch (dailyGoalError) {
    log.debug(
      `[SpaceTransition] daily-goal space_jump hook failed char=${session.characterID}: ${dailyGoalError.message}`,
    );
  }

  // Achievement travel progress is recorded only after the handoff has fully
  // succeeded, so an interrupted or denied jump can never credit a visit.
  try {
    require(path.join(
      __dirname,
      "../services/achievement/achievementRuntime",
    )).recordStargateJump(session.characterID, sourceGate, destinationGate);
  } catch (achievementError) {
    log.debug(
      `[SpaceTransition] achievement stargate hook failed char=${session.characterID}: ${achievementError.message}`,
    );
  }

  let customsInspection = null;
  try {
    customsInspection = require("../services/security/customsInspectionRuntime").registerArrival(session, {
      gateID: destinationGate.itemID,
      transitionID: session._transitionState.transitionID ||
        `${session.clientID}:${session._transitionState.startedAt}:${destinationGate.itemID}`,
    });
  } catch (error) {
    log.warn(`[SpaceTransition] Customs arrival failed: ${error.message}`);
  }
  endTransition(session, "stargate-jump");
  return {
    success: true,
    data: {
      stargate: destinationGate,
      spawnState,
      customsInspection,
      boundResult: buildBoundResult(session),
    },
  };
}

function scheduleStargateJumpHandoff(
  session,
  sourceGate,
  destinationGate,
  activeShip,
  sourceScene,
  transitionState,
  sourceSpaceGeneration,
  handoffDeadline,
) {
  const hasExpectedAuthority = () =>
    Boolean(
      session &&
      session._space === sourceSpaceGeneration &&
      session._transitionState === transitionState,
    );

  const cancelExpectedTransition = () => {
    if (session && session._transitionState === transitionState) {
      endTransition(session, "stargate-jump");
    }
  };

  const attemptHandoff = () => {
    if (!hasExpectedAuthority()) {
      return;
    }
    if (session.socket && session.socket.destroyed === true) {
      cancelExpectedTransition();
      return;
    }
    const sourceShipEntity = sourceScene.getShipEntityForSession(session);
    if (
      !sourceShipEntity ||
      Number(sourceShipEntity.itemID || 0) !== Number(activeShip.itemID || 0)
    ) {
      cancelExpectedTransition();
      return;
    }

    const currentSessionSimTimeMs = sourceScene.getCurrentSessionSimTimeMs(session);
    if (!Number.isFinite(currentSessionSimTimeMs)) {
      log.warn(
        `[SpaceTransition] Cancelling stargate jump for ${session.characterName || session.characterID}: source simulation clock is unavailable`,
      );
      cancelExpectedTransition();
      return;
    }
    const remainingSimulationMs = Math.max(
      0,
      handoffDeadline.deadlineSimTimeMs - currentSessionSimTimeMs,
    );
    if (remainingSimulationMs > 0) {
      const delayMs = getStargateJumpHandoffWallclockDelayMs(
        remainingSimulationMs,
        sourceScene.getTimeDilation(),
      );
      setTimeout(attemptHandoff, delayMs);
      return;
    }

    if (typeof spaceRuntime.recordSessionJumpTimingTrace === "function") {
      spaceRuntime.recordSessionJumpTimingTrace(
        session,
        "stargate-jump-handoff-deadline-reached",
        {
          currentSessionSimTimeMs,
          deadlineSimTimeMs: handoffDeadline.deadlineSimTimeMs,
          jumpOutStamp: handoffDeadline.jumpOutStamp,
        },
      );
    }
    const completionResult = completeStargateJump(
      session,
      sourceGate,
      destinationGate,
      activeShip,
    );
    if (!completionResult.success) {
      log.warn(
        `[SpaceTransition] Delayed stargate jump failed for ${session.characterName || session.characterID}: ${completionResult.errorMsg}`,
      );
    }
  };

  const initialSessionSimTimeMs = sourceScene.getCurrentSessionSimTimeMs(session);
  const initialRemainingSimulationMs = Math.max(
    0,
    handoffDeadline.deadlineSimTimeMs - initialSessionSimTimeMs,
  );
  const initialDelayMs = getStargateJumpHandoffWallclockDelayMs(
    initialRemainingSimulationMs,
    sourceScene.getTimeDilation(),
  );
  setTimeout(attemptHandoff, initialDelayMs);
  return {
    deadlineSimTimeMs: handoffDeadline.deadlineSimTimeMs,
    initialDelayMs,
  };
}

function syncDockedShipTransitionForSession(session, dockResult, options = {}) {
  if (!session || !dockResult || !dockResult.success || !dockResult.data) {
    return;
  }

  const dockedShip = dockResult.data;
  const previousData = dockResult.previousData || {};

  // Docking moves the active hull into the station hangar. The client needs
  // the location/flag delta for the move itself, then a second cache refresh
  // so the hangar scene can resolve the active hull immediately.
  emitItemsChangedForSession(
    session,
    dockedShip,
    {
      locationID: previousData.locationID,
      flagID: previousData.flagID,
      quantity: previousData.quantity,
      singleton: previousData.singleton,
      stacksize: previousData.stacksize,
    },
    {
      locationContext: Object.prototype.hasOwnProperty.call(options, "locationContext")
        ? options.locationContext
        : null,
    },
  );

  if (options.refreshActiveShip !== false) {
    syncInventoryItemForSession(
      session,
      dockedShip,
      {
        locationID: dockedShip.locationID,
        flagID: dockedShip.flagID,
        quantity: dockedShip.quantity,
        singleton: dockedShip.singleton,
        stacksize: dockedShip.stacksize,
      },
      {
        emitCfgLocation: true,
      },
    );
  }

  if (options.refreshShipContents !== false) {
    syncDockedShipContentsForSession(session, dockedShip);
  }
}

function buildDockedShipLocationContext(kind, locationID) {
  const resolvedLocationID = Number(locationID || 0);
  if (!Number.isFinite(resolvedLocationID) || resolvedLocationID <= 0) {
    return null;
  }
  if (kind === "structure") {
    return ["Structure", resolvedLocationID, "StructureShipHangar"];
  }
  if (kind === "station") {
    return ["Station", resolvedLocationID, "StationHangar"];
  }
  return null;
}

function syncDockedShipContentsForSession(session, dockedShip) {
  const characterID = Number(session && session.characterID) || 0;
  const shipID = Number(dockedShip && dockedShip.itemID) || 0;
  if (characterID <= 0 || shipID <= 0) {
    return;
  }

  const shipContents = listContainerItems(characterID, shipID, null);
  for (const item of shipContents) {
    const flagID = Number(item && item.flagID) || 0;
    if (!DOCKED_SHIP_CONTENT_REFRESH_FLAGS.has(flagID)) {
      continue;
    }
    syncInventoryItemForSession(
      session,
      item,
      {
        locationID: item.locationID,
        flagID: item.flagID,
        quantity: item.quantity,
        singleton: item.singleton,
        stacksize: item.stacksize,
      },
      {
        emitCfgLocation: false,
      },
    );
  }
}

function getStrategicCruiserTransitionUseError(charID, shipItem) {
  if (!shipItem) {
    return null;
  }
  // Lazy-load fitting state to avoid widening the already dense transition
  // initialization cycle.
  const {
    getStrategicCruiserUseStatus,
    isStrategicCruiserType,
  } = require(path.join(__dirname, "../services/fitting/liveFittingState"));
  if (!isStrategicCruiserType(shipItem.typeID)) {
    return null;
  }
  const fittedItems = listContainerItems(null, shipItem.itemID, null);
  const status = getStrategicCruiserUseStatus(charID, shipItem, fittedItems);
  return status.complete
    ? null
    : {
        success: false,
        errorMsg: "STRATEGIC_CRUISER_FIT_INCOMPLETE",
        data: {
          missingSubsystemFlags:
            status.subsystemStatus && status.subsystemStatus.missingFlags || [],
          invalidRegularSlotCount: status.invalidRegularSlotItems.length,
          turretOverload: status.turretOverload,
          launcherOverload: status.launcherOverload,
          cpuOverload: status.cpuOverload,
          powerOverload: status.powerOverload,
          droneBayOverload: status.droneBayOverload,
          fighterBayOverload: status.fighterBayOverload,
        },
      };
}

function undockSession(session, options = {}) {
  if (!session || !session.characterID) {
    return {
      success: false,
      errorMsg: "CHARACTER_NOT_SELECTED",
    };
  }
  const abyssalRestriction = buildActiveAbyssalTransitionBlockedResult(
    session,
    "undock",
  );
  if (abyssalRestriction) {
    return abyssalRestriction;
  }

  const dockedLocationID = getDockedLocationID(session);
  if (!dockedLocationID) {
    return {
      success: false,
      errorMsg: "DOCK_REQUIRED",
    };
  }

  const dockable = resolveDockableLocation(dockedLocationID);
  if (!dockable) {
    return {
      success: false,
      errorMsg: "STATION_NOT_FOUND",
    };
  }

  const activeShip = getActiveShipRecord(session.characterID);
  if (!activeShip) {
    return {
      success: false,
      errorMsg: "SHIP_NOT_FOUND",
    };
  }
  const strategicCruiserUseError = getStrategicCruiserTransitionUseError(
    session.characterID,
    activeShip,
  );
  if (strategicCruiserUseError) {
    return strategicCruiserUseError;
  }

  if (!beginTransition(session, "undock", dockedLocationID)) {
    return {
      success: false,
      errorMsg: "UNDOCK_IN_PROGRESS",
    };
  }

  try {
    const previousLocalChannelID = Number(
      getDockedLocationID(session) ||
      session.solarsystemid2 ||
      session.solarsystemid ||
      0,
    ) || 0;
    if (
      dockable.kind === "structure" &&
      structureState.hasStructureOneWayUndockRestriction(
        dockable.record,
        session.shipTypeID,
      ) &&
      !structureState.hasStructureGmBypass(session)
    ) {
      return {
        success: false,
        errorMsg: "UNDOCK_RESTRICTED_BY_STRUCTURE",
      };
    }
    const ignoreContraband = Boolean(options.ignoreContraband);
    // A client's own undock (ship.Undock, structureDocking.Undock) is refused
    // once, untouched, when the hold carries something the local law acts on:
    // the client asks the player and calls again with ignoreContraband set.
    // Server-side callers do not pass warnOnContraband and are never refused.
    if (options.warnOnContraband === true && !ignoreContraband) {
      const contrabandWarning = findContrabandWarningForTransition(
        session,
        activeShip.itemID,
        dockable.solarSystemID,
      );
      if (contrabandWarning) {
        return {
          success: false,
          errorMsg: "SHIP_CONTRABAND_WARNING_UNDOCK",
          data: contrabandWarning,
        };
      }
    }
    const contrabandInspection = inspectContrabandForTransition(
      session,
      activeShip.itemID,
      dockable.solarSystemID,
      "undock",
    );
    const undockState = spaceRuntime.getStationUndockSpawnState(dockable.record, {
      shipTypeID: session.shipTypeID || (activeShip && activeShip.typeID),
      selectionStrategy: dockable.kind === "structure" ? "random" : "first",
      selectionKey: activeShip && activeShip.itemID,
    });

    const moveResult = moveShipToSpace(activeShip.itemID, dockable.solarSystemID, {
      position: undockState.position,
      direction: undockState.direction,
      velocity: { x: 0, y: 0, z: 0 },
      speedFraction: 0,
      mode: "STOP",
      targetPoint: undockState.position,
      customInfo: `Undocking:${dockedLocationID}`,
    });
    if (!moveResult.success) {
      return moveResult;
    }

    const restoreResult = topOffShipShieldAndCapacitorForDockingTransition(
      moveResult.data.itemID,
    );
    if (restoreResult && restoreResult.success) {
      moveResult.data = restoreResult.data;
    }

    const itemChangeData = dockable.kind === "structure"
      ? {
          ...moveResult.data,
          clientCustomInfo: "UndockingStructure:",
        }
      : moveResult.data;
    if (options.deferInitialSelection !== true) emitItemsChangedForSession(
      session,
      itemChangeData,
      {
        locationID: moveResult.previousData.locationID,
        flagID: moveResult.previousData.flagID,
        quantity: moveResult.previousData.quantity,
        singleton: moveResult.previousData.singleton,
        stacksize: moveResult.previousData.stacksize,
      },
    );
    if (options.deferInitialSelection !== true) sendMachoObjectDisconnects(session, SERVICES_LET_GO_AT_A_MOVE);

    if (options.deferInitialSelection !== true) {
      if (dockable.kind === "station") broadcastOnCharNoLongerInStation(session, dockedLocationID);
      else if (dockable.kind === "structure") broadcastOnCharacterLeftStructure(session, dockedLocationID);
    }

    const updateResult = updateCharacterRecord(session.characterID, (record) =>
      buildLocationIdentityPatch(record, dockable.solarSystemID, {
        homeStationID:
          Number(record.homeStationID || record.cloneStationID || session.homeStationID || 60003760) ||
          60003760,
        cloneStationID:
          Number(record.cloneStationID || record.homeStationID || session.cloneStationID || 60003760) ||
          60003760,
        stationID: null,
        structureID: null,
      }),
      { expectedLocationTransitionReason: "undock" },
    );
    if (!updateResult.success) {
      return updateResult;
    }

    clearDeferredDockedShipSessionChange(session);
    clearDockedFittingBootstrap(session);

    const applyResult = applyCharacterToSession(session, session.characterID, {
      emitNotifications: false,
      logSelection: true,
      selectionEvent: false,
      deferDockedShipSessionChange: false,
    });
    if (!applyResult.success) {
      return applyResult;
    }

    if (options.deferInitialSelection === true) {
      return { success: true, data: { station: dockable.record, ship: moveResult.data } };
    }

    spaceRuntime.attachSession(session, moveResult.data, {
      systemID: dockable.solarSystemID,
      undockDirection: undockState.direction,
      speedFraction: 1,
      pendingUndockMovement: false,
      undockBootstrapMovementPrime: true,
      skipLegacyStationNormalization: true,
      broadcast: true,
      emitSimClockRebase: false,
      deferUniverseSiteReconcile: true,
      universeSiteReconcileReason: "undock",
    });
    const scene = spaceRuntime.getSceneForSession(session);
    // TQ: the undocking pilot joins its Grid bubble now, ahead of its SetState.
    if (scene && typeof scene.beginUndockEntry === "function") {
      scene.beginUndockEntry(session, { fromStructure: dockable.kind === "structure" });
    }
    if (dockable.kind === "structure" && scene) {
      if (session._space) {
        session._space.pendingUndockStructureSlimItemChangeID = dockedLocationID;
      }
      scene.syncStructureEntitiesFromState({
        broadcast: true,
        excludedSession: session,
      });
    }
    queuePostSpaceAttachFittingHydration(session, moveResult.data.itemID, {
      inventoryBootstrapPending: false,
      hydrationProfile: "undock",
    });
    flushCharacterSessionNotificationPlan(
      session,
      applyTqDockingTransitionSessionChangeShape(applyResult.notificationPlan),
    );
    queuePendingSessionEffects(session, {
      previousLocalChannelID,
    });
    flushPendingCommandSessionEffects(session);
    sendUndockInvulnerabilityUpdated(session, moveResult.data.itemID);
    scheduleUndockInvulnerabilityCancellation(session, moveResult.data.itemID, {
      delayMs: options.undockInvulnerabilityDelayMs,
    });

    log.info(
      `[SpaceTransition] Undocked ${session.characterName || session.characterID} ship=${moveResult.data.itemID} location=${dockedLocationID} kind=${dockable.kind} system=${dockable.solarSystemID}`,
    );

    return {
      success: true,
      data: {
        station: dockable.record,
        ship: moveResult.data,
        contrabandInspection,
        ignoreContraband,
        boundResult: buildBoundResult(session),
      },
    };
  } finally {
    endTransition(session, "undock");
  }
}

function dockSession(session, stationID) {
  const deathRestriction = buildShipDeathTransitionBlockedResult(session);
  if (deathRestriction) return deathRestriction;
  if (!session || !session.characterID) {
    return {
      success: false,
      errorMsg: "CHARACTER_NOT_SELECTED",
    };
  }
  const abyssalRestriction = buildActiveAbyssalTransitionBlockedResult(
    session,
    "dock",
  );
  if (abyssalRestriction) {
    return abyssalRestriction;
  }

  if (isDockedSession(session)) {
    return {
      success: false,
      errorMsg: "ALREADY_DOCKED",
    };
  }

  const targetStationID = Number(stationID || 0);
  const dockable = resolveDockableLocation(targetStationID);
  if (!dockable) {
    return {
      success: false,
      errorMsg: "STATION_NOT_FOUND",
    };
  }

  const activeShip = getActiveShipRecord(session.characterID);
  if (!activeShip) {
    return {
      success: false,
      errorMsg: "SHIP_NOT_FOUND",
    };
  }

  if (crimewatchState.isCriminallyFlagged(session.characterID, getCrimewatchReferenceMs(session))) {
    return {
      success: false,
      errorMsg: "CRIMINAL_TIMER_ACTIVE",
    };
  }

  // A weapons timer started after the docking request was accepted (an
  // aggressive act during the approach) must still refuse the finalize.
  if (crimewatchState.hasActiveWeaponTimer(
    session.characterID,
    getCrimewatchReferenceMs(session),
  )) {
    return {
      success: false,
      errorMsg: "WEAPONS_TIMER_ACTIVE",
    };
  }

  if (dockable.kind === "structure") {
    const dockCheck = structureState.canCharacterDockAtStructure(session, dockable.record, {
      shipTypeID: session.shipTypeID,
    });
    if (!dockCheck.success) {
      return dockCheck;
    }
  }

  if (!beginTransition(session, "dock", targetStationID)) {
    return {
      success: false,
      errorMsg: "DOCK_IN_PROGRESS",
    };
  }

  try {
    deactivateActiveModulesForSpaceTransition(session, "dock");
    clearPendingUndockInvulnerability(session);
    sendInvulnerabilityCancelled(session, activeShip.itemID);
    sendMachoObjectDisconnects(session, SERVICES_LET_GO_AT_A_MOVE);
    spaceRuntime.detachSession(session, {
      broadcast: true,
      lifecycleReason: "dock",
      notifySelfOnTargetClear: true,
    });

    const dockResult = dockShipToLocation(activeShip.itemID, dockable.locationID);
    if (!dockResult.success) {
      return dockResult;
    }
    const topOffResult = topOffShipShieldAndCapacitorForDockingTransition(
      dockResult.data.itemID,
    );
    if (topOffResult && topOffResult.success) {
      dockResult.data = topOffResult.data;
    }

    syncDockedShipTransitionForSession(session, dockResult, {
      locationContext: buildDockedShipLocationContext(dockable.kind, dockable.locationID),
      refreshActiveShip: false,
      refreshShipContents: false,
    });

    const updateResult = updateCharacterRecord(session.characterID, (record) =>
      buildLocationIdentityPatch(record, dockable.solarSystemID, {
        homeStationID:
          Number(record.homeStationID || record.cloneStationID || session.homeStationID || 60003760) ||
          60003760,
        cloneStationID:
          Number(record.cloneStationID || record.homeStationID || session.cloneStationID || 60003760) ||
          60003760,
        stationID: dockable.kind === "station" ? dockable.locationID : null,
        structureID: dockable.kind === "structure" ? dockable.locationID : null,
      }),
      { expectedLocationTransitionReason: "dock" },
    );
    if (!updateResult.success) {
      return updateResult;
    }

    const applyResult = applyCharacterToSession(session, session.characterID, {
      emitNotifications: false,
      logSelection: true,
      selectionEvent: false,
      deferDockedShipSessionChange: false,
    });
    if (!applyResult.success) {
      return applyResult;
    }

    flushCharacterSessionNotificationPlan(
      session,
      applyTqDockingTransitionSessionChangeShape(applyResult.notificationPlan),
    );
    sendDockingFinished(session, dockable.locationID);
    if (dockable.kind === "station") {
      broadcastOnCharNowInStation(session, dockable.locationID);
    } else if (dockable.kind === "structure") {
      broadcastOnCharacterEnteredStructure(session, dockable.locationID);
    }

    log.info(
      `[SpaceTransition] Docked ${session.characterName || session.characterID} ship=${activeShip.itemID} location=${dockable.locationID} kind=${dockable.kind}`,
    );

    return {
      success: true,
      data: {
        station: dockable.record,
        boundResult: buildBoundResult(session),
      },
    };
  } finally {
    endTransition(session, "dock");
  }
}

function consumeEmergencyWarpReturnStateForLogin(activeShip, characterID) {
  if (!activeShip || !activeShip.spaceState) {
    return activeShip;
  }

  const returnState = getEmergencyWarpReturnState(activeShip.spaceState);
  if (!returnState) {
    return activeShip;
  }

  const suppressReturnWarp = shipSuppressesEmergencyWarp(characterID);
  const nextSpaceState = suppressReturnWarp
    ? clearEmergencyWarpReturnState(activeShip.spaceState)
    : buildEmergencyWarpReturnSpaceState(activeShip.spaceState);
  if (!nextSpaceState) {
    return activeShip;
  }

  const moveResult = moveShipToSpace(
    activeShip.itemID,
    nextSpaceState.systemID || activeShip.spaceState.systemID,
    nextSpaceState,
  );
  if (!moveResult.success) {
    log.warn(
      `[SpaceTransition] Failed to consume emergency warp return state for ` +
        `char=${characterID} ship=${activeShip.itemID}: ${moveResult.errorMsg}`,
    );
    return activeShip;
  }

  return moveResult.data || activeShip;
}

function getSessionSpaceSystemID(session) {
  if (!session) {
    return 0;
  }
  for (const candidate of [
    session.solarsystemid2,
    session.solarsystemid,
    session.locationid,
    session.locationID,
  ]) {
    const systemID = toInt(candidate, 0);
    if (systemID > 0) {
      return systemID;
    }
  }
  return 0;
}

function buildLoginSpaceRepairState(activeShip, systemID) {
  const rawState =
    activeShip && activeShip.spaceState && typeof activeShip.spaceState === "object"
      ? activeShip.spaceState
      : {};
  const position = cloneVector(rawState.position);
  return {
    ...rawState,
    systemID,
    position,
    direction: normalizeVector(
      cloneVector(rawState.direction, { x: 1, y: 0, z: 0 }),
      { x: 1, y: 0, z: 0 },
    ),
    velocity: { x: 0, y: 0, z: 0 },
    speedFraction: 0,
    mode: "STOP",
    targetPoint: rawState.targetPoint
      ? cloneVector(rawState.targetPoint)
      : position,
    targetEntityID: null,
    followRange: 0,
    orbitDistance: 0,
    orbitNormal: null,
    orbitSign: 1,
  };
}

function repairActiveShipSpaceStateForLogin(session, activeShip) {
  const systemID = getSessionSpaceSystemID(session);
  if (!activeShip || !activeShip.itemID || systemID <= 0) {
    return activeShip;
  }

  const rawSpaceState =
    activeShip.spaceState && typeof activeShip.spaceState === "object"
      ? activeShip.spaceState
      : null;
  const stateSystemID = toInt(rawSpaceState && rawSpaceState.systemID, 0);
  const locationID = toInt(activeShip.locationID, 0);
  const flagID = toInt(activeShip.flagID, ITEM_FLAGS.HANGAR);
  const hasPersistedWarpState = Boolean(
    rawSpaceState &&
      (
        String(rawSpaceState.mode || "").toUpperCase() === "WARP"
      ),
  );
  if (
    rawSpaceState &&
    stateSystemID === systemID &&
    locationID === systemID &&
    flagID === 0 &&
    !hasPersistedWarpState
  ) {
    return activeShip;
  }

  const moveResult = moveShipToSpace(
    activeShip.itemID,
    systemID,
    buildLoginSpaceRepairState(activeShip, systemID),
  );
  if (!moveResult.success) {
    log.warn(
      `[SpaceTransition] Failed to repair active ship for space login ` +
        `char=${session.characterID} ship=${activeShip.itemID} system=${systemID}: ${moveResult.errorMsg}`,
    );
    return activeShip;
  }

  log.info(
    `[SpaceTransition] Repaired active ship for space login ` +
      `char=${session.characterID} ship=${activeShip.itemID} system=${systemID} ` +
      `location=${locationID} flag=${flagID} stateSystem=${stateSystemID}`,
  );
  return moveResult.data || activeShip;
}

function restoreSpaceSession(session) {
  if (!session || !session.characterID || isDockedSession(session)) {
    return false;
  }

  try {
    const AbyssalMgrService = require("../abyssal").transitionIntegration;
    if (
      AbyssalMgrService &&
      typeof AbyssalMgrService.prepareStartupRecoveryBarrier === "function"
    ) {
      const recoveryResult = AbyssalMgrService.prepareStartupRecoveryBarrier(
        "space-restore",
        session,
      );
      if (recoveryResult && recoveryResult.success === false) {
        log.warn(
          `[SpaceTransition] Abyssal startup recovery barrier failed during space restore ` +
            `char=${session.characterID} failedRuns=${Array.isArray(recoveryResult.failedInstanceIDs) ? recoveryResult.failedInstanceIDs.join(",") : "unknown"}`,
        );
      }
      if (recoveryResult && recoveryResult.blocksSession === true) {
        return false;
      }
    }
  } catch (error) {
    log.warn(
      `[SpaceTransition] Abyssal startup recovery barrier threw during space restore ` +
        `char=${session.characterID} reason=${error && error.message || "UNKNOWN"}`,
    );
    if (isAbyssalHostLocationID(session.solarsystemid2 || session.solarsystemid)) {
      return false;
    }
  }

  if (typeof spaceRuntime.beginSessionJumpTimingTrace === "function") {
    spaceRuntime.beginSessionJumpTimingTrace(session, "space-login", {
      characterID: session.characterID,
      systemID: Number(session.solarsystemid2 || session.solarsystemid || 0) || 0,
      shipID: Number(session.shipid || session.shipID || session.activeShipID || 0) || 0,
    });
  }
  if (typeof spaceRuntime.recordSessionJumpTimingTrace === "function") {
    spaceRuntime.recordSessionJumpTimingTrace(session, "space-login-restore-enter", {
      characterID: session.characterID,
      systemID: Number(session.solarsystemid2 || session.solarsystemid || 0) || 0,
    });
  }

  let activeShip = getActiveShipRecord(session.characterID);
  activeShip = repairActiveShipSpaceStateForLogin(session, activeShip);
  if (!activeShip || !activeShip.spaceState) {
    return false;
  }
  activeShip = consumeEmergencyWarpReturnStateForLogin(
    activeShip,
    session.characterID,
  );

  const attachStartedAtMs = Date.now();
  const shipEntity = spaceRuntime.attachSession(session, activeShip, {
    systemID:
      activeShip.spaceState.systemID ||
      session.solarsystemid ||
      session.solarsystemid2,
    pendingUndockMovement: false,
    broadcast: true,
    emitSimClockRebase: false,
    deferUniverseSiteReconcile: true,
    universeSiteReconcileReason: "space-login",
  });
  const attachElapsedMs = Date.now() - attachStartedAtMs;
  if (typeof spaceRuntime.recordSessionJumpTimingTrace === "function") {
    spaceRuntime.recordSessionJumpTimingTrace(session, "space-login-restore-attached", {
      shipID: Number(activeShip.itemID) || 0,
      systemID:
        Number(activeShip.spaceState && activeShip.spaceState.systemID) ||
        Number(session.solarsystemid2 || session.solarsystemid) ||
        0,
      attachMs: attachElapsedMs,
      attached: Boolean(shipEntity),
    });
  }
  if (attachElapsedMs >= 250) {
    log.info(
      `[SpaceTransition] restoreSpaceSession attach ship=${Number(activeShip.itemID) || 0} ` +
      `system=${Number(activeShip.spaceState && activeShip.spaceState.systemID) || Number(session.solarsystemid2 || session.solarsystemid) || 0} ` +
      `took ${attachElapsedMs}ms`,
    );
  }
  if (!shipEntity) {
    return false;
  }

  if (require("../services/activity/voidReplayAdmission").isVoidSystemID(Number(session._space?.systemID))) {
    require("../services/activity/voidReplayRuntime").restoreRoom(session);
  }

  const hydrationQueuedAtMs = Date.now();
  queuePostSpaceAttachFittingHydration(session, activeShip.itemID, {
    // Direct login-in-space issues one early ship-inventory List(flag=None)
    // before the HUD stabilizes. Let invbroker suppress only that first call;
    // later explicit None requests still need the full ship contents.
    inventoryBootstrapPending: session._loginInventoryBootstrapPending === true,
    hydrationProfile: "login",
  });
  if (typeof spaceRuntime.recordSessionJumpTimingTrace === "function") {
    spaceRuntime.recordSessionJumpTimingTrace(session, "space-login-restore-hydration-queued", {
      shipID: Number(activeShip.itemID) || 0,
      queueLatencyMs: Date.now() - hydrationQueuedAtMs,
      inventoryBootstrapPending: session._loginInventoryBootstrapPending === true,
    });
  }
  // CCP client parity: Michelle creates its local Ballpark only after the
  // inflight/structure view path calls beyonce.GetFormations. Sending the
  // initial destiny bootstrap from restore-time can arrive before
  // SessionChange/GameUI/AddBallpark, which leaves the client with no bp to
  // consume and can black-screen login. Keep restore to attach-only; Beyonce
  // remains the first safe bootstrap trigger for direct space login.
  log.debug(
    `[space-login-restore] attached shipID=${Number(activeShip.itemID) || 0} ` +
    `systemID=${Number(
      activeShip.spaceState &&
      activeShip.spaceState.systemID,
    ) || Number(session.solarsystemid || session.solarsystemid2) || 0} ` +
    `${describeSessionHydrationState(session, activeShip.itemID)}`,
  );
  flushPendingCommandSessionEffects(session);
  if (typeof spaceRuntime.recordSessionJumpTimingTrace === "function") {
    spaceRuntime.recordSessionJumpTimingTrace(session, "space-login-restore-return", {
      shipID: Number(activeShip.itemID) || 0,
      systemID:
        Number(activeShip.spaceState && activeShip.spaceState.systemID) ||
        Number(session.solarsystemid2 || session.solarsystemid) ||
        0,
      success: true,
    });
  }

  return true;
}

// Ship destruction ejects the pilot whatever the ship's modules are doing.
const SHIP_DESTRUCTION_MODULE_COMMITMENT_BYPASS = Symbol(
  "shipDestructionModuleCommitmentBypass",
);

function ejectSession(session, options = {}) {
  if (options[SHIP_DESTRUCTION_ABYSSAL_TRANSITION_BYPASS] !== true) {
    const deathRestriction = buildShipDeathTransitionBlockedResult(session);
    if (deathRestriction) return deathRestriction;
  }
  if (!session || !session.characterID || !session._space) {
    return {
      success: false,
      errorMsg: "NOT_IN_SPACE",
    };
  }
  if (options[SHIP_DESTRUCTION_ABYSSAL_TRANSITION_BYPASS] !== true) {
    const abyssalRestriction = buildActiveAbyssalTransitionBlockedResult(
      session,
      "eject",
    );
    if (abyssalRestriction) {
      return abyssalRestriction;
    }
  }

  // Retail: a ship running an Entosis Link cannot eject. Read off the live
  // entity, before the ship record lookup, so the gate answers the same way
  // for a synthetic session in a test scene.
  if (options[SHIP_DESTRUCTION_MODULE_COMMITMENT_BYPASS] !== true) {
    const { hasActiveEntosisLinkEffect } = require(path.join(
      __dirname,
      "./modules/entosisLinkRuntime",
    ));
    const linkedScene = spaceRuntime.getSceneForSession(session);
    const linkedEntity =
      linkedScene && typeof linkedScene.getEntityByID === "function"
        ? linkedScene.getEntityByID(session._space.shipID)
        : null;
    if (hasActiveEntosisLinkEffect(linkedEntity)) {
      return {
        success: false,
        errorMsg: "EJECT_DISALLOWED_BY_MODULE",
      };
    }
  }

  const activeShip = getActiveShipRecord(session.characterID);
  if (!activeShip) {
    return {
      success: false,
      errorMsg: "SHIP_NOT_FOUND",
    };
  }
  if (isCapsuleTypeID(activeShip.typeID)) {
    return {
      success: false,
      errorMsg: "ALREADY_IN_CAPSULE",
    };
  }

  const scene = spaceRuntime.getSceneForSession(session);
  const currentEntity = spaceRuntime.getEntity(session, activeShip.itemID);
  if (!scene || !currentEntity) {
    return {
      success: false,
      errorMsg: "SCENE_NOT_FOUND",
    };
  }

  if (!beginTransition(session, "eject", activeShip.itemID, options)) {
    return {
      success: false,
      errorMsg: "EJECT_IN_PROGRESS",
    };
  }

  try {
    const beforeSameSceneShipSwapNotificationPlanFlush =
      typeof options.beforeSameSceneShipSwapNotificationPlanFlush === "function"
        ? options.beforeSameSceneShipSwapNotificationPlanFlush
        : null;
    const sendEjectSpecialFx = options.sendEjectSpecialFx !== false;
    const disconnectBoundObjectsBeforeSwap =
      options.disconnectBoundObjectsBeforeSwap === true;
    const hasSameSceneShipSwapSessionId = Object.prototype.hasOwnProperty.call(
      options,
      "sameSceneShipSwapSessionId",
    );
    const currentSystemID = Number(session._space.systemID || session.solarsystemid2 || session.solarsystemid || 0);
    const characterRecord = getCharacterRecord(session.characterID) || {};
    const preferredStationID =
      Number(
        characterRecord.homeStationID ||
          characterRecord.cloneStationID ||
          session.stationid ||
          session.stationID ||
          60003760,
      ) || 60003760;
    const preservedSpaceState = captureSpaceSessionState(session);
    const capsuleResult = resolveReusableCapsuleForCharacter(
      session.characterID,
      activeShip.itemID,
      currentSystemID,
      preferredStationID,
    );
    if (!capsuleResult.success || !capsuleResult.data) {
      return {
        success: false,
        errorMsg: capsuleResult.errorMsg || "CAPSULE_NOT_FOUND",
      };
    }

    if (disconnectBoundObjectsBeforeSwap) {
      sendMachoObjectDisconnects(session);
    }

    if (typeof scene.prepareSameSceneSessionTetherRelease === "function") {
      const tetherReleaseResult = scene.prepareSameSceneSessionTetherRelease(
        session,
        currentEntity,
      );
      if (!tetherReleaseResult || tetherReleaseResult.success !== true) {
        return {
          success: false,
          errorMsg:
            tetherReleaseResult && tetherReleaseResult.errorMsg ||
            "DESTINY_TETHER_RELEASE_DELIVERY_FAILED",
        };
      }
    }

    const abandonedShipEntity = spaceRuntime.disembarkSession(session, {
      broadcast: true,
      lifecycleReason: "disembark",
    });
    if (!abandonedShipEntity) {
      return {
        success: false,
        errorMsg: "ACTIVE_SHIP_ENTITY_NOT_FOUND",
      };
    }

    const capsuleMoveResult = moveShipToSpace(
      capsuleResult.data.itemID,
      currentSystemID,
      buildStoppedSpaceStateFromEntity(currentEntity),
    );
    if (!capsuleMoveResult.success) {
      return capsuleMoveResult;
    }

    sendPodOrCorvetteAssembly(session, capsuleMoveResult.data);

    const activeShipResult = setActiveShipForCharacter(
      session.characterID,
      capsuleMoveResult.data.itemID,
    );
    if (!activeShipResult.success) {
      return activeShipResult;
    }

    const updateResult = updateCharacterRecord(session.characterID, (record) =>
      buildLocationIdentityPatch(record, currentSystemID, {
        stationID: null,
        structureID: null,
      }),
      { expectedLocationTransitionReason: "eject" },
    );
    if (!updateResult.success) {
      return updateResult;
    }

    clearDeferredDockedShipSessionChange(session);
    clearDockedFittingBootstrap(session);

    const applyResult = applyCharacterToSession(session, session.characterID, {
      emitNotifications: false,
      logSelection: true,
      selectionEvent: false,
      deferDockedShipSessionChange: false,
    });
    if (!applyResult.success) {
      return applyResult;
    }

    // The capsule launches beside the hull it left (TQ), never moved to a
    // nearby station's perimeter by the login path's normalisation: that
    // put it tens of km from the hull near a large station.
    const capsuleEntity = spaceRuntime.attachSession(session, capsuleMoveResult.data, {
      sceneDescriptor: scene.sceneDescriptor || currentSystemID,
      pendingUndockMovement: false,
      spawnStopped: true,
      skipLegacyStationNormalization: true,
      broadcast: false,
      emitSimClockRebase: false,
      beyonceBound: preservedSpaceState.beyonceBound,
      initialStateSent: preservedSpaceState.initialStateSent,
      initialBallparkVisualsSent: preservedSpaceState.initialBallparkVisualsSent,
      initialBallparkClockSynced: preservedSpaceState.initialBallparkClockSynced,
      deferUniverseSiteReconcile: true,
      universeSiteReconcileReason: "eject",
    });
    if (!capsuleEntity) {
      return {
        success: false,
        errorMsg: "CAPSULE_ATTACH_FAILED",
      };
    }

    if (session._abyssalOfflineSession !== true) {
      queuePostSpaceAttachFittingHydration(session, capsuleMoveResult.data.itemID, {
        inventoryBootstrapPending: false,
        hydrationProfile: "capsule",
      });
    }
    if (beforeSameSceneShipSwapNotificationPlanFlush) {
      const hookResult = beforeSameSceneShipSwapNotificationPlanFlush({
        session,
        scene,
        activeShip,
        abandonedShipEntity,
        capsuleEntity,
        capsule: capsuleMoveResult.data,
        currentSystemID,
        notificationPlan: applyResult.notificationPlan,
      });
      if (hookResult && hookResult.success === false) {
        return hookResult;
      }
    }
    retargetCharacterSessionNotificationPlanShip(
      applyResult.notificationPlan,
      activeShip.itemID,
      capsuleMoveResult.data.itemID,
    );
    flushSameSceneShipSwapNotificationPlan(
      session,
      applyResult.notificationPlan,
      hasSameSceneShipSwapSessionId
        ? { sessionId: options.sameSceneShipSwapSessionId }
        : {},
    );
    sendShipCosmeticsChanged(session, activeShip.itemID);
    sendShipCosmeticsChanged(session, capsuleMoveResult.data.itemID);
    sendCurrentShipSkinChange(session, capsuleMoveResult.data.itemID);
    repairSameSceneSessionViewState(session);
    // A same-scene swap: no SetState, which would
    // tear down the client's brackets and overview on its live park. The
    // shipid session change above tells the client to wait for the capsule
    // (gameui wannaBeEgo), and the capsule reaches every Observer of its Grid
    // bubble, the pilot included, in the next bubble update's add; the
    // abandoned ship's new slim item (charID 0), interactive flag and
    // Stop go to its bubble history. The pilot still gets what only
    // the SetState carried: the new ego's buff state and HUD re-seed; and
    // its godma gets the capsule's shipState from its next GetAllInfo.
    scene.presentSameSceneShipSwap(session);
    markInSpaceShipChange(session, capsuleMoveResult.data.itemID);
    session._space.awaitedEgoAddID = capsuleMoveResult.data.itemID;

    if (sendEjectSpecialFx) {
      scene.broadcastSpecialFx(
        capsuleEntity.itemID,
        "effects.Jettison",
        {
          targetID: abandonedShipEntity.itemID,
          start: true,
          active: false,
          duration: 4000,
          graphicInfo: { poseID: 0 },
        },
        capsuleEntity,
      );
    }

    log.info(
      `[SpaceTransition] Ejected ${session.characterName || session.characterID} from ship=${activeShip.itemID} into capsule=${capsuleMoveResult.data.itemID} system=${currentSystemID}`,
    );

    return {
      success: true,
      data: {
        abandonedShip: activeShip,
        capsule: capsuleMoveResult.data,
        boundResult: buildBoundResult(session),
      },
    };
  } finally {
    endTransition(session, "eject");
  }
}

function ejectSessionForShipDestruction(session, options = {}) {
  return ejectSession(session, {
    ...options,
    [SHIP_DESTRUCTION_ABYSSAL_TRANSITION_BYPASS]: true,
    [SHIP_DESTRUCTION_MODULE_COMMITMENT_BYPASS]: true,
  });
}

function isTargetLockedByAnotherPlayer(scene, targetEntity, boardingCharacterID) {
  if (
    !scene ||
    !targetEntity ||
    typeof scene.getTargetersForEntity !== "function" ||
    typeof scene.getEntityByID !== "function"
  ) {
    return false;
  }

  const boarderID = Number(boardingCharacterID || 0) || 0;
  for (const targeterID of scene.getTargetersForEntity(targetEntity)) {
    const targeter = scene.getEntityByID(targeterID);
    const targeterCharacterID = Number(
      targeter && targeter.session && targeter.session.characterID,
    ) || 0;
    if (targeterCharacterID > 0 && targeterCharacterID !== boarderID) {
      return true;
    }
  }

  return false;
}

function boardSpaceShip(session, shipID) {
  const deathRestriction = buildShipDeathTransitionBlockedResult(session);
  if (deathRestriction) return deathRestriction;
  if (!session || !session.characterID || !session._space) {
    return {
      success: false,
      errorMsg: "NOT_IN_SPACE",
    };
  }
  const abyssalRestriction = buildActiveAbyssalTransitionBlockedResult(
    session,
    "board",
  );
  if (abyssalRestriction) {
    return abyssalRestriction;
  }

  const targetShipID = Number(shipID || 0) || 0;
  if (!targetShipID) {
    return {
      success: false,
      errorMsg: "SHIP_NOT_FOUND",
    };
  }

  const currentShip = getActiveShipRecord(session.characterID);
  if (!currentShip) {
    return {
      success: false,
      errorMsg: "SHIP_NOT_FOUND",
    };
  }
  if (Number(currentShip.itemID) === targetShipID) {
    return {
      success: true,
      data: {
        ship: currentShip,
        boundResult: buildBoundResult(session),
      },
    };
  }

  const scene = spaceRuntime.getSceneForSession(session);
  const currentEntity = spaceRuntime.getEntity(session, currentShip.itemID);
  if (!scene || !currentEntity) {
    return {
      success: false,
      errorMsg: "SCENE_NOT_FOUND",
    };
  }

  let targetShip = findShipItemById(targetShipID);
  if (!targetShip) {
    return {
      success: false,
      errorMsg: "SHIP_NOT_FOUND",
    };
  }
  if (Number(targetShip.locationID) !== Number(scene.systemID)) {
    return {
      success: false,
      errorMsg: "SHIP_NOT_IN_SYSTEM",
    };
  }

  const targetEntity = scene.getEntityByID(targetShipID);
  if (!targetEntity || targetEntity.kind !== "ship") {
    return {
      success: false,
      errorMsg: "TARGET_SHIP_NOT_ON_GRID",
    };
  }
  // On the pilot's grid as gameplay reads it: a hull launched or spawned for
  // the pilot in this same call is in its Grid bubble already, though its
  // client gets it only with the next bubble update.
  if (!scene.isOnSessionGrid(session, targetEntity)) {
    return {
      success: false,
      errorMsg: "TARGET_SHIP_NOT_ON_GRID",
    };
  }
  // A hull whose breacher-pod death is decided cannot be boarded out of it.
  if (require("../services/ship/breacherPodDeathRuntime").isShipDeathPending(targetShipID)) {
    return { success: false, errorMsg: "SHIP_DESTRUCTION_IN_PROGRESS" };
  }
  const clientHasTargetShip = scene.canSessionSeeDynamicEntity(session, targetEntity);
  if (targetEntity.session && targetEntity.session !== session) {
    return {
      success: false,
      errorMsg: "SHIP_ALREADY_OCCUPIED",
    };
  }
  if (!canEntitiesInteractLocally(currentEntity, targetEntity)) {
    return {
      success: false,
      errorMsg: "TARGET_SHIP_NOT_ON_GRID",
    };
  }
  // Private content is boarded only by those it is private to: a hull in
  // another pilot's private site, and an AIR Civilian Astero that is not
  // this character's (scene/missionAccess.js). Main refused both as off
  // grid, through its per-pilot visibility.
  if (!scene.canSessionSeeDungeonScopedEntity(session, targetEntity)) {
    return {
      success: false,
      errorMsg: "TARGET_SHIP_NOT_ON_GRID",
    };
  }
  // Retail lets the last owner re-board regardless of target locks. Anyone
  // else may only board an unoccupied hull while no other player has it locked.
  // NPC and disconnected-entity locks intentionally do not count here.
  if (
    Number(targetShip.ownerID) !== Number(session.characterID) &&
    isTargetLockedByAnotherPlayer(scene, targetEntity, session.characterID)
  ) {
    return {
      success: false,
      errorMsg: "SHIP_TARGETED_BY_OTHER_PLAYER",
    };
  }

  const boardingDistance = getSurfaceDistanceBetweenEntities(
    currentEntity,
    targetEntity,
  );
  if (boardingDistance > SPACE_BOARDING_RANGE_METERS) {
    return {
      success: false,
      errorMsg: "TOO_FAR_AWAY",
      data: {
        distanceMeters: boardingDistance,
        maxDistanceMeters: SPACE_BOARDING_RANGE_METERS,
      },
    };
  }

  const strategicCruiserUseError = getStrategicCruiserTransitionUseError(
    session.characterID,
    targetShip,
  );
  if (strategicCruiserUseError) {
    return strategicCruiserUseError;
  }

  if (!beginTransition(session, "board", targetShipID)) {
    return {
      success: false,
      errorMsg: "BOARD_IN_PROGRESS",
    };
  }

  try {
    const currentSystemID = Number(scene.systemID || session.solarsystemid2 || session.solarsystemid || 0);
    const preservedSpaceState = captureSpaceSessionState(session);
    const inheritedPlayerEgoScopeState =
      buildPlayerEgoScopeMetadata(currentEntity);
    const shouldConsumePreviousCapsule =
      isCapsuleTypeID(currentShip.typeID) &&
      !isCapsuleTypeID(targetShip.typeID);
    if (typeof scene.prepareSameSceneSessionTetherRelease === "function") {
      const tetherReleaseResult = scene.prepareSameSceneSessionTetherRelease(
        session,
        currentEntity,
      );
      if (!tetherReleaseResult || tetherReleaseResult.success !== true) {
        return {
          success: false,
          errorMsg:
            tetherReleaseResult && tetherReleaseResult.errorMsg ||
            "DESTINY_TETHER_RELEASE_DELIVERY_FAILED",
        };
      }
    }
    const abandonedCurrentEntity = spaceRuntime.disembarkSession(session, {
      broadcast: true,
      lifecycleReason: "disembark",
    });
    if (!abandonedCurrentEntity) {
      return {
        success: false,
        errorMsg: "ACTIVE_SHIP_ENTITY_NOT_FOUND",
      };
    }

    let ownershipTransferResult = null;
    if (Number(targetShip.ownerID) !== Number(session.characterID)) {
      ownershipTransferResult = transferItemToOwnerLocation(
        targetShipID,
        session.characterID,
        targetShip.locationID,
        targetShip.flagID,
        null,
        { reownContents: true },
      );
      if (!ownershipTransferResult.success) {
        return {
          success: false,
          errorMsg:
            ownershipTransferResult.errorMsg ||
            "SHIP_OWNERSHIP_TRANSFER_FAILED",
        };
      }

      targetShip = findCharacterShip(session.characterID, targetShipID);
      if (!targetShip) {
        restoreInventoryItemChangesAtomic(
          ownershipTransferResult.data && ownershipTransferResult.data.changes,
        );
        return {
          success: false,
          errorMsg: "SHIP_OWNERSHIP_TRANSFER_FAILED",
        };
      }
    }

    const activeShipResult = setActiveShipForCharacter(
      session.characterID,
      targetShipID,
    );
    if (!activeShipResult.success) {
      if (ownershipTransferResult) {
        restoreInventoryItemChangesAtomic(
          ownershipTransferResult.data && ownershipTransferResult.data.changes,
        );
      }
      return activeShipResult;
    }

    const updateResult = updateCharacterRecord(session.characterID, (record) =>
      buildLocationIdentityPatch(record, currentSystemID, {
        stationID: null,
        structureID: null,
      }),
      { expectedLocationTransitionReason: "board-space-ship" },
    );
    if (!updateResult.success) {
      return updateResult;
    }

    const applyResult = applyCharacterToSession(session, session.characterID, {
      emitNotifications: false,
      logSelection: true,
      selectionEvent: false,
      deferDockedShipSessionChange: false,
    });
    if (!applyResult.success) {
      return applyResult;
    }

    // The hull is boarded where it is parked (retail), never moved to a
    // nearby station's perimeter by the login path's normalisation.
    const boardedEntity = spaceRuntime.attachSessionToExistingEntity(
      session,
      targetShip,
      targetEntity,
      {
        systemID: currentSystemID,
        pendingUndockMovement: false,
        skipLegacyStationNormalization: true,
        broadcast: false,
        emitSimClockRebase: false,
        beyonceBound: preservedSpaceState.beyonceBound,
        initialStateSent: preservedSpaceState.initialStateSent,
        initialBallparkVisualsSent: preservedSpaceState.initialBallparkVisualsSent,
        initialBallparkClockSynced: preservedSpaceState.initialBallparkClockSynced,
        inheritedPlayerEgoScopeState,
      },
    );
    if (!boardedEntity) {
      return {
        success: false,
        errorMsg: "BOARD_ATTACH_FAILED",
      };
    }
    // An unpiloted hull carries its raw type envelope. Apply fitted modules
    // and pilot skills before the SetState is built, so the client never sees
    // raw max-speed/agility values and then a later hydration correction.
    // Every other Observer already has the hull with its old values: the new
    // mass, agility and max speed go to its Grid bubble history when they
    // apply, on the stamp of the pilot change, the pilot included.
    let boardedDerivedStateResult;
    try {
      boardedDerivedStateResult = scene.refreshShipEntityDerivedState(
        boardedEntity,
        {
          session,
          broadcast: false,
          notifyTargeting: false,
          notifyDerivedAttributes: false,
          notifyGenericModuleAttributes: false,
          shipPrimeBroadcast: (previousState) => scene.broadcastShipPrimeUpdates(
            boardedEntity,
            { previousState },
          ),
        },
      );
    } catch (_error) {
      boardedDerivedStateResult = null;
    }
    if (!boardedDerivedStateResult || boardedDerivedStateResult.success !== true) {
      return {
        success: false,
        errorMsg:
          boardedDerivedStateResult && boardedDerivedStateResult.errorMsg ||
          "BOARD_DERIVED_STATE_REFRESH_FAILED",
      };
    }

    retargetCharacterSessionNotificationPlanShip(
      applyResult.notificationPlan,
      currentShip.itemID,
      targetShipID,
    );
    flushSameSceneShipSwapNotificationPlan(session, applyResult.notificationPlan);
    repairSameSceneSessionViewState(session);
    if (shouldConsumePreviousCapsule) {
      const boardedCapsuleItem =
        findItemById(abandonedCurrentEntity.itemID) || abandonedCurrentEntity;
      // TQ's inventory notification goes out ahead of the Destiny view.
      emitBoardedCapsuleItemsChanged(session, boardedCapsuleItem, {
        locationID: currentSystemID,
        flagID: 0,
        quantity: boardedCapsuleItem.quantity,
        singleton: boardedCapsuleItem.singleton,
        stacksize: boardedCapsuleItem.stacksize,
      });
    }
    // A same-scene swap: no SetState. A boarded
    // ship the pilot's client has is in its park, and the shipid session
    // change makes it the client's ego (gameui). One it has not been told
    // about yet (launched or spawned for it in this same call) is
    // its wannaBeEgo: it reaches the pilot, like every Observer of its Grid
    // bubble, in the next bubble update's add, as an eject's capsule does.
    // The old capsule's removal reaches every Observer, the pilot included,
    // in the next Grid bubble update. The pilot gets the new ego's buff
    // state and HUD re-seed, and its godma the ship's shipState from its
    // next GetAllInfo.
    scene.presentSameSceneShipSwap(session);
    markInSpaceShipChange(session, targetShipID);
    if (!clientHasTargetShip) {
      session._space.awaitedEgoAddID = targetShipID;
    }
    sendShipCosmeticsChanged(session, targetShipID);
    sendShipCosmeticsChanged(session, currentShip.itemID);

    if (shouldConsumePreviousCapsule) {
      let capsuleConsumeResult;
      try {
        capsuleConsumeResult = finalizeBoardedCapsuleConsumption(
          scene,
          session,
          session._space,
          abandonedCurrentEntity,
        );
      } catch (_error) {
        capsuleConsumeResult = null;
      }
      if (!capsuleConsumeResult || !capsuleConsumeResult.success) {
        return {
          success: false,
          errorMsg: "CAPSULE_REMOVAL_DELIVERY_FAILED",
        };
      }
    }

    // The boarded ship's new slim item (its pilot) and its interactive flag
    // to its Grid bubble; its cosmetics went to the pilot above
    // (sendShipCosmeticsChanged).
    scene.broadcastBallRefresh([boardedEntity]);
    queuePostSpaceAttachFittingHydration(session, targetShipID, {
      inventoryBootstrapPending: false,
      hydrationProfile: "transition",
    });

    log.info(
      `[SpaceTransition] Boarded ${session.characterName || session.characterID} ship=${targetShipID} from=${currentShip.itemID} system=${currentSystemID}`,
    );

    require("../services/nodegraph/nodeGraphEvents").publish(session, 190, {
      type_id: targetShip.typeID, group_id: targetEntity.groupID,
    });

    return {
      success: true,
      data: {
        ship: targetShip,
        previousShip: currentShip,
        boundResult: buildBoundResult(session),
      },
    };
  } finally {
    endTransition(session, "board");
  }
}

function getStargateDestinationPrewarmDelayMs(handoffDeadline, timeDilation) {
  const tidiFactor = Math.min(1, Math.max(0.1, toFiniteNumber(timeDilation, 1)));
  const jumpOutBoundaryDeltaMs = Math.max(
    0,
    toFiniteNumber(handoffDeadline && handoffDeadline.jumpOutBoundaryDeltaMs, 0),
  );
  return Math.ceil(jumpOutBoundaryDeltaMs / tidiFactor) +
    STARGATE_JUMP_DESTINATION_PREWARM_AFTER_JUMPOUT_MS;
}

function scheduleStargateDestinationPrewarm(
  session,
  destinationGate,
  sourceScene,
  transitionState,
  sourceSpaceGeneration,
  handoffDeadline,
) {
  const delayMs = getStargateDestinationPrewarmDelayMs(
    handoffDeadline,
    sourceScene.getTimeDilation(),
  );
  setTimeout(() => {
    if (
      !session ||
      session._space !== sourceSpaceGeneration ||
      session._transitionState !== transitionState ||
      spaceRuntime.scenes.get(sourceScene.sceneKey) !== sourceScene
    ) {
      return;
    }
    let result;
    try {
      result = spaceRuntime.prewarmSolarSystemForArrival(destinationGate.solarSystemID, {
        reason: "stargate-arrival-prewarm",
      });
    } catch (error) {
      // The handoff's own attach still wakes the system.
      log.warn(
        `[SpaceTransition] Stargate destination prewarm failed system=${destinationGate.solarSystemID}: ${error.message}`,
      );
      return;
    }
    if (typeof spaceRuntime.recordSessionJumpTimingTrace === "function") {
      spaceRuntime.recordSessionJumpTimingTrace(
        session,
        "stargate-jump-destination-prewarm",
        { destinationSystemID: destinationGate.solarSystemID, delayMs, ...result },
      );
    }
  }, delayMs);
  return delayMs;
}

function jumpSessionViaStargate(session, fromStargateID, toStargateID) {
  const deathRestriction = buildShipDeathTransitionBlockedResult(session);
  if (deathRestriction) return deathRestriction;
  if (!session || !session.characterID || !session._space) {
    return {
      success: false,
      errorMsg: "NOT_IN_SPACE",
    };
  }
  const abyssalRestriction = buildActiveAbyssalTransitionBlockedResult(
    session,
    "stargate-jump",
  );
  if (abyssalRestriction) {
    return abyssalRestriction;
  }

  const transientRoute = require("./transientStargates").resolveRoute(session, fromStargateID);
  const sourceGate = transientRoute?.entity || worldData.getStargateByID(fromStargateID);
  const destinationGate = transientRoute
    ? { ...transientRoute.destinationGate, itemID: sourceGate.destinationID,
        solarSystemID: transientRoute.destination.solarSystemID }
    : worldData.getStargateByID(toStargateID || (sourceGate && sourceGate.destinationID));
  if (!sourceGate || !destinationGate) {
    return {
      success: false,
      errorMsg: "STARGATE_NOT_FOUND",
    };
  }
  // Before startStargateJump, so no JumpOut goes out for a jump the handoff
  // would refuse.
  if (!beginTransition(session, "stargate-jump", sourceGate.itemID)) {
    return {
      success: false,
      errorMsg: "STARGATE_JUMP_IN_PROGRESS",
    };
  }
  if (
    Number(sourceGate.destinationID || 0) !== Number(destinationGate.itemID || 0) ||
    (transientRoute && toStargateID && Number(toStargateID) !== Number(sourceGate.destinationID))
  ) {
    endTransition(session, "stargate-jump");
    return {
      success: false,
      errorMsg: "STARGATE_DESTINATION_MISMATCH",
    };
  }
  if (
    Number(sourceGate.solarSystemID || 0) !== Number(session._space.systemID || 0)
  ) {
    endTransition(session, "stargate-jump");
    return {
      success: false,
      errorMsg: "WRONG_SOLAR_SYSTEM",
    };
  }

  const activeShip = getActiveShipRecord(session.characterID);
  if (!activeShip) {
    endTransition(session, "stargate-jump");
    return {
      success: false,
      errorMsg: "SHIP_NOT_FOUND",
    };
  }

  if (crimewatchState.isCriminallyFlagged(session.characterID, getCrimewatchReferenceMs(session))) {
    endTransition(session, "stargate-jump");
    return {
      success: false,
      errorMsg: "CRIMINAL_TIMER_ACTIVE",
    };
  }

  if (crimewatchState.hasActiveWeaponTimer(
    session.characterID,
    getCrimewatchReferenceMs(session),
  )) {
    endTransition(session, "stargate-jump");
    return {
      success: false,
      errorMsg: "WEAPONS_TIMER_ACTIVE",
    };
  }

  const shipEntity = spaceRuntime.getEntity(session, activeShip.itemID);
  if (
    shipEntity &&
    isScriptedHicStargateBlockedShip(activeShip) &&
    hostileModuleRuntime.hasScriptedHicGateScramble(shipEntity)
  ) {
    endTransition(session, "stargate-jump");
    return {
      success: false,
      errorMsg: "STARGATE_JUMP_BLOCKED_BY_SCRIPTED_HIC",
    };
  }

  const sourceEntity = spaceRuntime.getEntity(session, sourceGate.itemID);
  if (shipEntity && sourceEntity) {
    const jumpDistance = getSurfaceDistanceBetweenEntities(shipEntity, sourceEntity);
    if (jumpDistance > STARGATE_JUMP_RANGE_METERS) {
      endTransition(session, "stargate-jump");
      return {
        success: false,
        errorMsg: "TOO_FAR_FROM_STARGATE",
      };
    }
  }

  // Customs authority starts at the completed destination arrival, below.
  // A queued/failed jump must never sanction cargo in another system.
  const contrabandInspection = null;

  const sourceScene = spaceRuntime.getSceneForSession(session);
  if (!sourceScene) {
    endTransition(session, "stargate-jump");
    return {
      success: false,
      errorMsg: "SCENE_NOT_FOUND",
    };
  }
  const transitionState = session._transitionState;
  const sourceSpaceGeneration = session._space;
  const commandSessionSimTimeMs = sourceScene.getCurrentSessionSimTimeMs(session);
  const sourceTimeDilation = sourceScene.getTimeDilation();
  const sourceClockCapturedAtWallclockMs = Date.now();
  if (typeof spaceRuntime.beginSessionJumpTimingTrace === "function") {
    spaceRuntime.beginSessionJumpTimingTrace(session, "stargate-jump", {
      sourceSystemID: sourceGate.solarSystemID,
      destinationSystemID: destinationGate.solarSystemID,
      sourceGateID: sourceGate.itemID,
      destinationGateID: destinationGate.itemID,
      sourceSimTimeMs: commandSessionSimTimeMs,
      sourceTimeDilation,
      sourceClockCapturedAtWallclockMs,
      shipID: activeShip.itemID,
    });
  }

  const startResult = spaceRuntime.startStargateJump(session, sourceGate.itemID);
  if (!startResult.success) {
    endTransition(session, "stargate-jump");
    return startResult;
  }
  if (!startResult.data || startResult.data.resultSessionDelivered !== true) {
    endTransition(session, "stargate-jump");
    return {
      success: false,
      errorMsg: "STARGATE_JUMP_FX_NOT_DELIVERED",
    };
  }
  const jumpOutObservedSessionSimTimeMs =
    sourceScene.getCurrentSessionSimTimeMs(session);
  const sourceDriver = sourceScene.destinyTickDriver;
  const handoffDeadline = buildStargateJumpHandoffDeadline(
    commandSessionSimTimeMs,
    startResult.data.stamp,
    jumpOutObservedSessionSimTimeMs,
    {
      nextDestinyStamp: sourceScene.nextDestinyStamp,
      jumpOutTickSimTimeMs: sourceDriver && typeof sourceDriver.simTimeOfTick === "function"
        ? sourceDriver.simTimeOfTick(startResult.data.stamp)
        : null,
      simTimeMs: sourceScene.getCurrentSimTimeMs(),
    },
  );
  if (!handoffDeadline) {
    endTransition(session, "stargate-jump");
    return {
      success: false,
      errorMsg: "STARGATE_JUMP_FX_STAMP_INVALID",
    };
  }

  sendJumpQueueUpdate(session, destinationGate.solarSystemID);
  if (typeof spaceRuntime.recordSessionJumpTimingTrace === "function") {
    spaceRuntime.recordSessionJumpTimingTrace(
      session,
      "stargate-jump-handoff-scheduled",
      {
        ...handoffDeadline,
        sourceTimeDilation,
      },
    );
  }
  if (transientRoute) {
    const accepted = require("./transientStargates").scheduleJump(transientRoute, {
      session, ship: shipEntity, characterID: session.characterID,
      transition: transitionState, spaceGeneration: sourceSpaceGeneration,
      deadlineSimTimeMs: handoffDeadline.deadlineSimTimeMs,
      cancel() {
        if (session._transitionState === transitionState) endTransition(session, "stargate-jump");
      },
      complete() {
        if (transientRoute.destinationGate) {
          return completeStargateJump(session, sourceGate, destinationGate, activeShip);
        }
        // The anchor is an existing station/celestial, not a fabricated arrival
        // gate. Retain ordinary solar-transfer custody and native arrival state.
        endTransition(session, "stargate-jump");
        return jumpSessionToSolarSystem(session, destinationGate.solarSystemID, {
          spawnStateOverride: transientRoute.spawn, stargateJumpCloak: true,
        });
      },
    });
    if (!accepted) {
      endTransition(session, "stargate-jump");
      return { success: false, errorMsg: "STARGATE_JUMP_CANCELLED" };
    }
  } else {
    scheduleStargateDestinationPrewarm(
      session,
      destinationGate,
      sourceScene,
      transitionState,
      sourceSpaceGeneration,
      handoffDeadline,
    );
    scheduleStargateJumpHandoff(
      session,
      sourceGate,
      destinationGate,
      activeShip,
      sourceScene,
      transitionState,
      sourceSpaceGeneration,
      handoffDeadline,
    );
  }

  return {
    success: true,
    data: {
      stargate: destinationGate,
      contrabandInspection,
      jumpOutStamp: startResult.data.stamp,
      boundResult: buildBoundResult(session),
    },
  };
}

function rebuildDockedSessionAtStation(session, stationID, options = {}) {
  if (!session || !session.characterID) {
    return {
      success: false,
      errorMsg: "CHARACTER_NOT_SELECTED",
    };
  }

  const targetStationID = Number(stationID || 0);
  // A home clone can wait in an NPC station or in an Upwell structure, and
  // waking in either is the same docked rebuild. A destroyed structure keeps
  // its row, so check destroyedAt as well.
  const dockable = resolveDockableLocation(targetStationID);
  if (
    !dockable ||
    (dockable.kind === "structure" && dockable.record && dockable.record.destroyedAt)
  ) {
    return {
      success: false,
      errorMsg: "STATION_NOT_FOUND",
    };
  }
  const station = dockable.record;
  const isStructure = dockable.kind === "structure";

  const previousLocalChannelID = Number(
    session.solarsystemid2 ||
    session.solarsystemid ||
    session.stationid ||
    session.stationID ||
    0,
  ) || 0;
  const preRespawnShipID = Number(
    session.shipID ||
    session.shipid ||
    session.activeShipID ||
    0,
  ) || 0;

  const capsuleResult = ensureCapsuleForCharacter(
    session.characterID,
    dockable.locationID,
  );
  if (!capsuleResult.success || !capsuleResult.data) {
    return {
      success: false,
      errorMsg: capsuleResult.errorMsg || "CAPSULE_NOT_FOUND",
    };
  }

  const capsuleShip = capsuleResult.data;
  // Recovery must persist a newly provisioned capsule before the character
  // points at it. A restart can then reuse the same destination capsule.
  if (options.durableRecovery === true) {
    const flush = require("../gameStore").flushTableSync("items");
    if (!flush.success) return flush;
  }
  if (options.homeCloneSelfDestructGeneration) {
    require("../services/character/homeStationSelfDestructRuntime").recordReplacementCapsule(
      session.characterID, options.homeCloneSelfDestructGeneration, capsuleShip,
    );
  }
  const activeShipResult = setActiveShipForCharacter(
    session.characterID,
    capsuleShip.itemID,
  );
  if (!activeShipResult.success) {
    return activeShipResult;
  }

  const currentRecord = getCharacterRecord(session.characterID, {
    expectedLocationTransitionReason: "rebuild-docked-session",
  });
  const authoritativeHomeStationID =
    Number(
      (currentRecord && (
        currentRecord.homeStationID ||
        currentRecord.cloneStationID
      )) ||
      session.homeStationID ||
      session.homestationid ||
      session.cloneStationID ||
      session.clonestationid ||
      0,
    ) || 0;

  // A structure is never a default home, the same rule as the dockable jump.
  const fallbackHomeStationID = isStructure ? 60003760 : dockable.locationID;
  const updateResult = updateCharacterRecord(session.characterID, (record) => {
    const next = buildLocationIdentityPatch(record, dockable.solarSystemID, {
      homeStationID: authoritativeHomeStationID || fallbackHomeStationID,
      cloneStationID:
        Number(record.cloneStationID || authoritativeHomeStationID || fallbackHomeStationID) ||
        fallbackHomeStationID,
      stationID: isStructure ? null : dockable.locationID,
      structureID: isStructure ? dockable.locationID : null,
    });
    if (options.airDeathKey) {
      const accepted = next.authoredAirTutorial?.encounter?.combat?.deaths?.pod;
      if (accepted?.plan?.key !== options.airDeathKey) throw new Error("AIR_HOME_CLONE_RECEIPT_MISMATCH");
      accepted.homeCloneReceipt = { key: options.airDeathKey, locationID: dockable.locationID, capsuleID: capsuleShip.itemID };
    }
    if (options.durablePodDeathKey) {
      next.durablePodDeathReceipts ||= {};
      const receipt = next.durablePodDeathReceipts[options.durablePodDeathKey] ||= {};
      receipt.placement = { stationID: dockable.locationID, capsuleID: capsuleShip.itemID };
    }
    return next;
  },
    { expectedLocationTransitionReason: "rebuild-docked-session" },
  );
  if (!updateResult.success) {
    return updateResult;
  }

  if (options.airDeathKey || options.durablePodDeathKey) {
    const flushed = require("../gameStore").flushTableSync("characters");
    if (!flushed.success) {
      const rolledBack = updateCharacterRecord(session.characterID, () => currentRecord);
      return rolledBack.success ? flushed : rolledBack;
    }
  }

  const applyResult = applyCharacterToSession(session, session.characterID, {
    emitNotifications: false,
    logSelection: options.logSelection !== false,
    selectionEvent: false,
    deferDockedShipSessionChange: false,
  });
  if (!applyResult.success) {
    return applyResult;
  }

  let newbieShipResult = null;
  if (options.boardNewbieShip === true) {
    const DogmaService = require(path.join(
      __dirname,
      "../services/dogma/dogmaService",
    ));
    if (typeof DogmaService.boardNewbieShipForSession === "function") {
      newbieShipResult = DogmaService.boardNewbieShipForSession(session, {
        emitNotifications: false,
        logSelection: false,
        repairExistingShip: true,
        durableRecovery: options.durableRecovery === true,
        logLabel: options.newbieShipLogLabel || "PodRespawn",
      });
      if (!newbieShipResult.success) {
        log.warn(
          `[SpaceTransition] Failed to auto-board corvette for ${session.characterName || session.characterID} ${dockable.kind}=${dockable.locationID} error=${newbieShipResult.errorMsg}`,
        );
      } else if (
        newbieShipResult.data &&
        newbieShipResult.data.ship &&
        Number(newbieShipResult.data.ship.itemID) > 0
      ) {
        retargetCharacterSessionNotificationPlanShip(
          applyResult.notificationPlan,
          preRespawnShipID,
          newbieShipResult.data.ship.itemID,
        );
      }
    }
  }

  if (options.emitNotifications !== false) {
    flushCharacterSessionNotificationPlan(
      session,
      isStructure
        ? applyTqDockingTransitionSessionChangeShape(applyResult.notificationPlan)
        : applyResult.notificationPlan,
      { sessionChangeOptions: options.sessionChangeOptions },
    );
  }

  const refreshedCapsule =
    Number(capsuleShip && capsuleShip.itemID) > 0
      ? findCharacterShip(session.characterID, capsuleShip.itemID)
      : null;

  if (refreshedCapsule) {
    const capsuleChanges = Array.isArray(capsuleResult.changes)
      ? capsuleResult.changes
      : [];
    for (const change of capsuleChanges) {
      if (!change || !change.item) {
        continue;
      }

      syncInventoryItemForSession(
        session,
        change.item,
        change.previousState || {
          locationID: 0,
          flagID: ITEM_FLAGS.HANGAR,
        },
        {
          emitCfgLocation: true,
        },
      );
    }

    // Pod respawn briefly seeds a docked capsule before the corvette board
    // step runs. If that board consumes the capsule, never replay the stale
    // capsule row back into the hangar or the client materializes a ghost ship.
    syncInventoryItemForSession(
      session,
      refreshedCapsule,
      {
        locationID: refreshedCapsule.locationID,
        flagID: refreshedCapsule.flagID,
        quantity: refreshedCapsule.quantity,
        singleton: refreshedCapsule.singleton,
        stacksize: refreshedCapsule.stacksize,
      },
      {
        emitCfgLocation: true,
      },
    );
  }

  const refreshedActiveShip =
    getActiveShipRecord(session.characterID) ||
    refreshedCapsule ||
    capsuleShip;
  if (
    refreshedCapsule &&
    Number(refreshedActiveShip.itemID) !== Number(refreshedCapsule.itemID)
  ) {
    syncInventoryItemForSession(
      session,
      refreshedActiveShip,
      {
        locationID: refreshedActiveShip.locationID,
        flagID: refreshedActiveShip.flagID,
        quantity: refreshedActiveShip.quantity,
        singleton: refreshedActiveShip.singleton,
        stacksize: refreshedActiveShip.stacksize,
      },
      {
        emitCfgLocation: true,
      },
    );
  }

  if (session._abyssalOfflineSession !== true) {
    queuePendingSessionEffects(session, {
      previousLocalChannelID,
    });
    flushPendingCommandSessionEffects(session);
    if (isStructure) {
      sendDockingFinished(session, dockable.locationID);
      broadcastOnCharacterEnteredStructure(session, dockable.locationID);
    } else {
      broadcastOnCharNowInStation(session, dockable.locationID);
    }
  }

  const activeShip =
    getActiveShipRecord(session.characterID) ||
    (newbieShipResult && newbieShipResult.data && newbieShipResult.data.ship) ||
    refreshedCapsule;

  log.info(
    `[SpaceTransition] Rebuilt docked session for ${session.characterName || session.characterID} ${dockable.kind}=${dockable.locationID} ship=${activeShip && activeShip.itemID}`,
  );

  return {
    success: true,
    data: {
      station,
      capsule: refreshedCapsule,
      ship: activeShip,
      newbieShipResult,
      boundResult: buildBoundResult(session),
    },
  };
}

function jumpSessionToDockableLocation(session, locationID, options = {}) {
  const deathRestriction = buildShipDeathTransitionBlockedResult(session);
  if (deathRestriction) return deathRestriction;
  if (!session || !session.characterID) {
    return {
      success: false,
      errorMsg: "CHARACTER_NOT_SELECTED",
    };
  }
  const abyssalRestriction = buildActiveAbyssalTransitionBlockedResult(
    session,
    "station-jump",
  );
  if (abyssalRestriction) {
    return abyssalRestriction;
  }

  const targetLocationID = Number(locationID || 0);
  const dockable = resolveDockableLocation(targetLocationID);
  if (!dockable) {
    return {
      success: false,
      errorMsg: "STATION_NOT_FOUND",
    };
  }

  const activeShip = getActiveShipRecord(session.characterID);
  if (!activeShip) {
    return {
      success: false,
      errorMsg: "SHIP_NOT_FOUND",
    };
  }

  if (!beginTransition(session, "station-jump", targetLocationID)) {
    return {
      success: false,
      errorMsg: "STATION_JUMP_IN_PROGRESS",
    };
  }

  try {
    const sourceStationID = Number(session.stationid || session.stationID || 0);
    const sourceStructureID = Number(session.structureid || session.structureID || 0);
    const previousLocalChannelID = Number(
      session.solarsystemid2 ||
      session.solarsystemid ||
      session.stationid ||
      session.stationID ||
      0,
    ) || 0;

    if (session._space) {
      deactivateActiveModulesForSpaceTransition(session, "station-jump");
      spaceRuntime.detachSession(session, {
        broadcast: true,
        lifecycleReason: "station-jump",
      });
    }

    const dockResult = dockShipToLocation(
      activeShip.itemID,
      dockable.locationID,
    );
    if (!dockResult.success) {
      return dockResult;
    }

    // A move to the dock the pilot is already in is no leaving: its guests keep
    // the pilot, and the arrival below is not sent again to those who list it.
    if (sourceStationID && sourceStationID !== dockable.locationID) {
      broadcastOnCharNoLongerInStation(session, sourceStationID);
    } else if (sourceStructureID && sourceStructureID !== dockable.locationID) {
      broadcastOnCharacterLeftStructure(session, sourceStructureID);
    }

    const currentRecord = getCharacterRecord(session.characterID, {
      expectedLocationTransitionReason: "station-jump",
    });
    const authoritativeHomeStationID =
      Number(
        (currentRecord && (
          currentRecord.homeStationID ||
          currentRecord.cloneStationID
        )) ||
        session.homeStationID ||
        session.homestationid ||
        session.cloneStationID ||
        session.clonestationid ||
        0,
      ) || 0;

    const updateResult = updateCharacterRecord(session.characterID, (record) =>
      buildLocationIdentityPatch(record, dockable.solarSystemID, {
        homeStationID:
          authoritativeHomeStationID ||
          (dockable.kind === "station" ? dockable.locationID : 60003760),
        cloneStationID:
          Number(
            record.cloneStationID ||
            authoritativeHomeStationID ||
            (dockable.kind === "station" ? dockable.locationID : 60003760),
          ) || 60003760,
        stationID: dockable.kind === "station" ? dockable.locationID : null,
        structureID:
          dockable.kind === "structure" ? dockable.locationID : null,
        ...(options.jumpCloneActivationOperationID
          ? {
              jumpCloneActivationTransitionReceipt: {
                operationID: String(options.jumpCloneActivationOperationID),
                locationKind: dockable.kind,
                locationID: dockable.locationID,
              },
            }
          : {}),
      }),
      { expectedLocationTransitionReason: "station-jump" },
    );
    if (!updateResult.success) {
      return updateResult;
    }

    const applyResult = applyCharacterToSession(session, session.characterID, {
      emitNotifications: false,
      logSelection: true,
      selectionEvent: false,
      deferDockedShipSessionChange: false,
    });
    if (!applyResult.success) {
      return applyResult;
    }

    flushCharacterSessionNotificationPlan(
      session,
      dockable.kind === "structure"
        ? applyTqDockingTransitionSessionChangeShape(applyResult.notificationPlan)
        : applyResult.notificationPlan,
    );
    syncDockedShipTransitionForSession(session, dockResult, {
      locationContext: buildDockedShipLocationContext(
        dockable.kind,
        dockable.locationID,
      ),
    });

    queuePendingSessionEffects(session, {
      previousLocalChannelID,
    });
    flushPendingCommandSessionEffects(session);
    if (dockable.kind === "station") {
      broadcastOnCharNowInStation(session, dockable.locationID);
    } else {
      sendDockingFinished(session, dockable.locationID);
      broadcastOnCharacterEnteredStructure(session, dockable.locationID);
    }

    log.info(
      `[SpaceTransition] Dockable jump ${session.characterName || session.characterID} ship=${activeShip.itemID} location=${dockable.locationID} kind=${dockable.kind} system=${dockable.solarSystemID}`,
    );

    return {
      success: true,
      data: {
        station: dockable.record,
        boundResult: buildBoundResult(session),
      },
    };
  } finally {
    endTransition(session, "station-jump");
  }
}

function jumpSessionToStation(session, stationID, options = {}) {
  return jumpSessionToDockableLocation(session, stationID, options);
}

async function jumpSessionViaAnsiblex(session, sourceID, destinationID, solarSystemID, options = {}) {
  // Refused before the JumpOut goes out; the settlement refunds fee and fuel.
  const deathRestriction = buildShipDeathTransitionBlockedResult(session);
  if (deathRestriction) return deathRestriction;
  const sourceScene = spaceRuntime.getSceneForSession(session);
  if (!sourceScene || !session || !session._space) {
    return { success: false, errorMsg: "NOT_IN_SPACE" };
  }
  if (!beginTransition(session, "ansiblex-jump", sourceID)) {
    return { success: false, errorMsg: "SOLAR_JUMP_IN_PROGRESS" };
  }
  const generation = session._space;
  const transition = session._transitionState;
  const shipID = Number(generation.shipID);
  const canComplete = () => (
    session._space === generation && session._transitionState === transition &&
    !(session.socket && session.socket.destroyed) &&
    Number(sourceScene.getShipEntityForSession(session)?.itemID) === shipID
  );
  try {
    if (!canComplete()) return { success: false, errorMsg: "ANSIBLEX_JUMP_CANCELLED" };
    const commandSimTime = sourceScene.getCurrentSessionSimTimeMs(session);
    const start = spaceRuntime.startStargateJump(session, sourceID, { allowStructureGate: true });
    if (!start.success) return start;
    if (start.data?.resultSessionDelivered !== true) {
      return { success: false, errorMsg: "STARGATE_JUMP_FX_NOT_DELIVERED" };
    }
    // The source tick as a stargate jump reads it: null only when
    // the scene has no readable tick.
    const sourceDriver = sourceScene.destinyTickDriver;
    const deadline = buildStargateJumpHandoffDeadline(commandSimTime, start.data.stamp,
      sourceScene.getCurrentSessionSimTimeMs(session), {
        nextDestinyStamp: sourceScene.nextDestinyStamp,
        jumpOutTickSimTimeMs: sourceDriver && typeof sourceDriver.simTimeOfTick === "function"
          ? sourceDriver.simTimeOfTick(start.data.stamp)
          : null,
        simTimeMs: sourceScene.getCurrentSimTimeMs(),
      });
    if (!deadline) return { success: false, errorMsg: "STARGATE_JUMP_FX_STAMP_INVALID" };
    // Let the pilot execute JumpOut before retiring its source ballpark. The
    // same simulation-clock floors as NPC gates also preserve the tunnel in TiDi.
    // Eligibility and fuel escrow were checked before departure; once the
    // tunnel starts, only losing this pilot/ship generation cancels the handoff.
    while (canComplete()) {
      const now = sourceScene.getCurrentSessionSimTimeMs(session);
      if (!Number.isFinite(now)) break;
      const remaining = deadline.deadlineSimTimeMs - now;
      if (remaining <= 0) {
        // No async boundary between releasing our lock and taking solar-jump's.
        endTransition(session, "ansiblex-jump");
        return jumpSessionToSolarSystem(session, solarSystemID, {
          ...options, stargateJumpCloak: true, gateArrivalID: destinationID,
        });
      }
      await new Promise((resolve) => setTimeout(resolve,
        getStargateJumpHandoffWallclockDelayMs(remaining, sourceScene.getTimeDilation())));
    }
    return { success: false, errorMsg: "ANSIBLEX_JUMP_CANCELLED" };
  } finally {
    if (session._transitionState === transition) endTransition(session, "ansiblex-jump");
  }
}

async function jumpSessionToCynosuralBeacon(session, solarSystemID, options = {}) {
  const deathRestriction = buildShipDeathTransitionBlockedResult(session);
  if (deathRestriction) return deathRestriction;
  const abyssalRestriction = buildActiveAbyssalTransitionBlockedResult(session, "solar-system-jump");
  if (abyssalRestriction) return abyssalRestriction;

  const sourceScene = spaceRuntime.getSceneForSession(session);
  const sourceGeneration = session && session._space;
  if (!sourceScene || !sourceGeneration) return { success: false, errorMsg: "NOT_IN_SPACE" };
  const activeShip = getActiveShipRecord(session.characterID);
  const shipEntity = sourceScene.getShipEntityForSession(session);
  if (!activeShip || !shipEntity || Number(activeShip.itemID) !== Number(shipEntity.itemID)) {
    return { success: false, errorMsg: "SHIP_NOT_FOUND" };
  }
  const destinationSystemID = Number(solarSystemID || 0);
  if (isAbyssalHostLocationID(destinationSystemID) || !worldData.getSolarSystemByID(destinationSystemID)) {
    return { success: false, errorMsg: "SOLAR_SYSTEM_NOT_FOUND" };
  }
  if (!beginTransition(session, "cynosural-jump", destinationSystemID)) {
    return { success: false, errorMsg: "SOLAR_JUMP_IN_PROGRESS" };
  }

  const transitionState = session._transitionState;
  const characterID = session.characterID;
  const sourceSocket = session.socket;
  const shipID = Number(shipEntity.itemID);
  let departureQueued = false;
  let handoffCompleted = false;
  const hasExpectedSource = () => Boolean(
    session._space === sourceGeneration &&
    session._transitionState === transitionState &&
    session.characterID === characterID &&
    session.socket === sourceSocket &&
    !(session.socket && session.socket.destroyed) &&
    sourceScene.sessions.get(session.clientID) === session &&
    sourceScene.getShipEntityForSession(session) === shipEntity &&
    Number(getActiveShipRecord(characterID)?.itemID) === shipID
  );
  try {
    if (!hasExpectedSource()) return { success: false, errorMsg: "CYNO_JUMP_CANCELLED" };
    const shipType = resolveItemByTypeID(activeShip.typeID);
    const blackOps = Number(shipEntity.groupID || activeShip.groupID || (shipType && shipType.groupID)) === 898;
    const departureGuid = blackOps ? "effects.JumpDriveOutBO" : "effects.JumpDriveOut";
    const arrivalGuid = blackOps ? "effects.JumpDriveInBO" : "effects.JumpDriveIn";
    const commandSimTimeMs = sourceScene.getCurrentSessionSimTimeMs(session);

    // The ship's stop is a movement change like any other: it applies at the
    // next doPreTick, after every order queued before the jump, on the stamp
    // its Stop goes out with the JumpDriveOut.
    queueOrApplyMovementChange(
      sourceScene,
      shipEntity,
      "cynosuralJumpStop",
      sourceScene.getCurrentSimTimeMs(),
      () => {
        resetEntityMotion(shipEntity);
        seedBallSlots(shipEntity);
        persistShipEntity(shipEntity);
      },
    );
    // JumpDriveOut starts the native cyno tunnel and reads the destination
    // from graphicInfo[0]. A drive jump has no source gate target. It goes to
    // the ship's Grid bubble in the next tick's batch, the pilot's included.
    const departure = sourceScene.broadcastSpecialFx(shipID, departureGuid, {
      targetID: null,
      graphicInfo: { type: "tuple", items: [destinationSystemID, null] },
      start: true,
      active: false,
      duration: 5000,
      includeStopInSameUpdate: true,
    }, shipEntity);
    if (!departure || departure.resultSessionDelivered !== true) {
      return { success: false, errorMsg: "CYNO_JUMP_FX_NOT_DELIVERED" };
    }
    // Queued: the next doPostTick sends it, and from then on the pilot's
    // client hides the source ship and plays the tunnel.
    departureQueued = true;
    const sourceDriver = sourceScene.destinyTickDriver;
    const deadline = buildStargateJumpHandoffDeadline(commandSimTimeMs, departure.stamp,
      sourceScene.getCurrentSessionSimTimeMs(session), {
        nextDestinyStamp: sourceScene.nextDestinyStamp,
        jumpOutTickSimTimeMs: sourceDriver && typeof sourceDriver.simTimeOfTick === "function"
          ? sourceDriver.simTimeOfTick(departure.stamp)
          : null,
        simTimeMs: sourceScene.getCurrentSimTimeMs(),
      });
    if (!deadline) return { success: false, errorMsg: "CYNO_JUMP_FX_STAMP_INVALID" };
    if (typeof options.onDepartureAccepted === "function") options.onDepartureAccepted();
    if (typeof options.waitForTransferPermission === "function" &&
        await options.waitForTransferPermission() !== true) {
      return { success: false, errorMsg: "CYNO_GROUP_ANCHOR_FAILED" };
    }
    // Keep the source ballpark through the native departure sequence, using
    // the same simulation-clock floors and TiDi reslices as gate jumps. A ship
    // ordered to move after its stop applied has left the jump.
    while (hasExpectedSource()) {
      const nowMs = sourceScene.getCurrentSessionSimTimeMs(session);
      if (!Number.isFinite(nowMs)) break;
      const movementQueued = typeof sourceScene.hasQueuedMovementChange === "function" &&
        sourceScene.hasQueuedMovementChange(shipEntity);
      if (!movementQueued && shipEntity.mode !== "STOP") break;
      const remainingMs = deadline.deadlineSimTimeMs - nowMs;
      if (remainingMs <= 0) {
        const deathRestriction = buildShipDeathTransitionBlockedResult(session);
        if (deathRestriction) return deathRestriction;
        const abyssalRestriction = buildActiveAbyssalTransitionBlockedResult(session, "solar-system-jump");
        if (abyssalRestriction) return abyssalRestriction;
        if (!hasExpectedSource()) return { success: false, errorMsg: "CYNO_JUMP_CANCELLED" };
        const { beforeTransfer, ...transferOptions } = options;
        delete transferOptions.onDepartureAccepted;
        delete transferOptions.waitForTransferPermission;
        // Fuel is spent only after every source/deadline guard has passed.
        if (typeof beforeTransfer === "function") beforeTransfer();
        // Release and acquire the solar-transfer lock without an async gap.
        endTransition(session, "cynosural-jump");
        const transferResult = jumpSessionToSolarSystem(session, destinationSystemID, {
          ...transferOptions,
          cynosuralArrivalEffectGuid: arrivalGuid,
        });
        handoffCompleted = transferResult && transferResult.success === true;
        return transferResult;
      }
      await new Promise((resolve) => setTimeout(resolve,
        getStargateJumpHandoffWallclockDelayMs(remainingMs, sourceScene.getTimeDilation())));
    }
    return { success: false, errorMsg: "CYNO_JUMP_CANCELLED" };
  } finally {
    // A queued JumpDriveOut hides the source ship and starts the native tunnel
    // once it goes out. Without a completed handoff, reconnect is the recovery
    // boundary: the connection is closed, since clearing this server lock
    // cannot undo that client presentation. A stale operation leaves a
    // replacement connection or ballpark alone.
    if (departureQueued && !handoffCompleted &&
        session.socket === sourceSocket && session.characterID === characterID &&
        (session._space === sourceGeneration || !session._space) &&
        (!session._transitionState || session._transitionState === transitionState) &&
        sourceSocket && sourceSocket.destroyed !== true &&
        typeof sourceSocket.destroy === "function") {
      const error = new Error("CYNO_JUMP_DEPARTURE_ABORTED");
      error.code = "CYNO_JUMP_DEPARTURE_ABORTED";
      try {
        sourceSocket.destroy(error);
      } catch (_destroyError) {
        // ignored: the socket is already going
      }
    }
    if (session._transitionState === transitionState) endTransition(session, "cynosural-jump");
  }
}

// A cyno arrival's JumpDriveIn (or JumpDriveInBO), for a session just
// attached at the beacon. The observers of the arrival's Grid bubble get it in
// the next tick's bubble batch, after the ship's AddBalls. The pilot's client
// has no ballpark until its SetState, built when it binds, so its own
// JumpDriveIn follows that SetState (buildInitialBallparkUpdates), unless the
// SetState is built in the tick that sends this one.
function presentCynosuralArrival(session, shipID, guid) {
  if (!session || !session._space || (guid !== "effects.JumpDriveIn" && guid !== "effects.JumpDriveInBO")) {
    return;
  }
  const destinationScene = spaceRuntime.getSceneForSession(session);
  const arrivalEntity = destinationScene && destinationScene.getShipEntityForSession(session);
  const arrivalFx = arrivalEntity
    ? destinationScene.broadcastSpecialFx(arrivalEntity.itemID, guid, {
      start: true,
      active: false,
      duration: 5000,
    }, arrivalEntity)
    : null;
  session._space.pendingCynosuralArrivalEffect = {
    shipID,
    guid,
    stamp: arrivalFx && Number.isInteger(arrivalFx.stamp) ? arrivalFx.stamp : null,
  };
}

function jumpSessionToSolarSystem(session, solarSystemID, options = {}) {
  const deathRestriction = buildShipDeathTransitionBlockedResult(session);
  if (deathRestriction) return deathRestriction;
  if (!session || !session.characterID) {
    return {
      success: false,
      errorMsg: "CHARACTER_NOT_SELECTED",
    };
  }
  const abyssalRestriction = buildActiveAbyssalTransitionBlockedResult(
    session,
    "solar-system-jump",
  );
  if (abyssalRestriction) {
    return abyssalRestriction;
  }

  const targetSolarSystemID = Number(solarSystemID || 0);
  const { isVoidSystemID } = require("../services/activity/voidReplayAdmission");
  const replayTransfer = isVoidSystemID(targetSolarSystemID) ||
      isVoidSystemID(Number(session._space?.systemID || session.solarsystemid2))
    ? require("../services/activity/voidReplayRuntime").authorizeTransfer(
      session, targetSolarSystemID, options.voidReplayInstanceID,
    )
    : null;
  if (replayTransfer === false) return { success: false, errorMsg: "VOID_REPLAY_DESTINATION_FORBIDDEN" };
  if (isAbyssalHostLocationID(targetSolarSystemID)) {
    return {
      success: false,
      errorMsg: "ABYSSAL_DESTINATION_FORBIDDEN",
      data: {
        action: "solar-system-jump",
        destinationSystemID: targetSolarSystemID,
      },
    };
  }
  const system = worldData.getSolarSystemByID(targetSolarSystemID);
  if (!system) {
    return {
      success: false,
      errorMsg: "SOLAR_SYSTEM_NOT_FOUND",
    };
  }

  const activeShip = getActiveShipRecord(session.characterID);
  if (!activeShip) {
    return {
      success: false,
      errorMsg: "SHIP_NOT_FOUND",
    };
  }

  // A jump to the system the pilot is already flying in has nothing to do, and
  // running the teardown anyway actively breaks the session: the re-anchor at
  // the arrival stargate silently discards movement already in flight, and
  // because the solar system never changes no SessionChange packet fires, so
  // the client never re-binds beyonce, the server waits forever for that bind,
  // and initialStateSent stays false -- which makes every destiny send path
  // early-return and leaves the ship frozen. Bail out before beginTransition so
  // the no-op does not even take the transition lock.
  //
  // spawnStateOverride is the safety valve. This is the shared path for
  // wormholes, cyno beacons, jump bridges, conduits, abyssal and dungeon
  // entries as well as the /tr chat command, and every caller that needs to
  // land the pilot at a specific place inside the destination passes an
  // override -- so a same-system move with one is legitimate and must proceed.
  // Docked pilots are excluded too: a /tr from inside a station in that same
  // system is a real move into space.
  if (
    session._space &&
    Number(session._space.systemID || 0) === targetSolarSystemID &&
    !options.spawnStateOverride &&
    !Number(session.stationid || session.stationID || 0) &&
    !Number(session.structureid || session.structureID || 0)
  ) {
    return {
      success: true,
      data: {
        solarSystem: system,
        ship: activeShip,
        spawnState: null,
        boundResult: buildBoundResult(session),
        alreadyInSystem: true,
      },
    };
  }

  if (!beginTransition(session, "solar-jump", targetSolarSystemID)) {
    return {
      success: false,
      errorMsg: "SOLAR_JUMP_IN_PROGRESS",
    };
  }

  try {
    const destinationSceneAlreadyLoaded = Boolean(
      spaceRuntime &&
        spaceRuntime.scenes instanceof Map &&
        spaceRuntime.scenes.has(targetSolarSystemID),
    );
    const sourceStationID = Number(session.stationid || session.stationID || 0);
    const sourceStructureID = Number(session.structureid || session.structureID || 0);
    const wasInSpace = Boolean(session._space);
    const sourceSimTimeMs = wasInSpace
      ? spaceRuntime.getSimulationTimeMsForSession(session, null)
      : null;
    const sourceTimeDilation = wasInSpace
      ? spaceRuntime.getSolarSystemTimeDilation(session._space.systemID)
      : null;
    const sourceClockCapturedAtWallclockMs = wasInSpace ? Date.now() : null;
    if (typeof spaceRuntime.beginSessionJumpTimingTrace === "function") {
      spaceRuntime.beginSessionJumpTimingTrace(session, "solar-jump", {
        sourceSystemID:
          wasInSpace && session && session._space
            ? Number(session._space.systemID || 0) || null
            : null,
        destinationSystemID: targetSolarSystemID,
        sourceSimTimeMs,
        sourceTimeDilation,
        sourceClockCapturedAtWallclockMs,
        shipID: activeShip.itemID,
      });
    }
    const previousLocalChannelID = Number(
      session.solarsystemid2 ||
      session.solarsystemid ||
      getDockedLocationID(session) ||
      0,
    ) || 0;
    const spawnState = options.spawnStateOverride || buildSolarSystemSpawnState(targetSolarSystemID);
    if (!spawnState) {
      return {
        success: false,
        errorMsg: "SOLAR_SYSTEM_NOT_FOUND",
      };
    }

    if (wasInSpace) {
      deactivateActiveModulesForSpaceTransition(session, "solar-jump");
      spaceRuntime.detachSession(session, {
        broadcast: true,
        lifecycleReason: "solar-jump",
      });
    }

    const targetSpaceState = {
      position: spawnState.position,
      direction: spawnState.direction,
      velocity: { x: 0, y: 0, z: 0 },
      speedFraction: 0,
      mode: "STOP",
      targetPoint: spawnState.position,
      ...(options.jumpBridgeSettlementReceipt
        ? {
            jumpBridgeTransitionReceipt: {
              ...options.jumpBridgeSettlementReceipt,
            },
          }
        : {}),
    };
    const moveResult = replayTransfer
      ? moveShipToSpaceIdempotent(activeShip.itemID, targetSolarSystemID, targetSpaceState, replayTransfer)
      : moveShipToSpace(activeShip.itemID, targetSolarSystemID, targetSpaceState);
    if (!moveResult.success) {
      return moveResult;
    }

    syncInventoryItemForSession(
      session,
      moveResult.data,
      {
        locationID: moveResult.previousData.locationID,
        flagID: moveResult.previousData.flagID,
        quantity: moveResult.previousData.quantity,
        singleton: moveResult.previousData.singleton,
        stacksize: moveResult.previousData.stacksize,
      },
      {
        emitCfgLocation: false,
      },
    );

    if (sourceStationID) {
      broadcastOnCharNoLongerInStation(session, sourceStationID);
    } else if (sourceStructureID) {
      broadcastOnCharacterLeftStructure(session, sourceStructureID);
    }

    const updateResult = updateCharacterRecord(session.characterID, (record) =>
      buildLocationIdentityPatch(record, targetSolarSystemID, {
        ...(sourceStationID
          ? {
              homeStationID:
                Number(record.homeStationID || record.cloneStationID || sourceStationID) ||
                sourceStationID,
              cloneStationID:
                Number(record.cloneStationID || record.homeStationID || sourceStationID) ||
                sourceStationID,
            }
          : {}),
        stationID: null,
        structureID: null,
        ...(options.jumpBridgeSettlementReceipt
          ? {
              jumpBridgeTransitionReceipt: {
                ...options.jumpBridgeSettlementReceipt,
              },
            }
          : {}),
      }),
      { expectedLocationTransitionReason: "solar-system-jump" },
    );
    if (!updateResult.success) {
      return updateResult;
    }

    const applyResult = applyCharacterToSession(session, session.characterID, {
      emitNotifications: false,
      logSelection: true,
      selectionEvent: false,
    });
    if (!applyResult.success) {
      return applyResult;
    }

    const attachedShip = spaceRuntime.attachSession(session, moveResult.data, {
      systemID: targetSolarSystemID,
      beyonceBound: false,
      pendingUndockMovement: false,
      spawnStopped: true,
      stargateJumpCloak: options.stargateJumpCloak === true,
      stargateJumpCloakDurationMs: options.stargateJumpCloakDurationMs,
      broadcast: true,
      emitSimClockRebase: false,
      previousSimTimeMs: sourceSimTimeMs,
      initialBallparkPreviousSimTimeMs: sourceSimTimeMs,
      initialBallparkPreviousTimeDilation: sourceTimeDilation,
      initialBallparkPreviousCapturedAtWallclockMs: sourceClockCapturedAtWallclockMs,
      deferInitialBallparkStateUntilBind: true,
      deferUniverseSiteReconcile: true,
      universeSiteReconcileReason: "solar-jump",
    });
    if (replayTransfer && (!attachedShip || !require("../gameStore").flushTableSync("characters").success)) {
      return { success: false, errorMsg: "VOID_REPLAY_TRANSFER_PENDING" };
    }
    presentCynosuralArrival(session, moveResult.data.itemID, options.cynosuralArrivalEffectGuid);
    if (options.gateArrivalID) {
      spaceRuntime.emitStargateArrivalObserverFx(session, options.gateArrivalID,
        moveResult.data.itemID, { allowStructureGate: true });
    }
    if (typeof spaceRuntime.recordSessionJumpTimingTrace === "function") {
      spaceRuntime.recordSessionJumpTimingTrace(session, "solar-jump-attached", {
        destinationSystemID: targetSolarSystemID,
        shipID: moveResult.data && moveResult.data.itemID,
        spawnState,
      });
    }
    queuePostSpaceAttachFittingHydration(
      session,
      moveResult.data && moveResult.data.itemID,
      {
        inventoryBootstrapPending: false,
        hydrationProfile: options.gateArrivalID ? "stargate" : destinationSceneAlreadyLoaded ? "solarWarm" : "solar",
      },
    );
    flushCharacterSessionNotificationPlan(session, applyResult.notificationPlan);
    queuePendingSessionEffects(session, {
      awaitBeyonceBoundBallpark: true,
      previousLocalChannelID,
    });
    flushPendingCommandSessionEffects(session);

    log.info(
      `[SpaceTransition] Solar jump ${session.characterName || session.characterID} ship=${activeShip.itemID} system=${targetSolarSystemID} anchor=${spawnState.anchorType}:${spawnState.anchorID} warmScene=${destinationSceneAlreadyLoaded}`,
    );

    // Advance the "Complete N Jumps" AIR daily goal. This is the shared path for
    // every non-stargate system change (wormhole, jump bridge, titan bridge,
    // cyno, conduit); stargates keep their own hook in completeStargateJump and
    // do not route through here, so there is no double count. Callers that are
    // not player jumps -- GM transport commands, sov auto-navigation -- opt out
    // with countsTowardJumpGoal:false. Defensive so daily-goal bookkeeping can
    // never disrupt the jump.
    if (options.countsTowardJumpGoal !== false) {
      try {
        require(path.join(
          __dirname,
          "../services/dailyGoals/dailyGoalsState",
        )).recordActivity(session.characterID, "space_jump", 1);
      } catch (dailyGoalError) {
        log.debug(
          `[SpaceTransition] daily-goal space_jump hook failed char=${session.characterID}: ${dailyGoalError.message}`,
        );
      }
    }

    return {
      success: true,
      data: {
        solarSystem: system,
        ship: moveResult.data,
        spawnState,
        boundResult: buildBoundResult(session),
      },
    };
  } finally {
    endTransition(session, "solar-jump");
  }
}

function jumpSessionToShipCloneBay(session, targetShipID, options = {}) {
  const deathRestriction = buildShipDeathTransitionBlockedResult(session);
  if (deathRestriction) return deathRestriction;
  if (!session || !session.characterID) {
    return {
      success: false,
      errorMsg: "CHARACTER_NOT_SELECTED",
    };
  }
  const abyssalRestriction = buildActiveAbyssalTransitionBlockedResult(
    session,
    "ship-clone-bay-jump",
  );
  if (abyssalRestriction) {
    return abyssalRestriction;
  }

  const targetItemID = Number(targetShipID || 0) || 0;
  if (!targetItemID) {
    return {
      success: false,
      errorMsg: "SHIP_NOT_FOUND",
    };
  }

  const targetShip = findItemById(targetItemID);
  if (!targetShip || Number(targetShip.categoryID || 0) !== 6) {
    return {
      success: false,
      errorMsg: "SHIP_NOT_FOUND",
    };
  }

  const targetSystemID =
    Number(targetShip.spaceState && targetShip.spaceState.systemID) ||
    Number(targetShip.locationID || 0) ||
    0;
  if (!targetSystemID || !targetShip.spaceState) {
    return {
      success: false,
      errorMsg: "SHIP_NOT_IN_SPACE",
    };
  }
  // Before the capsule swap below, the first change this jump makes.

  let activeShip = getActiveShipRecord(session.characterID);
  if (!activeShip) {
    return {
      success: false,
      errorMsg: "SHIP_NOT_FOUND",
    };
  }

  if (!isCapsuleTypeID(activeShip.typeID)) {
    if (!isDockedSession(session)) {
      return {
        success: false,
        errorMsg: "PILOT_NOT_IN_CAPSULE",
      };
    }
    const dockedLocationID = getDockedLocationID(session);
    const capsuleResult = resolveReusableCapsuleForCharacter(
      session.characterID,
      activeShip.itemID,
      Number(session.solarsystemid2 || session.solarsystemid || targetSystemID) ||
        targetSystemID,
      dockedLocationID ||
        session.homeStationID ||
        session.cloneStationID ||
        60003760,
    );
    if (!capsuleResult.success || !capsuleResult.data) {
      return {
        success: false,
        errorMsg: capsuleResult.errorMsg || "CAPSULE_NOT_FOUND",
      };
    }
    const activeShipResult = setActiveShipForCharacter(
      session.characterID,
      capsuleResult.data.itemID,
    );
    if (!activeShipResult.success) {
      return activeShipResult;
    }
    activeShip = capsuleResult.data;
  }

  if (!beginTransition(session, "clone-vat-jump", targetItemID)) {
    return {
      success: false,
      errorMsg: "CLONE_VAT_JUMP_IN_PROGRESS",
    };
  }

  try {
    const sourceStationID = Number(session.stationid || session.stationID || 0);
    const sourceStructureID = Number(
      session.structureid || session.structureID || 0,
    );
    const wasInSpace = Boolean(session._space);
    const sourceSimTimeMs = wasInSpace
      ? spaceRuntime.getSimulationTimeMsForSession(session, null)
      : null;
    const sourceTimeDilation = wasInSpace
      ? spaceRuntime.getSolarSystemTimeDilation(session._space.systemID)
      : null;
    const sourceClockCapturedAtWallclockMs = wasInSpace ? Date.now() : null;
    const previousLocalChannelID =
      Number(
        session.solarsystemid2 ||
          session.solarsystemid ||
          getDockedLocationID(session) ||
          0,
      ) || 0;

    const scene = spaceRuntime.ensureScene(targetSystemID);
    let targetEntity = scene ? scene.getEntityByID(targetItemID) : null;
    if (!targetEntity && targetShip.spaceState) {
      const spawnResult = spaceRuntime.spawnDynamicInventoryEntity(
        targetSystemID,
        targetItemID,
        {
          broadcastOptions: {
            freshAcquire: false,
          },
        },
      );
      if (spawnResult && spawnResult.success && spawnResult.data) {
        targetEntity = spawnResult.data.entity || null;
      }
    }
    const spawnState = buildCloneVatArrivalSpaceState(targetShip, targetEntity);

    if (typeof spaceRuntime.beginSessionJumpTimingTrace === "function") {
      spaceRuntime.beginSessionJumpTimingTrace(session, "clone-vat-jump", {
        sourceSystemID:
          wasInSpace && session._space
            ? Number(session._space.systemID || 0) || null
            : null,
        destinationSystemID: targetSystemID,
        targetShipID: targetItemID,
        sourceSimTimeMs,
        sourceTimeDilation,
        sourceClockCapturedAtWallclockMs,
        shipID: activeShip.itemID,
      });
    }

    if (wasInSpace) {
      deactivateActiveModulesForSpaceTransition(session, "clone-vat-jump");
      spaceRuntime.detachSession(session, {
        broadcast: true,
        lifecycleReason: "clone-vat-jump",
      });
    }

    const moveResult = moveShipToSpace(
      activeShip.itemID,
      targetSystemID,
      spawnState,
    );
    if (!moveResult.success) {
      return moveResult;
    }

    syncInventoryItemForSession(
      session,
      moveResult.data,
      {
        locationID: moveResult.previousData.locationID,
        flagID: moveResult.previousData.flagID,
        quantity: moveResult.previousData.quantity,
        singleton: moveResult.previousData.singleton,
        stacksize: moveResult.previousData.stacksize,
      },
      {
        emitCfgLocation: false,
      },
    );

    if (sourceStationID) {
      broadcastOnCharNoLongerInStation(session, sourceStationID);
    } else if (sourceStructureID) {
      broadcastOnCharacterLeftStructure(session, sourceStructureID);
    }

    const updateResult = updateCharacterRecord(session.characterID, (record) =>
      buildLocationIdentityPatch(record, targetSystemID, {
        ...(sourceStationID
          ? {
              homeStationID:
                Number(
                  record.homeStationID ||
                    record.cloneStationID ||
                    sourceStationID,
                ) || sourceStationID,
              cloneStationID:
                Number(
                  record.cloneStationID ||
                    record.homeStationID ||
                    sourceStationID,
                ) || sourceStationID,
            }
          : {}),
        stationID: null,
        structureID: null,
        ...(options.jumpCloneActivationOperationID
          ? {
              jumpCloneActivationTransitionReceipt: {
                operationID: String(options.jumpCloneActivationOperationID),
                locationKind: "ship",
                locationID: targetItemID,
              },
            }
          : {}),
      }),
      { expectedLocationTransitionReason: "ship-clone-bay-jump" },
    );
    if (!updateResult.success) {
      return updateResult;
    }

    clearDeferredDockedShipSessionChange(session);
    clearDockedFittingBootstrap(session);

    const applyResult = applyCharacterToSession(session, session.characterID, {
      emitNotifications: false,
      logSelection: true,
      selectionEvent: false,
      deferDockedShipSessionChange: false,
    });
    if (!applyResult.success) {
      return applyResult;
    }

    spaceRuntime.attachSession(session, moveResult.data, {
      systemID: targetSystemID,
      beyonceBound: false,
      pendingUndockMovement: false,
      spawnStopped: true,
      broadcast: true,
      emitSimClockRebase: false,
      previousSimTimeMs: sourceSimTimeMs,
      initialBallparkPreviousSimTimeMs: sourceSimTimeMs,
      initialBallparkPreviousTimeDilation: sourceTimeDilation,
      initialBallparkPreviousCapturedAtWallclockMs:
        sourceClockCapturedAtWallclockMs,
      deferInitialBallparkStateUntilBind: true,
      deferUniverseSiteReconcile: true,
      universeSiteReconcileReason: "clone-vat-jump",
    });
    if (typeof spaceRuntime.recordSessionJumpTimingTrace === "function") {
      spaceRuntime.recordSessionJumpTimingTrace(
        session,
        "clone-vat-jump-attached",
        {
          destinationSystemID: targetSystemID,
          targetShipID: targetItemID,
          shipID: moveResult.data && moveResult.data.itemID,
          spawnState,
        },
      );
    }

    queuePostSpaceAttachFittingHydration(
      session,
      moveResult.data && moveResult.data.itemID,
      {
        inventoryBootstrapPending: false,
        hydrationProfile: "cloneVat",
      },
    );
    flushCharacterSessionNotificationPlan(session, applyResult.notificationPlan, {
      sessionChangeOptions: buildSolarSessionChangeOptions(
        session,
        targetSystemID,
      ),
    });
    queuePendingSessionEffects(session, {
      awaitBeyonceBoundBallpark: true,
      previousLocalChannelID,
    });
    flushPendingCommandSessionEffects(session);

    log.info(
      `[SpaceTransition] Clone-vat jump ${
        session.characterName || session.characterID
      } capsule=${moveResult.data.itemID} targetShip=${targetItemID} system=${targetSystemID}`,
    );

    return {
      success: true,
      data: {
        ship: moveResult.data,
        targetShip,
        targetEntity,
        spawnState,
        boundResult: buildBoundResult(session),
      },
    };
  } finally {
    endTransition(session, "clone-vat-jump");
  }
}

module.exports = {
  buildBoundResult,
  buildSolarSystemSpawnState,
  undockSession,
  dockSession,
  restoreSpaceSession,
  ejectSession,
  ejectSessionForShipDestruction,
  boardSpaceShip,
  getStrategicCruiserTransitionUseError,
  jumpSessionViaStargate,
  jumpSessionViaAnsiblex,
  rebuildDockedSessionAtStation,
  jumpSessionToDockableLocation,
  jumpSessionToStation,
  jumpSessionToShipCloneBay,
  jumpSessionToCynosuralBeacon,
  jumpSessionToSolarSystem,
  repairSameSceneSessionViewState,
};
module.exports._testing = {
  setTransitionIDProviderForTesting(provider) {
    const previous = transitionIDProvider;
    transitionIDProvider = provider;
    return () => { transitionIDProvider = previous; };
  },
  buildActiveAbyssalTransitionBlockedResult,
  buildBoundResultForTesting: buildBoundResult,
  buildGateSpawnState,
  buildStargateJumpHandoffDeadline,
  completeStargateJumpForTesting: completeStargateJump,
  presentCynosuralArrivalForTesting: presentCynosuralArrival,
  clearStargateJumpQueuesForTesting() {
    stargateJumpQueuesByDestination.clear();
  },
  getResolvedStargateForwardDirection,
  getStargateJumpHandoffWallclockDelayMs,
  recordStargateJumpQueueEntryForTesting: recordStargateJumpQueueEntry,
  getSurfaceDistanceBetweenEntities,
  repairSameSceneSessionViewState,
  sendJumpQueueUpdateForTesting: sendJumpQueueUpdate,
};
