"use strict";

const {
  toFiniteNumber,
} = require("../../common/numbers");

const path = require("path");
const log = require(path.join(__dirname, "../../utils/logger"));

const dungeonAuthority = require(path.join(__dirname, "./dungeonAuthority"));
const dungeonRuntime = require(path.join(__dirname, "./dungeonRuntime"));
const dungeonVisibilityPolicy = require(path.join(
  __dirname,
  "./dungeonVisibilityPolicy",
));
const { buildDict, buildKeyVal } = require(path.join(__dirname, "../_shared/serviceHelpers"));
const { resolveSessionCharacterID } = require("../_shared/sessionIdentity");
const {
  entityIDsEqual,
  normalizePersistentEntityID,
} = require(path.join(
  __dirname,
  "../../space/destiny/identity/entityID.js",
));

const SITE_ENTRY_INFERENCE_RANGE_METERS = 1_000_000;
const SITE_ENTRY_INFERENCE_RANGE_SQUARED =
  SITE_ENTRY_INFERENCE_RANGE_METERS ** 2;
const SAME_ROOM_WARP_PRESERVE_RANGE_METERS = 1_000_000;
const SAME_ROOM_WARP_PRESERVE_RANGE_SQUARED =
  SAME_ROOM_WARP_PRESERVE_RANGE_METERS ** 2;
// Ephemeral visit identity also distinguishes A -> B -> A before a queued send.
const roomVisitsByShip = new WeakMap();
const { WARP_TRANSMISSION_RECEIPT } = require("../../space/destiny/commands/warpTransmissionReceipt");
const acceptedWarpTransmissions = new WeakMap();

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function normalizeText(value, fallback = "") {
  const normalized = String(value == null ? "" : value).trim();
  return normalized || fallback;
}

function normalizeLowerText(value, fallback = "") {
  return normalizeText(value, fallback).toLowerCase();
}

function hasIdentityValue(value) {
  return (
    value !== null &&
    value !== undefined &&
    String(value).trim() !== ""
  );
}

function resolveExactPersistentIdentity(values) {
  let resolved = null;
  for (const value of Array.isArray(values) ? values : []) {
    if (!hasIdentityValue(value)) {
      continue;
    }
    const candidate = normalizePersistentEntityID(value);
    if (candidate === null) {
      return null;
    }
    if (resolved !== null && !entityIDsEqual(resolved, candidate)) {
      return null;
    }
    resolved = candidate;
  }
  return resolved;
}

function clonePosition(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  return {
    x: toFiniteNumber(value.x, 0),
    y: toFiniteNumber(value.y, 0),
    z: toFiniteNumber(value.z, 0),
  };
}

function positionTuple(value) {
  const position = clonePosition(value);
  if (!position) {
    return null;
  }
  return [position.x, position.y, position.z];
}

function distanceSquared(left, right) {
  const leftPosition = clonePosition(left);
  const rightPosition = clonePosition(right);
  if (!leftPosition || !rightPosition) {
    return Number.POSITIVE_INFINITY;
  }
  return (
    ((leftPosition.x - rightPosition.x) ** 2) +
    ((leftPosition.y - rightPosition.y) ** 2) +
    ((leftPosition.z - rightPosition.z) ** 2)
  );
}

function isActiveDungeonInstance(instance) {
  return (
    instance &&
    ["seeded", "active", "paused"].includes(
      normalizeLowerText(instance.lifecycleState, "seeded"),
    )
  );
}

function isTrackedDungeonInstance(instance) {
  return (
    instance &&
    ["seeded", "active", "paused", "completed"].includes(
      normalizeLowerText(instance.lifecycleState, "seeded"),
    )
  );
}

function resolveTemplate(instance) {
  const templateID = normalizeText(instance && instance.templateID, "");
  return templateID ? dungeonAuthority.getTemplateByID(templateID) : null;
}

function resolveDungeonID(instance, template = null) {
  return Math.max(
    0,
    toInt(instance && instance.sourceDungeonID, 0),
    toInt(instance && instance.metadata && instance.metadata.sourceDungeonID, 0),
    toInt(instance && instance.metadata && instance.metadata.dungeonID, 0),
    toInt(template && template.sourceDungeonID, 0),
    toInt(template && template.dungeonID, 0),
  );
}

function resolveRoomID(roomKey, roomState = null) {
  const explicitRoomID = Math.max(
    0,
    toInt(roomState && roomState.pocketID, 0),
    toInt(roomState && roomState.roomID, 0),
  );
  if (explicitRoomID > 0) {
    return explicitRoomID;
  }
  const normalizedRoomKey = normalizeText(roomKey, "");
  const match = normalizedRoomKey.match(/(\d+)$/);
  return match ? Math.max(0, toInt(match[1], 0)) : 0;
}

function resolveRoomState(instance, roomKey) {
  const roomStatesByKey =
    instance &&
    instance.roomStatesByKey &&
    typeof instance.roomStatesByKey === "object"
      ? instance.roomStatesByKey
      : {};
  return roomStatesByKey[normalizeText(roomKey, "")] || null;
}

function buildDungeonValues(instance, roomKey, options = {}) {
  if (require("../homefront/homefrontHooks").runtime.isSite(instance)) {
    return require("../homefront/homefrontHooks").client.values(instance);
  }
  const caldariValues = require("./visionsCaldariRuntime").values(instance,
    options.template || resolveTemplate(instance), options.scene, options.session);
  if (caldariValues) return buildDict(Object.entries(caldariValues));
  const fracturedValues = require("./fracturedLegacyRuntime").buildValues(instance,
    options.template || resolveTemplate(instance));
  if (fracturedValues) return buildDict(Object.entries(fracturedValues));
  // Sites whose client objective chain reads a wave counter carry current_wave/total_waves.
  const template = options.template || null;
  const waveValues =
    template &&
    template.clientObjectives &&
    toInt(template.clientObjectives.objectiveChainID, 0) > 0
      ? require("./dungeonUniverseSiteService").buildClientWaveValues(instance, { template })
      : null;
  // The build-3396210 client immediately calls iteritems() on dungeon_values.
  // Keep this a real Python dict shape, empty when the site has no values to send.
  return buildDict(waveValues ? Object.entries(waveValues) : []);
}

function buildCurrentDungeonInfo(instance, roomKey, options = {}) {
  const template = options.template || resolveTemplate(instance);
  const dungeonID = resolveDungeonID(instance, template);
  if (dungeonID <= 0 || !instance) {
    return null;
  }
  const normalizedRoomKey = normalizeText(roomKey, "room:entry");
  const roomState = resolveRoomState(instance, normalizedRoomKey);
  return [
    dungeonID,
    resolveRoomID(normalizedRoomKey, roomState),
    Math.max(0, toInt(instance.instanceID, 0)),
    buildDungeonValues(instance, normalizedRoomKey, { ...options, template }),
  ];
}

function getShipEntityForSession(scene, session) {
  if (!scene || !session) {
    return null;
  }
  if (typeof scene.getShipEntityForSession === "function") {
    return scene.getShipEntityForSession(session);
  }
  const shipID = Math.max(0, toInt(session.shipID, toInt(session.shipid, 0)));
  if (shipID > 0 && typeof scene.getEntityByID === "function") {
    return scene.getEntityByID(shipID);
  }
  return null;
}

function markShipCurrentDungeonRoom(shipEntity, instance, roomKey, options = {}) {
  if (!shipEntity || !instance) {
    return false;
  }
  const normalizedRoomKey = normalizeText(roomKey, "room:entry");
  const template = options.template || resolveTemplate(instance);
  const dungeonID = resolveDungeonID(instance, template);
  const instanceID = Math.max(0, toInt(instance.instanceID, 0));
  if (instanceID <= 0) {
    return false;
  }
  const roomID = resolveRoomID(normalizedRoomKey, resolveRoomState(instance, normalizedRoomKey));
  const previousInstanceID = Math.max(0, toInt(shipEntity.dungeonCurrentInstanceID, 0));
  const previousRoomKey = normalizeText(shipEntity.dungeonCurrentRoomKey, "");
  const changed =
    previousInstanceID !== instanceID ||
    previousRoomKey !== normalizedRoomKey;
  if (changed) {
    roomVisitsByShip.set(shipEntity, {});
  }
  if (previousInstanceID !== instanceID) {
    delete shipEntity.dungeonCompletedNotifiedInstanceID;
  }

  shipEntity.dungeonCurrentInstanceID = instanceID;
  if (dungeonID > 0) {
    shipEntity.dungeonCurrentDungeonID = dungeonID;
  } else {
    delete shipEntity.dungeonCurrentDungeonID;
  }
  shipEntity.dungeonCurrentRoomKey = normalizedRoomKey;
  shipEntity.dungeonCurrentRoomID = roomID;
  const hasExplicitSiteID = Object.hasOwn(options, "siteID") &&
    hasIdentityValue(options.siteID);
  shipEntity.dungeonCurrentSiteID = normalizePersistentEntityID(
    hasExplicitSiteID
      ? options.siteID
      : instance && instance.metadata && instance.metadata.siteID,
  );
  shipEntity.dungeonCurrentRoomPosition = positionTuple(options.roomPosition) || null;
  shipEntity.dungeonCurrentUpdatedAtMs = Math.max(0, toInt(options.nowMs, Date.now()));
  return changed;
}

function resolveTrackedDungeonForShip(shipEntity, options = {}) {
  const instanceID = Math.max(0, toInt(shipEntity && shipEntity.dungeonCurrentInstanceID, 0));
  if (instanceID <= 0) {
    return null;
  }
  const instance = dungeonRuntime.getInstance(instanceID);
  if (!isTrackedDungeonInstance(instance)) {
    return null;
  }
  const expectedSystemID = Math.max(0, toInt(options.solarSystemID, 0));
  if (expectedSystemID > 0 && Math.max(0, toInt(instance.solarSystemID, 0)) !== expectedSystemID) {
    return null;
  }
  return {
    instance,
    roomKey: normalizeText(shipEntity.dungeonCurrentRoomKey, "room:entry"),
  };
}

function resolveSiteEntityInstance(scene, siteEntity) {
  const instanceID = Math.max(
    0,
    toInt(
      siteEntity && (
        siteEntity.dungeonSiteInstanceID ||
        siteEntity.dungeonInstanceID ||
        siteEntity.instanceID
      ),
      0,
    ),
  );
  if (instanceID <= 0) {
    return null;
  }
  const instance = dungeonRuntime.getInstance(instanceID);
  return isActiveDungeonInstance(instance) ? instance : null;
}

function inferEntryDungeonForShip(scene, shipEntity, session = null) {
  if (!scene || !shipEntity) {
    return null;
  }
  const shipPosition = clonePosition(shipEntity.position);
  if (!shipPosition) {
    return null;
  }
  let nearest = null;
  let nearestDistanceSquared = Number.POSITIVE_INFINITY;
  for (const entity of Array.isArray(scene.staticEntities) ? scene.staticEntities : []) {
    if (
      !entity ||
      (
        entity.signalTrackerUniverseSeededSite !== true &&
        normalizeText(entity.kind, "") !== "missionSite"
      )
    ) {
      continue;
    }
    const candidateDistanceSquared = distanceSquared(shipPosition, entity.position);
    if (
      candidateDistanceSquared > SITE_ENTRY_INFERENCE_RANGE_SQUARED ||
      candidateDistanceSquared >= nearestDistanceSquared
    ) {
      continue;
    }
    const instance = resolveSiteEntityInstance(scene, entity);
    if (!instance) {
      continue;
    }
    if (session) {
      if (!dungeonVisibilityPolicy.resolveDungeonInstanceVisibilityForSession(
        session,
        instance.instanceID,
        { systemID: scene.systemID },
      )) {
        continue;
      }
    }
    nearest = {
      instance,
      roomKey: "room:entry",
      siteID: normalizePersistentEntityID(entity.itemID),
      roomPosition: entity.position || null,
    };
    nearestDistanceSquared = candidateDistanceSquared;
  }
  return nearest;
}

function resolveAuthorizedTrackedDungeonForSession(scene, session, shipEntity) {
  const tracked = resolveTrackedDungeonForShip(shipEntity, {
    solarSystemID: scene && scene.systemID,
  });
  if (!tracked) {
    return null;
  }
  const authorized = dungeonVisibilityPolicy.canSessionAccessDungeonInstance(
    session,
    tracked.instance,
  );
  return authorized
    ? {
        ...tracked,
      }
    : null;
}

function resolveCurrentDungeonForSession(scene, session) {
  const shipEntity = getShipEntityForSession(scene, session);
  if (!shipEntity) {
    return null;
  }
  return (
    resolveAuthorizedTrackedDungeonForSession(scene, session, shipEntity) ||
    inferEntryDungeonForShip(scene, shipEntity, session)
  );
}

function resolveTrackedDungeonForSession(scene, session) {
  const shipEntity = getShipEntityForSession(scene, session);
  if (!shipEntity) {
    return null;
  }
  const tracked = resolveAuthorizedTrackedDungeonForSession(
    scene,
    session,
    shipEntity,
  );
  return tracked
    ? {
        ...tracked,
        shipEntity,
      }
    : null;
}

function resolveCurrentDungeonInfoForSession(scene, session) {
  const current = resolveCurrentDungeonForSession(scene, session);
  return current
    ? buildCurrentDungeonInfo(current.instance, current.roomKey, { scene, session })
    : null;
}

// The space runtime, loaded on first use: its scenes load this module.
function getSpaceRuntime() {
  return require(path.join(__dirname, "../../space/runtime"));
}

// The scene `session` is an Observer of (its `sessions` holds this session,
// as afterDestinyBatch's run checks), or null.
function getObservedScene(session) {
  const runtime = getSpaceRuntime();
  const scene = runtime && typeof runtime.getSceneForSession === "function"
    ? runtime.getSceneForSession(session)
    : null;
  if (
    !scene ||
    typeof scene.afterDestinyBatch !== "function" ||
    !(scene.sessions instanceof Map) ||
    scene.sessions.get(session.clientID) !== session
  ) {
    return null;
  }
  return scene;
}

// Dungeon room notices leave with the tick: for an
// Observer of a scene, `send` is queued to run in that Destiny tick's
// doPostTick, after the session's batches (every
// Destiny update leaves from doPostTick); otherwise it runs now. Nothing is
// held to a wall-clock second. Returns true once the
// notice is sent or queued.
function sendWithTick(session, send) {
  const scene = getObservedScene(session);
  if (scene && scene.afterDestinyBatch(session, send)) {
    return true;
  }
  send();
  return true;
}

// field "message": sent when the warp into the room is accepted (a gate's activation), or on
// arrival when no such warp sent it. "midWarpMessage": sent at the middle of that warp (half
// its flight time). "arrivalMessage": sent on arrival only, after "message". The career agents'
// The Pacifist uses all three for the fleet commander's messages (TQ: the gate's activation,
// about four seconds into the warp, and when the ship drops out of it).
function buildRoomTransmission(template, roomKey, field = "message") {
  const roomLists = [
    template && template.rooms,
    template && template.siteSceneProfile && template.siteSceneProfile.roomProfiles,
    template && template.clientDungeonContent && template.clientDungeonContent.rooms,
  ];
  let message = null;
  for (const rooms of roomLists) {
    const room = Array.isArray(rooms)
      ? rooms.find((entry) => entry && entry.roomKey === roomKey)
      : null;
    if (room && room[field]) {
      message = room[field];
      break;
    }
  }
  return buildTransmission(message);
}

// A transmission popup from a message: { headerID|header, textID|text, icon }.
function buildTransmission(message) {
  if (!message) {
    return null;
  }
  const localizedValue = (id, text) => {
    const numeric = typeof id === "number" || typeof id === "string" ? Number(id) : 0;
    return Number.isSafeInteger(numeric) && numeric > 0
      ? numeric
      : typeof text === "string" ? text : "";
  };
  const header = localizedValue(message.headerID, message.header);
  const text = localizedValue(message.textID, message.text);
  if ((typeof header === "string" && !header.trim()) &&
      (typeof text === "string" && !text.trim())) {
    return null;
  }
  // Build 3396210 TransmissionSvc localizes integer attributes, then calls
  // header.startswith('[d]') unconditionally. Telecom.ShowMessage parses an icon
  // string's first space-separated integer; a falsey icon selects its default.
  return buildKeyVal([
    ["header", header],
    ["text", text],
    ["icon", typeof message.icon === "string" ? message.icon : ""],
  ]);
}

// Select authored entry presentation without advancing a room or changing the
// landing's existing room-key rules. Agent bookmark orders omit the room key.
function resolveWarpTransmissionRoomKey(template, shipEntity, request) {
  if (request.destinationDungeonRoomKey) return String(request.destinationDungeonRoomKey);
  if (entityIDsEqual(shipEntity.dungeonCurrentInstanceID, request.destinationStaticInstanceID) &&
      shipEntity.dungeonCurrentRoomKey) return String(shipEntity.dungeonCurrentRoomKey);
  if (template && template.entryRoomKey) return String(template.entryRoomKey);
  const rooms = [template && template.rooms,
    template && template.siteSceneProfile && template.siteSceneProfile.roomProfiles,
    template && template.clientDungeonContent && template.clientDungeonContent.rooms]
    .filter(Array.isArray).flat();
  const active = [...new Set(rooms.filter(room => room && room.initialState === "active")
    .map(room => String(room.roomKey || "")).filter(Boolean))];
  if (active.length === 1) return active[0];
  return rooms.some(room => room && room.roomKey === "room:entry") ? "room:entry" : "";
}

function sendRoomTransmission(session, instance, transmission) {
  const isAgentMission = Boolean(instance && (
    (instance.metadata && instance.metadata.missionRuntime === true) ||
    (instance.runtimeFlags && instance.runtimeFlags.missionRuntime === true)
  ));
  // Retail ordinary mission capture: shipid, (KeyVal, True). Other site
  // messages retain their existing transport/default optional argument.
  session.sendNotification("OnIncomingTransmission", isAgentMission ? "shipid" : "charid",
    isAgentMission ? [transmission, true] : [transmission]);
}

// An accepted warp out of the ship's current site: a career lesson's departure message (the
// career agents' Glue, the agent's "Stand down, pilot. ..." once the lesson is done; TQ: on
// the warp's activation). A warp within the site is no departure.
function sendDepartureTransmission(scene, session, request) {
  try {
    const shipEntity = getShipEntityForSession(scene, session);
    const instanceID = shipEntity && shipEntity.dungeonCurrentInstanceID;
    if (!instanceID || !request ||
        entityIDsEqual(request.destinationStaticInstanceID, instanceID)) return false;
    const instance = dungeonRuntime.getInstance(instanceID);
    const lessons = require("./careerLessonRuntime");
    const message = instance && lessons.departureMessage(instance, resolveTemplate(instance),
      resolveSessionCharacterID(session));
    const transmission = message && buildTransmission(message);
    if (!transmission) return false;
    sendRoomTransmission(session, instance, transmission);
    const nowMs = typeof scene.getCurrentSimTimeMs === "function" ? scene.getCurrentSimTimeMs() : Date.now();
    lessons.departureMessageSent(instance, nowMs);
    return true;
  } catch (error) {
    log.debug(`[DungeonTracking] departure transmission failed: ${error && error.message}`);
    return false;
  }
}

function notifyAcceptedDungeonWarp(scene, session, result) {
  // The result is from the checked command, not an unvalidated network request.
  // Queued success is an accepted order; later cancellation cannot unsend it.
  if (!result || result.success !== true || result.redundant || !session ||
      typeof session.sendNotification !== "function") return false;
  const request = result.data && (result.data.request || result.data);
  // A short warp becomes an approach; it must not spend the site farewell.
  if (!request || request.nativeGoto) return false;
  sendDepartureTransmission(scene, session, request);
  const receipt = request && request[WARP_TRANSMISSION_RECEIPT];
  if (!receipt || typeof receipt !== "object" ||
      acceptedWarpTransmissions.has(receipt)) return false;
  try {
    const characterID = resolveSessionCharacterID(session);
    const shipEntity = getShipEntityForSession(scene, session);
    if (characterID <= 0 || !shipEntity || session.stationid || session.stationID ||
        getObservedScene(session) !== scene ||
        typeof scene.resolveAuthorizedDestinationDungeonContext !== "function") return false;
    const instance = dungeonRuntime.getInstance(request.destinationStaticInstanceID);
    if (!isTrackedDungeonInstance(instance)) return false;
    const template = resolveTemplate(instance);
    const roomKey = resolveWarpTransmissionRoomKey(template, shipEntity, request);
    if (!roomKey) return false;
    const resolution = scene.resolveAuthorizedDestinationDungeonContext(session, instance.instanceID, {
      roomKey, siteID: request.destinationDungeonSiteID,
    });
    if (!resolution || !entityIDsEqual(resolution.instanceID, instance.instanceID)) return false;
    const transmission = buildRoomTransmission(template, roomKey);
    if (!transmission) return false;
    // Deliberately synchronous: the ordinary mission capture precedes both its
    // RPC response and Destiny WarpTo. Arrival notices still use the tick.
    sendRoomTransmission(session, instance, transmission);
    acceptedWarpTransmissions.set(receipt, { scene, session, shipEntity, characterID,
      instanceID: instance.instanceID, roomKey });
    return true;
  } catch (error) {
    log.debug(`[DungeonTracking] accepted warp transmission failed: ${error && error.message}`);
    return false;
  }
}

// A pilot's ship entered warp (scene handleWarpActivated) to a room of a tracked site: the
// room's midWarpMessage is armed for the warp's middle (midWarpAtMs, from the scene's warp
// profile), once per warp. The room is the accepted warp's (its receipt, as the room's message
// on the gate's activation), else the warp destination's own.
const pendingMidWarpTransmissions = new WeakMap();
function armMidWarpTransmission(scene, entity, destination, midWarpAtMs) {
  const session = entity && entity.session;
  const accepted = destination && destination[WARP_TRANSMISSION_RECEIPT] &&
    acceptedWarpTransmissions.get(destination[WARP_TRANSMISSION_RECEIPT]);
  const roomKey = accepted ? accepted.roomKey : destination && destination.destinationDungeonRoomKey;
  const instanceID = accepted ? accepted.instanceID : destination && destination.destinationStaticInstanceID;
  pendingMidWarpTransmissions.delete(entity);
  if (!session || typeof session.sendNotification !== "function" || !roomKey || !instanceID) return false;
  try {
    const instance = dungeonRuntime.getInstance(instanceID);
    if (!isTrackedDungeonInstance(instance)) return false;
    const transmission = buildRoomTransmission(resolveTemplate(instance), String(roomKey), "midWarpMessage");
    if (!transmission) return false;
    pendingMidWarpTransmissions.set(entity, { session, instance, transmission, dueAtMs: midWarpAtMs });
    return true;
  } catch (error) {
    log.debug(`[DungeonTracking] mid-warp transmission failed: ${error && error.message}`);
    return false;
  }
}
// Each scene tick (and at the warp's drop, before the landing's messages): an armed message whose
// time has come goes to the pilot it was armed for.
function sendDueMidWarpTransmission(entity, nowMs, options = {}) {
  const pending = pendingMidWarpTransmissions.get(entity);
  if (!pending || (options.landing !== true && nowMs < pending.dueAtMs)) return false;
  pendingMidWarpTransmissions.delete(entity);
  if (entity.session !== pending.session) return false;
  try {
    sendRoomTransmission(pending.session, pending.instance, pending.transmission);
    return true;
  } catch (error) {
    log.debug(`[DungeonTracking] mid-warp transmission failed: ${error && error.message}`);
    return false;
  }
}
function hasPendingMidWarpTransmission(entity) {
  return pendingMidWarpTransmissions.has(entity);
}

function consumeAcceptedWarpTransmission(scene, session, instance, roomKey, receipt) {
  const sent = receipt && typeof receipt === "object" && acceptedWarpTransmissions.get(receipt);
  if (!sent || sent.scene !== scene || sent.session !== session ||
      sent.characterID !== resolveSessionCharacterID(session) ||
      sent.shipEntity !== getShipEntityForSession(scene, session) ||
      !entityIDsEqual(sent.instanceID, instance.instanceID) || sent.roomKey !== roomKey) return false;
  acceptedWarpTransmissions.delete(receipt);
  return true;
}

function isCurrentRoomArrival(session, instance, arrival) {
  return (
    arrival.characterID > 0 &&
    resolveSessionCharacterID(session) === arrival.characterID &&
    !session.stationid && !session.stationID &&
    roomVisitsByShip.get(arrival.shipEntity) === arrival.visit &&
    toInt(arrival.shipEntity.dungeonCurrentInstanceID, 0) === toInt(instance.instanceID, 0) &&
    arrival.shipEntity.dungeonCurrentRoomKey === arrival.roomKey &&
    getShipEntityForSession(arrival.scene, session) === arrival.shipEntity &&
    (!arrival.observedScene || getObservedScene(session) === arrival.observedScene) &&
    isTrackedDungeonInstance(dungeonRuntime.getInstance(instance.instanceID))
  );
}

function sendEnteringDungeonRoomNotification(session, instance, roomKey, options = {}, arrival = null) {
  if (!session || typeof session.sendNotification !== "function") {
    return false;
  }
  const info = buildCurrentDungeonInfo(instance, roomKey, { ...options, session });
  if (!info) {
    return false;
  }
  const args = [
    info[0],
    info[1],
    positionTuple(options.roomPosition),
    info[2],
    info[3],
  ];
  return sendWithTick(session, () => {
    if (arrival && !isCurrentRoomArrival(session, instance, arrival)) {
      return;
    }
    session.sendNotification("OnEnteringDungeonRoom", "shipid", args);
    if (arrival && isCurrentRoomArrival(session, instance, arrival)) {
      for (const transmission of arrival.transmissions) {
        try {
          sendRoomTransmission(session, instance, transmission);
        } catch (error) {
          log.debug(`[DungeonTracking] room transmission for dungeon ${instance.instanceID} failed: ${error && error.message}`);
        }
      }
    }
  });
}

// TQ tells a pilot about a dungeon it starts warping to with
// OnDistributionDungeonEntered (idtype charid), one Row of name,
// description, x, y, z, solarSystemID and ballID, right after the
// CmdWarpToStuff answer (golden logs "Warping from Probe Scanner - Getting
// told No when trying again", "Minmatar - Tutorial - Career missions part 1",
// "Join Fleet - Receive Boss - Set other as boss - leave fleet"). TQ's name is
// literally "[no messageID: <dungeonID>]". Each site came once per pilot; the
// client forgets the list whenever locationid changes (dungeonTracking.py
// ProcessSessionChange) and draws a system-map bracket per row
// (systemMapSvc.LoadDungeons). Escalations have their own event.
const DISTRIBUTION_DUNGEON_ROW_HEADER = Object.freeze([
  "name", "description", "x", "y", "z", "solarSystemID", "ballID",
]);

function findSiteEntityIDForInstance(scene, instanceID) {
  if (!scene || !(scene.dynamicEntities instanceof Map)) {
    return null;
  }
  for (const entity of scene.dynamicEntities.values()) {
    const entityInstanceID = toInt(
      entity && (entity.dungeonSiteInstanceID || entity.dungeonInstanceID),
      0,
    );
    if (entityInstanceID === instanceID) {
      return entity.itemID;
    }
  }
  return null;
}

function notifyDistributionDungeonWarp(session, instanceID) {
  if (!session || typeof session.sendNotification !== "function") {
    return false;
  }
  const numericInstanceID = toInt(instanceID, 0);
  const instance = numericInstanceID > 0 ? dungeonRuntime.getInstance(numericInstanceID) : null;
  if (!isTrackedDungeonInstance(instance) || normalizeLowerText(instance.siteKind, "") === "escalation") {
    return false;
  }
  const dungeonID = resolveDungeonID(instance, resolveTemplate(instance));
  if (dungeonID <= 0) {
    return false;
  }
  const locationID = toInt(session.locationid || session.solarsystemid2 || session.solarsystemid, 0);
  if (!session._distributionDungeonsEntered || session._distributionDungeonsEntered.locationID !== locationID) {
    session._distributionDungeonsEntered = { locationID, instanceIDs: new Set() };
  }
  if (session._distributionDungeonsEntered.instanceIDs.has(numericInstanceID)) {
    return false;
  }
  session._distributionDungeonsEntered.instanceIDs.add(numericInstanceID);
  const position = clonePosition(instance.position) || { x: 0, y: 0, z: 0 };
  const ballID = findSiteEntityIDForInstance(getObservedScene(session), numericInstanceID);
  session.sendNotification("OnDistributionDungeonEntered", "charid", [{
    type: "object",
    name: "carbon.common.script.sys.row.Row",
    args: {
      type: "dict",
      entries: [
        ["header", { type: "list", items: [...DISTRIBUTION_DUNGEON_ROW_HEADER] }],
        ["line", {
          type: "list",
          items: [
            { type: "wstring", value: `[no messageID: ${dungeonID}]` },
            "",
            { type: "real", value: position.x },
            { type: "real", value: position.y },
            { type: "real", value: position.z },
            toInt(instance.solarSystemID, 0),
            ballID === null || ballID === undefined ? null : ballID,
          ],
        }],
      ],
    },
  }]);
  sendWarpPopup(session, resolveTemplate(instance));
  return true;
}

// A site may name a message box shown when a warp to it is accepted
// (populationHints.warpPopup, a titleID and a textID), once per pilot like the row above. A TQ
// recording of the career agents' Data Training Site shows its room message ("Data Site -
// Training Area", 126391 / 97520) as an "Information" message box as soon as the pilot clicks
// Warp To; that room message then does not also go to the chat (sendRoomEntryMessage).
function sendWarpPopup(session, template) {
  const popup = template && template.populationHints && template.populationHints.warpPopup;
  if (!popup || toInt(popup.textID, 0) <= 0 || typeof session.sendClientCallRequest !== "function") {
    return;
  }
  session.sendClientCallRequest("agents", "MessageBox", [toInt(popup.titleID, 0), toInt(popup.textID, 0)]);
}

function clearShipCurrentDungeonRoom(shipEntity, options = {}) {
  if (!shipEntity) {
    return false;
  }
  if (shipEntity.dungeonCurrentInstanceID) {
    const instance = dungeonRuntime.getInstance(
      shipEntity.dungeonCurrentInstanceID,
    );
    if (
      require("../homefront/homefrontHooks").runtime.config(instance)
        ?.family === "raid"
    )
      require("../homefront/homefrontHooks").cargo.cleanup(shipEntity);
  }
  const hadDungeon = Math.max(0, toInt(shipEntity.dungeonCurrentInstanceID, 0)) > 0 ||
    Math.max(0, toInt(shipEntity.dungeonCurrentDungeonID, 0)) > 0 ||
    !!normalizeText(shipEntity.dungeonCurrentRoomKey, "");

  delete shipEntity.dungeonCurrentInstanceID;
  delete shipEntity.dungeonCurrentDungeonID;
  delete shipEntity.dungeonCurrentRoomKey;
  delete shipEntity.dungeonCurrentRoomID;
  delete shipEntity.dungeonCurrentSiteID;
  delete shipEntity.dungeonCurrentRoomPosition;
  delete shipEntity.dungeonCompletedNotifiedInstanceID;
  roomVisitsByShip.delete(shipEntity);
  shipEntity.dungeonCurrentUpdatedAtMs = Math.max(0, toInt(options.nowMs, Date.now()));
  return hadDungeon;
}

function sendExitingDungeonNotification(session, dungeonID) {
  if (
    !session ||
    typeof session.sendNotification !== "function" ||
    Math.max(0, toInt(dungeonID, 0)) <= 0
  ) {
    return false;
  }
  const args = [Math.max(0, toInt(dungeonID, 0))];
  return sendWithTick(session, () => {
    session.sendNotification("OnExitingDungeon", "shipid", args);
  });
}

function sendDungeonCompletedNotification(session, dungeonID) {
  if (
    !session ||
    typeof session.sendNotification !== "function" ||
    Math.max(0, toInt(dungeonID, 0)) <= 0
  ) {
    return false;
  }
  session.sendNotification("OnDungeonCompleted", "charid", [
    Math.max(0, toInt(dungeonID, 0)),
  ]);
  return true;
}

function resolveDungeonInstance(instanceOrID) {
  if (instanceOrID && typeof instanceOrID === "object") {
    return instanceOrID;
  }
  const instanceID = Math.max(0, toInt(instanceOrID, 0));
  return instanceID > 0 ? dungeonRuntime.getInstance(instanceID) : null;
}

function completeCurrentDungeonForSession(scene, session, instanceOrID, options = {}) {
  const instance = resolveDungeonInstance(instanceOrID);
  if (!instance) {
    return false;
  }
  const current = resolveTrackedDungeonForSession(scene, session);
  if (!current || !current.instance || !current.shipEntity) {
    return false;
  }
  const instanceID = Math.max(0, toInt(instance.instanceID, 0));
  if (
    instanceID <= 0 ||
    Math.max(0, toInt(current.instance && current.instance.instanceID, 0)) !== instanceID
  ) {
    return false;
  }
  if (
    options.forceNotify !== true &&
    Math.max(0, toInt(current.shipEntity.dungeonCompletedNotifiedInstanceID, 0)) === instanceID
  ) {
    return false;
  }
  const dungeonID = Math.max(
    0,
    toInt(current.shipEntity && current.shipEntity.dungeonCurrentDungeonID, 0),
    resolveDungeonID(instance),
    resolveDungeonID(current.instance),
  );
  if (!sendDungeonCompletedNotification(session, dungeonID)) {
    return false;
  }
  current.shipEntity.dungeonCompletedNotifiedInstanceID = instanceID;
  current.shipEntity.dungeonCurrentUpdatedAtMs = Math.max(0, toInt(options.nowMs, Date.now()));
  return true;
}

// Called only after the site's authoritative resource/encounter conditions
// have completed. Retain the audience before crediting it; a failed achievement
// write leaves the site active so the existing behavior tick can retry it.
function settleSiteCompletionAchievements(scene, instance, options = {}) {
  const family = normalizeLowerText(instance && instance.siteFamily, "");
  const kind = normalizeLowerText(instance && instance.siteKind, "");
  const metadata = instance && instance.metadata || {};
  const flags = instance && instance.runtimeFlags || {};
  if (!instance || instance.instanceScope === "private" || instance.ownership?.visibilityScope === "private" ||
      metadata.missionRuntime === true || metadata.privateOperation === true ||
      flags.missionRuntime === true || !["anomaly", "signature", "escalation"].includes(kind) ||
      !["combat", "data", "relic"].includes(family)) {
    return { success: true, data: { changed: false } };
  }
  // Signature Sweeper explicitly excludes time-limited event sites in the
  // pinned client. Those have separate campaign progression authorities.
  if (family === "combat" && (String(instance.templateID || "").startsWith("evejs-election:") ||
      metadata.eventID || metadata.eventKey || metadata.campaignID || metadata.timeLimited === true ||
      flags.timeLimited === true || flags.seasonalEvent === true)) {
    return { success: true, data: { changed: false } };
  }
  let source = dungeonRuntime.getInstance(instance.instanceID) || instance;
  let characterIDs = source.spawnState && source.spawnState.achievementCompletionCharacterIDs;
  try {
    if (!Array.isArray(characterIDs)) {
      characterIDs = [...new Set(listSceneSessions(scene).filter((session) => {
        const current = resolveTrackedDungeonForSession(scene, session);
        return current && current.instance &&
          Number(current.instance.instanceID) === Number(instance.instanceID);
      }).map((session) => toInt(session.characterID || session.charid, 0)).filter((id) => id > 0))];
      source = dungeonRuntime.mergeSpawnState(instance.instanceID, {
        achievementCompletionCharacterIDs: characterIDs,
      }, { nowMs: options.nowMs, durable: true });
    }
    const runtime = require(path.join(__dirname, "../achievement/achievementRuntime"));
    const method = family === "combat" ? "recordCombatSiteCompletion" : "recordDataRelicSiteCompletion";
    for (const characterID of characterIDs) {
      const result = runtime[method](characterID, {
        ...source,
        lifecycleState: "completed",
      }, { eventKey: `dungeon-completion:${source.instanceID}:${characterID}` });
      if (!result || result.success !== true) {
        return { success: false, errorMsg: result && result.errorMsg || "ACHIEVEMENT_SITE_COMPLETION_PENDING" };
      }
    }
    return { success: true };
  } catch (error) {
    log.warn(`[DungeonTracking] achievement completion for dungeon ${instance.instanceID} deferred: ${error.message}`);
    return { success: false, errorMsg: "ACHIEVEMENT_SITE_COMPLETION_PENDING" };
  }
}

// Terminal Abyssal cleanup retries this against its durable exited roster before
// deleting the run. Entering, clearing a room, dying and evacuation never count.
function recordAbyssalRunCompletion(pocketState) {
  if (!pocketState || pocketState.runOutcome !== "exited") {
    return { success: true, data: { changed: false } };
  }
  const roster = Array.isArray(pocketState.participantRoster) ? pocketState.participantRoster : [];
  const characterIDs = [...new Set(roster.filter((entry) => entry && entry.status === "exited")
    .map((entry) => toInt(entry.characterID, 0)).filter((id) => id > 0))];
  if (roster.length === 0 && toInt(pocketState.committedExitState && pocketState.committedExitState.characterID, 0) > 0) {
    characterIDs.push(toInt(pocketState.committedExitState.characterID, 0));
  }
  try {
    const runtime = require(path.join(__dirname, "../achievement/achievementRuntime"));
    for (const characterID of characterIDs) {
      const result = runtime.recordAbyssalCompletion(characterID, pocketState, {
        eventKey: `abyssal-completion:${pocketState.instanceID}:${characterID}`,
      });
      if (!result || result.success !== true) {
        return { success: false, errorMsg: result && result.errorMsg || "ACHIEVEMENT_ABYSSAL_COMPLETION_PENDING" };
      }
    }
    return { success: true };
  } catch (error) {
    log.warn(`[DungeonTracking] achievement completion for Abyssal run ${pocketState.instanceID} deferred: ${error.message}`);
    return { success: false, errorMsg: "ACHIEVEMENT_ABYSSAL_COMPLETION_PENDING" };
  }
}

function buildCareerAbyssalNpcOutcome(pocketState, event, nowMs) {
  return require("../career/careerAbyssalSources").stageNpcOutcome(pocketState, event, nowMs);
}
function recordCareerAbyssalRun(instanceID) {
  return require("../career/careerAbyssalSources").reconcileRun(instanceID);
}

function listSceneSessions(scene) {
  if (!scene || !scene.sessions) {
    return [];
  }
  if (scene.sessions instanceof Map) {
    return Array.from(scene.sessions.values());
  }
  if (Array.isArray(scene.sessions)) {
    return scene.sessions;
  }
  if (typeof scene.sessions === "object") {
    return Object.values(scene.sessions);
  }
  return [];
}

function notifyDungeonCompletedForScene(scene, instanceOrID, options = {}) {
  const instance = resolveDungeonInstance(instanceOrID);
  if (!scene || !instance) {
    return 0;
  }
  let notifiedCount = 0;
  for (const session of listSceneSessions(scene)) {
    if (completeCurrentDungeonForSession(scene, session, instance, options)) {
      notifiedCount += 1;
    }
  }
  return notifiedCount;
}

function sendDungeonValuesNotification(session, dungeonID, values) {
  if (
    !session ||
    typeof session.sendNotification !== "function" ||
    Math.max(0, toInt(dungeonID, 0)) <= 0 ||
    !values ||
    typeof values !== "object"
  ) {
    return false;
  }
  session.sendNotification("OnDungeonValues", "charid", [
    Math.max(0, toInt(dungeonID, 0)),
    buildDict(Object.entries(values)),
  ]);
  return true;
}

// Updates the client's dungeon blackboard for every session tracked inside this instance.
function notifyDungeonValuesForScene(scene, instanceOrID, values) {
  const instance = resolveDungeonInstance(instanceOrID);
  if (!scene || !instance || !values) {
    return 0;
  }
  const instanceID = Math.max(0, toInt(instance.instanceID, 0));
  let notifiedCount = 0;
  for (const session of listSceneSessions(scene)) {
    const current = resolveTrackedDungeonForSession(scene, session);
    if (
      !current ||
      !current.instance ||
      Math.max(0, toInt(current.instance.instanceID, 0)) !== instanceID
    ) {
      continue;
    }
    const dungeonID = Math.max(
      0,
      toInt(current.shipEntity && current.shipEntity.dungeonCurrentDungeonID, 0),
      resolveDungeonID(instance),
      resolveDungeonID(current.instance),
    );
    const sessionValues = typeof values === "function" ? values(session) : values;
    if (sendDungeonValuesNotification(session, dungeonID, sessionValues)) {
      notifiedCount += 1;
    }
  }
  return notifiedCount;
}

function getSceneEntityByID(scene, entityID) {
  const normalizedEntityID = normalizePersistentEntityID(entityID);
  if (!scene || normalizedEntityID === null) {
    return null;
  }
  if (typeof scene.getEntityByID === "function") {
    return scene.getEntityByID(normalizedEntityID);
  }
  if (
    scene.staticEntitiesByID instanceof Map &&
    scene.staticEntitiesByID.has(normalizedEntityID)
  ) {
    return scene.staticEntitiesByID.get(normalizedEntityID);
  }
  if (
    scene.dynamicEntities instanceof Map &&
    scene.dynamicEntities.has(normalizedEntityID)
  ) {
    return scene.dynamicEntities.get(normalizedEntityID);
  }
  return null;
}

function entityBelongsToTrackedDungeon(entity, instance, shipEntity) {
  if (!entity || !instance) {
    return false;
  }
  const instanceID = Math.max(0, toInt(instance.instanceID, 0));
  const siteID = resolveExactPersistentIdentity([
    shipEntity && shipEntity.dungeonCurrentSiteID,
    instance && instance.metadata && instance.metadata.siteID,
  ]);
  const entityInstanceID = Math.max(
    0,
    toInt(entity.dungeonSiteInstanceID, 0),
    toInt(entity.dungeonInstanceID, 0),
    toInt(entity.instanceID, 0),
  );
  if (instanceID > 0 && entityInstanceID === instanceID) {
    return true;
  }
  const entitySiteID = normalizePersistentEntityID(
    hasIdentityValue(entity.dungeonSiteID)
      ? entity.dungeonSiteID
      : entity.itemID,
  );
  if (
    siteID !== null &&
    entitySiteID !== null &&
    entityIDsEqual(entitySiteID, siteID)
  ) {
    return true;
  }
  const dungeonID = Math.max(0, toInt(shipEntity && shipEntity.dungeonCurrentDungeonID, 0));
  return (
    dungeonID > 0 &&
    Math.max(0, toInt(entity.dungeonID, 0)) === dungeonID &&
    (
      normalizeText(entity.kind, "") === "missionSite" ||
      entity.signalTrackerUniverseSeededSite === true ||
      entity.dungeonMaterializedSiteContent === true
    )
  );
}

function pointBelongsToTrackedDungeon(point, shipEntity) {
  const roomPosition = Array.isArray(shipEntity && shipEntity.dungeonCurrentRoomPosition)
    ? {
        x: shipEntity.dungeonCurrentRoomPosition[0],
        y: shipEntity.dungeonCurrentRoomPosition[1],
        z: shipEntity.dungeonCurrentRoomPosition[2],
      }
    : null;
  if (!point || !roomPosition) {
    return false;
  }
  return distanceSquared(point, roomPosition) <= SAME_ROOM_WARP_PRESERVE_RANGE_SQUARED;
}

function shouldPreserveDungeonForWarp(scene, current, options = {}) {
  if (!current || !current.instance || !current.shipEntity) {
    return false;
  }
  if (
    options.preserveDungeonTracking === true ||
    options.dungeonRoomTransition === true
  ) {
    return true;
  }
  const targetEntity = options.targetEntity ||
    getSceneEntityByID(scene, options.targetEntityID);
  if (entityBelongsToTrackedDungeon(targetEntity, current.instance, current.shipEntity)) {
    return true;
  }
  return pointBelongsToTrackedDungeon(options.targetPoint, current.shipEntity);
}

function exitCurrentDungeonForSession(scene, session, options = {}) {
  const current = resolveTrackedDungeonForSession(scene, session);
  if (!current) {
    return false;
  }
  if (shouldPreserveDungeonForWarp(scene, current, options)) {
    return false;
  }
  const dungeonID = Math.max(
    0,
    toInt(current.shipEntity && current.shipEntity.dungeonCurrentDungeonID, 0),
    resolveDungeonID(current.instance),
  );
  clearShipCurrentDungeonRoom(current.shipEntity, options);
  return sendExitingDungeonNotification(session, dungeonID);
}

function enterDungeonRoomForSession(scene, session, instance, roomKey, options = {}) {
  const shipEntity = getShipEntityForSession(scene, session);
  if (!shipEntity || !instance) {
    return false;
  }
  const normalizedRoomKey = normalizeText(roomKey, "room:entry");
  const careerEntry = require("../career/careerExplorationSources").recordSiteEntry(
    session.characterID, instance, normalizedRoomKey, scene.systemID,
  );
  if (!careerEntry?.success) {
    log.warn(`[DungeonTracking] career entry awaits retry instance=${instance.instanceID}: ${careerEntry?.errorMsg}`);
    return false;
  }
  const changed = markShipCurrentDungeonRoom(shipEntity, instance, normalizedRoomKey, options);
  if (changed && normalizedRoomKey === "room:entry") {
    try {
      require(path.join(
        __dirname,
        "../achievement/achievementRuntime",
      )).recordDungeonEntry(session.characterID, {
        dungeonID: resolveDungeonID(instance),
        instanceID: instance.instanceID,
        solarSystemID: instance.solarSystemID,
        templateID: instance.templateID,
        archetypeID: instance.archetypeID ||
          (instance.metadata && instance.metadata.archetypeID),
        factionID: instance.factionID ||
          (instance.metadata && instance.metadata.factionID),
      }, { eventKey: `dungeon:${instance.instanceID}` });
    } catch (error) {
      // Dungeon transition state is authoritative; achievements are best-effort.
      log.debug(`[DungeonTracking] achievement event for dungeon ${instance.instanceID} failed: ${error && error.message}`);
    }
  }
  let arrival = null;
  if (changed) {
    try {
      const template = options.template || resolveTemplate(instance);
      const transmissions = [
        consumeAcceptedWarpTransmission(
          scene, session, instance, normalizedRoomKey, options[WARP_TRANSMISSION_RECEIPT],
        ) ? null : buildRoomTransmission(template, normalizedRoomKey),
        buildRoomTransmission(template, normalizedRoomKey, "arrivalMessage"),
      ].filter(Boolean);
      if (transmissions.length > 0 && resolveSessionCharacterID(session) > 0) {
        arrival = {
          scene,
          shipEntity,
          roomKey: normalizedRoomKey,
          visit: roomVisitsByShip.get(shipEntity),
          characterID: resolveSessionCharacterID(session),
          observedScene: getObservedScene(session),
          transmissions,
        };
      }
    } catch (error) {
      // Presentation must never prevent authoritative room tracking.
      log.debug(`[DungeonTracking] room transmission for dungeon ${instance.instanceID} failed: ${error && error.message}`);
    }
  }
  if (changed) {
    sendRoomEntryMessage(session, instance, normalizedRoomKey);
  }
  const notified = changed || options.forceNotify === true
    ? sendEnteringDungeonRoomNotification(session, instance, normalizedRoomKey, options, arrival)
    : false;
  if (changed) {
    // Waves on on_room_active spawn when the gate is activated; on_room_entered ones when the
    // ship has landed here. Then the mission tracker's new state, while the client is still in
    // the warp into the room (see enterSiteRoom).
    require("./dungeonUniverseSiteService").enterSiteRoom(scene, instance, normalizedRoomKey, { session });
  }
  return notified;
}

// The message a room shows its visitors (the client's dungeon data: messageHeaderID /
// messageTextID; a site template carries it as the room profile's entryMessage). The client
// shows OnDungeonTriggerMessage texts in its chat as game messages (svc.trigger).
const DUN_EVENT_MESSAGE_MISSION_INSTRUCTION = 7;
function roomEntryMessageOf(template, roomKey) {
  const rooms = (template && template.siteSceneProfile && template.siteSceneProfile.roomProfiles) || [];
  const room = rooms.find((candidate) => candidate && candidate.roomKey === roomKey);
  return (room && room.entryMessage) || null;
}

// A site with a guide (populationHints.guideAgentID: Rulie Isoryn, agent 3015787, in the
// exploration tour) speaks through an agent transmission, as on Tranquility, and never in the
// chat: arriving in a room, or opening or approaching a container that has a text of its own
// (populationHints.containers[].guideTextOnOpen / guideTextOnApproach), sends
// OnIncomingAgentMessage with that text. Talking to the agent later still answers with the same
// line (agentMgr DoAction -> guideTextForSession).
function guideAgentIDOf(template) {
  return Math.max(0, toInt(template && template.populationHints && template.populationHints.guideAgentID, 0));
}

// TQ never opens the guide's dialogue window here: it sends
// OnIncomingAgentMessage(agentID, (messageID, None)), idtype charid, which
// transmissionMgr shows as the agent's transmission window (43 sends in the
// tour and training-site captures, e.g. (3015787, (124536, None))). The window
// fallback stays only for a guide line with no message ID.
function openGuideWindow(session, guideAgentID, textID = 0) {
  const messageID = toInt(textID, 0);
  if (messageID > 0 && typeof session.sendNotification === "function") {
    session.sendNotification("OnIncomingAgentMessage", "charid", [guideAgentID, [messageID, null]]);
    return;
  }
  if (typeof session.sendClientCallRequest === "function") {
    session.sendClientCallRequest("agents", "OpenDialogueWindow", [guideAgentID]);
  }
}

// A site's arrival popup (populationHints.arrivalPopup: the Anomaly Training Site's "Incoming
// Transmission"): a message box on landing in its entry room, the client's agents.MessageBox
// with the title and text by message ID (no agent, so the client fetches nothing for it).
function sendArrivalPopup(session, template, roomKey) {
  const popup = template && template.populationHints && template.populationHints.arrivalPopup;
  const entryRoomKey = normalizeText(template && template.entryRoomKey, "room:entry");
  if (!popup || roomKey !== entryRoomKey || typeof session.sendClientCallRequest !== "function") {
    return;
  }
  session.sendClientCallRequest("agents", "MessageBox", [toInt(popup.titleID, 0), toInt(popup.textID, 0)]);
}

function sendRoomEntryMessage(session, instance, roomKey) {
  const template = instance && instance.templateID ? dungeonAuthority.getTemplateByID(instance.templateID) : null;
  sendArrivalPopup(session, template, roomKey);
  const message = roomEntryMessageOf(template, roomKey);
  if (!message || typeof session.sendNotification !== "function") {
    return;
  }
  const guideAgentID = guideAgentIDOf(template);
  if (guideAgentID > 0) {
    openGuideWindow(session, guideAgentID, message.textID);
    return;
  }
  const warpPopup = template && template.populationHints && template.populationHints.warpPopup;
  if (warpPopup && toInt(warpPopup.textID, 0) === toInt(message.textID, 0)) {
    return;
  }
  for (const messageID of [message.headerID, message.textID]) {
    if (toInt(messageID, 0) > 0) {
      session.sendNotification("OnDungeonTriggerMessage", "charid", [
        DUN_EVENT_MESSAGE_MISSION_INSTRUCTION,
        toInt(messageID, 0),
      ]);
    }
  }
}

function guideSiteOfShip(scene, session) {
  const shipEntity = getShipEntityForSession(scene, session);
  const instanceID = Math.max(0, toInt(shipEntity && shipEntity.dungeonCurrentInstanceID, 0));
  const instance = instanceID > 0 ? dungeonRuntime.getInstance(instanceID) : null;
  const template = instance ? resolveTemplate(instance) : null;
  return template && guideAgentIDOf(template) > 0
    ? { shipEntity, instanceID, template, roomKey: normalizeText(shipEntity.dungeonCurrentRoomKey, "room:entry") }
    : null;
}

// What a site guide says to this pilot: in the guide's site, the text of the container the pilot
// last opened in this room, else the room's own text; null elsewhere.
function guideTextForSession(session, agentID) {
  const site = guideSiteOfShip(getSpaceRuntime().getSceneForSession(session), session);
  if (!site || guideAgentIDOf(site.template) !== toInt(agentID, 0)) {
    return null;
  }
  const opened = site.shipEntity.dungeonGuideText;
  if (opened && opened.instanceID === site.instanceID && opened.roomKey === site.roomKey) {
    return opened.textID;
  }
  const message = roomEntryMessageOf(site.template, site.roomKey);
  return message && toInt(message.textID, 0) > 0 ? toInt(message.textID, 0) : null;
}

// The pilot opened a site container (invBroker GetInventoryFromId): an AIR item-retrieval wreck
// may get the pilot's item; one with a guide text of its own (the tour's Exploration Supplies)
// has the guide say it.
function onSiteContainerOpened(session, itemID) {
  const scene = getSpaceRuntime().getSceneForSession(session);
  const container = scene && typeof scene.getEntityByID === "function" ? scene.getEntityByID(itemID) : null;
  if (container && container.dungeonMaterializedContainer === true) {
    require("../npe/airNpeRuntime").onRetrievalWreckOpened(session, container);
  }
  const site = container && container.dungeonMaterializedContainer === true ? guideSiteOfShip(scene, session) : null;
  if (!site || toInt(container.dungeonSiteInstanceID, 0) !== site.instanceID) {
    return;
  }
  const authored = (site.template.populationHints.containers || []).find((entry) => (
    entry && entry.role === container.dungeonSiteContentRole && toInt(entry.guideTextOnOpen, 0) > 0
  ));
  if (!authored) {
    return;
  }
  site.shipEntity.dungeonGuideText = { instanceID: site.instanceID, roomKey: site.roomKey, textID: toInt(authored.guideTextOnOpen, 0) };
  openGuideWindow(session, guideAgentIDOf(site.template), authored.guideTextOnOpen);
}

// A container's approach text (populationHints.containers[].guideTextOnApproach, within
// guideApproachRangeMeters: the relic Training Container's "This is the Relic container"): the
// guide says it once per ship and container when the ship first comes that close. There is no
// player action to hook, so the site behavior tick evaluates it.
function processGuideApproachTexts(scene, instance) {
  const template = instance ? resolveTemplate(instance) : null;
  const guideAgentID = guideAgentIDOf(template);
  const authored = guideAgentID > 0
    ? (template.populationHints.containers || []).filter((entry) => entry && toInt(entry.guideTextOnApproach, 0) > 0)
    : [];
  if (authored.length <= 0 || !scene || !(scene.dynamicEntities instanceof Map)) {
    return 0;
  }
  const instanceID = toInt(instance.instanceID, 0);
  const containers = [...(Array.isArray(scene.staticEntities) ? scene.staticEntities : []), ...scene.dynamicEntities.values()]
    .filter((entity) => entity && entity.dungeonMaterializedContainer === true && entity.position &&
      toInt(entity.dungeonSiteInstanceID, 0) === instanceID);
  let said = 0;
  for (const ship of scene.dynamicEntities.values()) {
    if (!ship || ship.kind !== "ship" || !ship.session || !ship.position ||
        toInt(ship.dungeonCurrentInstanceID, 0) !== instanceID) {
      continue;
    }
    for (const container of containers) {
      const entry = authored.find((candidate) => candidate.role === container.dungeonSiteContentRole);
      const heardKey = `${instanceID}:${container.itemID}`;
      if (!entry || (ship.dungeonGuideApproachHeard && ship.dungeonGuideApproachHeard.has(heardKey))) {
        continue;
      }
      const range = Math.max(1, Number(entry.guideApproachRangeMeters) || 5_000);
      if (distanceSquared(ship.position, container.position) > range * range) {
        continue;
      }
      (ship.dungeonGuideApproachHeard ||= new Set()).add(heardKey);
      ship.dungeonGuideText = {
        instanceID,
        roomKey: normalizeText(ship.dungeonCurrentRoomKey, "room:entry"),
        textID: toInt(entry.guideTextOnApproach, 0),
      };
      openGuideWindow(ship.session, guideAgentID, entry.guideTextOnApproach);
      said += 1;
    }
  }
  return said;
}

module.exports = {
  guideTextForSession,
  onSiteContainerOpened,
  processGuideApproachTexts,
  settleSiteCompletionAchievements,
  recordAbyssalRunCompletion,
  buildCareerAbyssalNpcOutcome,
  recordCareerAbyssalRun,
  buildCurrentDungeonInfo,
  clearShipCurrentDungeonRoom,
  completeCurrentDungeonForSession,
  enterDungeonRoomForSession,
  exitCurrentDungeonForSession,
  markShipCurrentDungeonRoom,
  notifyDistributionDungeonWarp,
  notifyAcceptedDungeonWarp,
  armMidWarpTransmission,
  sendDueMidWarpTransmission,
  hasPendingMidWarpTransmission,
  notifyDungeonCompletedForScene,
  notifyDungeonValuesForScene,
  resolveTrackedDungeonForSession,
  resolveCurrentDungeonForSession,
  resolveCurrentDungeonInfoForSession,
  resolveDungeonID,
  resolveRoomID,
  sendDungeonCompletedNotification,
  sendDungeonValuesNotification,
  sendExitingDungeonNotification,
  sendEnteringDungeonRoomNotification,
  buildTransmission,
  sendRoomTransmission,
};
