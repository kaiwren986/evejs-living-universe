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
const { buildDict } = require(path.join(__dirname, "../_shared/serviceHelpers"));
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
    buildDungeonValues(instance, normalizedRoomKey, { template }),
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
    ? buildCurrentDungeonInfo(current.instance, current.roomKey)
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

function sendEnteringDungeonRoomNotification(session, instance, roomKey, options = {}) {
  if (!session || typeof session.sendNotification !== "function") {
    return false;
  }
  const info = buildCurrentDungeonInfo(instance, roomKey, options);
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
    session.sendNotification("OnEnteringDungeonRoom", "shipid", args);
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
  return true;
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
    if (sendDungeonValuesNotification(session, dungeonID, values)) {
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
  if (changed || options.forceNotify === true) {
    return sendEnteringDungeonRoomNotification(session, instance, normalizedRoomKey, options);
  }
  return false;
}

module.exports = {
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
};
