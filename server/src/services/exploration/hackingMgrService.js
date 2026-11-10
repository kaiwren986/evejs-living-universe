"use strict";

const {
  toFiniteNumber,
} = require("../../common/numbers");

const path = require("path");
const { randomUUID, randomInt } = require("node:crypto");

const BaseService = require(path.join(__dirname, "../baseService"));
const log = require(path.join(__dirname, "../../utils/logger"));
const spaceRuntime = require(path.join(__dirname, "../../space/runtime"));
const dungeonUniverseSiteService = require(path.join(
  __dirname,
  "../dungeon/dungeonUniverseSiteService",
));
const {
  canEntitiesInteractLocally,
} = require(path.join(
  __dirname,
  "../../space/destiny/identity/interactionScope.js",
));
const {
  buildKeyVal,
  buildDict,
  buildList,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const { resolveSessionCharacterID } = require("../_shared/sessionIdentity");
const { ROLE_QA, normalizeRoleValue } = require("../account/accountRoleProfiles");
const boardEngine = require("./hackingBoardEngine");
const containerState = require("./hackingContainerState");
const { getWallclockNowMs } = require("../../space/runtime/runtimeClock");

const HACKING_CONSTANTS = Object.freeze({
  GAMETYPE_HACKING: 0,
  GAMETYPE_ARCHEOLOGY: 1,
  TYPE_NONE: -1,
  TYPE_SEGMENT: 0,
  TYPE_VIRUS: 1,
  TYPE_CORE: 2,
  SUBTYPE_NONE: -1,
  SUBTYPE_CORE_LOW: 11,
  EVENT_GAME_LOST: 0,
  EVENT_GAME_WON: 1,
  EVENT_GAME_START: 2,
  EVENT_VIRUS_CREATED: 3,
  EVENT_OBJECT_KILLED: 4,
  EVENT_GAME_STYLE: 5,
  EVENT_ACK: 6,
  EVENT_TILE_FLIPPED: 100,
  EVENT_TILE_CREATED: 101,
  EVENT_ATTACK: 301,
  EVENT_CORE_CONTENTS: 400,
  HACKING_STATE_SECURE: 0,
  HACKING_STATE_BEING_HACKED: 1,
  HACKING_STATE_HACKED: 2,
  HACKING_STATE_LOCKED: 3,
});

const ACTIVE_ATTEMPTS = new Map();
let boardSeedForTests;

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function toPositiveInt(value, fallback = 0) {
  return Math.max(0, toInt(value, fallback));
}

function roundNumber(value, digits = 6) {
  return Number(toFiniteNumber(value, 0).toFixed(digits));
}

function normalizeCallArgs(args = [], fallbackArgs = []) {
  if (Array.isArray(args)) {
    return args;
  }
  if (arguments.length > 1) {
    return Array.isArray(fallbackArgs) ? fallbackArgs : [];
  }
  return [];
}

function unwrapCoord(coord) {
  const values = Array.isArray(coord) ? coord
    : coord && (coord.items || coord.value || coord.list);
  return Array.isArray(values) && values.length === 2 && values.every(Number.isSafeInteger)
    ? [...values] : null;
}

// The client indexes outer KeyVals but expands nested tile/utility records with
// Python **kwargs, which requires actual mappings rather than util.KeyVal.
function marshalHackingEventValue(value) {
  if (value === null || value === undefined || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return buildList(value.map((entry) => marshalHackingEventValue(entry)));
  }
  if (typeof value.type === "string") {
    return value;
  }
  return buildDict(
    Object.entries(value).map(([key, entry]) => [
      key,
      marshalHackingEventValue(entry),
    ]),
  );
}

function buildEvent(eventID, eventData = {}) {
  return buildKeyVal([
    ["eventID", eventID],
    ["eventData", marshalHackingEventValue(eventData)],
  ]);
}

function buildUtilityInventory(slotCount) {
  return Array.from(
    { length: Math.max(0, Math.min(8, toInt(slotCount, 0))) },
    () => ({
      id: null,
      subtype: HACKING_CONSTANTS.SUBTYPE_NONE,
      info: null,
    }),
  );
}

function getAttemptKey(session) {
  const characterID = resolveSessionCharacterID(session);
  return characterID > 0 ? String(characterID) : null;
}

function getSessionSystemID(session) {
  return toPositiveInt(
    session && (
      (session._space && session._space.systemID) ||
      session.solarsystemid2 ||
      session.solarsystemid ||
      session.systemID
    ),
    0,
  );
}

function emitHackingTurn(session, events) {
  if (
    session &&
    typeof session.sendNotification === "function" &&
    Array.isArray(events) &&
    events.length > 0
  ) {
    session.sendNotification("OnHackingTurnComplete", "clientID", [events]);
  }
}

function getSceneEntity(scene, entityID) {
  const numericEntityID = toPositiveInt(entityID, 0);
  if (!scene || numericEntityID <= 0) {
    return null;
  }
  if (typeof scene.getEntityByID === "function") {
    return scene.getEntityByID(numericEntityID);
  }
  return (
    (scene.dynamicEntities instanceof Map && scene.dynamicEntities.get(numericEntityID)) ||
    (scene.staticEntitiesByID instanceof Map && scene.staticEntitiesByID.get(numericEntityID)) ||
    null
  );
}

function getSessionShipEntity(scene, session) {
  if (!scene || !session) {
    return null;
  }
  if (typeof scene.getShipEntityForSession === "function") {
    const entity = scene.getShipEntityForSession(session);
    if (entity) {
      return entity;
    }
  }
  return getSceneEntity(
    scene,
    session && (
      (session._space && session._space.shipID) ||
      session.shipID ||
      session.shipid ||
      session.activeShipID
    ),
  );
}

function resolveContainerTarget(targetID, session) {
  const numericTargetID = toPositiveInt(targetID, 0);
  const systemID = getSessionSystemID(session);
  if (numericTargetID <= 0 || systemID <= 0) {
    return null;
  }
  const scene = spaceRuntime.getSceneForSession(session);
  const entity = getSceneEntity(scene, numericTargetID);
  const shipEntity = getSessionShipEntity(scene, session);
  if (
    !scene ||
    !entity ||
    !shipEntity ||
    !canEntitiesInteractLocally(shipEntity, entity) ||
    entity.dungeonMaterializedContainer !== true ||
    entity.dungeonMaterializedSiteContent !== true
  ) {
    return null;
  }
  if (entity.incursionControlKey && !require("../incursion/incursionLogistics").canHack(scene, shipEntity, entity)) return null;
  return {
    scene,
    entity,
    systemID,
    instanceID: toPositiveInt(entity.dungeonSiteInstanceID, 0),
  };
}

// True while the hacker can still work the container: the same local-scope rules
// that allowed the start, plus the analyzer's activation range when the start
// recorded one. Refreshes the attempt's target on success.
function refreshAttemptTarget(attempt, session) {
  if (!attempt || attempt.session !== session || getAttemptKey(session) !== attempt.key) {
    return false;
  }
  if (attempt.qa === true) {
    return true;
  }
  const shipID = toPositiveInt(session?._space?.shipID || session?.shipid || session?.shipID, 0);
  if (!shipID || shipID !== attempt.shipID) {
    return false;
  }
  const target = resolveContainerTarget(attempt.targetID, session);
  if (!target || target.entity !== attempt.target?.entity || target.scene !== attempt.target?.scene) {
    return false;
  }
  if (!isAttemptModulePresent(attempt)) return false;
  const shipEntity = getSessionShipEntity(target.scene, session);
  const locks = shipEntity?.lockedTargets;
  const locked = locks instanceof Map || locks instanceof Set
    ? locks.has(attempt.targetID) : Array.isArray(locks) && locks.includes(attempt.targetID);
  if (!locked || shipEntity.cloaked === true || Number(shipEntity.isCloaked) > 0) return false;
  const maxRangeMeters = Math.max(0, toFiniteNumber(attempt.maxRangeMeters, 0));
  if (maxRangeMeters > 0) {
    if (getEntitySurfaceDistanceMeters(shipEntity, target.entity) > maxRangeMeters + 1) {
      return false;
    }
  }
  attempt.target = target;
  return true;
}

function isAttemptModulePresent(attempt) {
  const item = require("../inventory/itemStore").findItemById(attempt.moduleItemID);
  return Boolean(item && Number(item.ownerID) === Number(attempt.key) &&
    Number(item.locationID) === attempt.shipID && Number(item.typeID) === attempt.moduleTypeID &&
    require("../fitting/liveFittingState").isShipFittingFlag(Number(item.flagID)) &&
    require("../fitting/liveFittingState").isEffectivelyOnlineModule(item));
}

function getEntityRadiusMeters(entity) {
  return Math.max(
    0,
    toFiniteNumber(
      entity && (entity.radius ?? entity.spaceRadius ?? entity.interactionRadius),
      0,
    ),
  );
}

function getEntitySurfaceDistanceMeters(sourceEntity, targetEntity) {
  const sourcePosition = sourceEntity && sourceEntity.position;
  const targetPosition = targetEntity && targetEntity.position;
  if (!sourcePosition || !targetPosition) {
    return Number.POSITIVE_INFINITY;
  }
  const dx = toFiniteNumber(sourcePosition.x, 0) - toFiniteNumber(targetPosition.x, 0);
  const dy = toFiniteNumber(sourcePosition.y, 0) - toFiniteNumber(targetPosition.y, 0);
  const dz = toFiniteNumber(sourcePosition.z, 0) - toFiniteNumber(targetPosition.z, 0);
  const centerDistance = Math.sqrt((dx ** 2) + (dy ** 2) + (dz ** 2));
  return Math.max(
    0,
    centerDistance - getEntityRadiusMeters(sourceEntity) - getEntityRadiusMeters(targetEntity),
  );
}

function markContainerState(target, state, nowMs) {
  if (!(target && target.entity)) {
    return;
  }
  containerState.setTransientState(target.entity, state, { nowMs });
  target.scene?.broadcastSlimItemChanges?.([target.entity]);
}

function handleSceneDisposed(scene) {
  const cleanup = {
    releasedAttemptCount: 0,
    resetContainerCount: 0,
  };
  if (!scene) {
    return cleanup;
  }

  for (const [attemptKey, attempt] of ACTIVE_ATTEMPTS) {
    const target = attempt && attempt.target;
    if (!target || target.scene !== scene) {
      continue;
    }

    // The attempt owns the only service-global strong reference to the scene.
    // Release it without treating collection like a failed hack: no failure
    // count, encounter trigger, container destruction, or client event applies
    // after every player has already left the scene.
    // A turn whose first write never succeeded is still transient. Already
    // committed wins retain their carrier/outbox in the dungeon owner.
    ACTIVE_ATTEMPTS.delete(attemptKey);
    cleanup.releasedAttemptCount += 1;
    if (
      target.entity &&
      target.entity.dungeonSiteContentHackingState ===
        HACKING_CONSTANTS.HACKING_STATE_BEING_HACKED
    ) {
      markContainerState(
        target,
        HACKING_CONSTANTS.HACKING_STATE_SECURE,
        getWallclockNowMs(),
      );
      delete target.entity.dungeonSiteContentHackingStartedAtMs;
      cleanup.resetContainerCount += 1;
    }
  }

  return cleanup;
}

function buildStartEvents(attempt) {
  const event = buildEvent;
  const publicTile = attempt.depotBoard
    ? require("./depotHackingBoard").publicTile : boardEngine.publicTile;
  return [
    event(HACKING_CONSTANTS.EVENT_GAME_STYLE, {
      style: attempt.gameType,
    }),
    ...attempt.tiles.map((tile) => event(
      HACKING_CONSTANTS.EVENT_TILE_CREATED,
      publicTile(tile),
    )),
    event(HACKING_CONSTANTS.EVENT_VIRUS_CREATED, {
      id: attempt.virusID,
      type: HACKING_CONSTANTS.TYPE_VIRUS,
      strength: attempt.virusStrength,
      coherence: attempt.virusCoherence,
      inventory: attempt.depotBoard ? buildUtilityInventory(attempt.virusSlots)
        : boardEngine.publicInventory(attempt.board).map(({ id, subtype, info }) => ({ id, subtype, info })),
    }),
    event(HACKING_CONSTANTS.EVENT_GAME_START, {
      moduleTypeID: attempt.moduleTypeID,
      targetID: attempt.targetID || null,
      gameType: attempt.gameType,
      difficulty: attempt.difficulty,
    }),
  ];
}

function destroyTargetContainer(target, options = {}) {
  if (!(target && target.scene && target.entity)) {
    return {
      success: false,
      errorMsg: "CONTAINER_NOT_FOUND",
    };
  }
  return dungeonUniverseSiteService.destroyMaterializedContentEntity(
    target.scene,
    target.entity,
    {
      broadcast: options.broadcast === true,
      excludedSession: options.excludedSession || null,
      nowMs: options.nowMs,
    },
  );
}

function hasHackFailureEncounter(entity) {
  return entity?.dungeonSiteContentFailureExplodes === true ||
    String(entity?.dungeonSiteContentTrigger || "").trim().toLowerCase() === "hack_failure";
}

function failContainerAttempt(attempt, session, nowMs) {
  const target = attempt && attempt.target;
  if (!(target && target.entity)) {
    return null;
  }
  // Homefront objectives are repeatable operation controls, not disposable
  // exploration loot cans. Their dedicated owner restores/reset their state.
  if (target.entity.homefrontKey) {
    markContainerState(target, HACKING_CONSTANTS.HACKING_STATE_SECURE, nowMs);
    return { success: true, data: { failureCount: 0, destroyed: false } };
  }

  const currentFailures = Math.max(0, toInt(target.entity.dungeonSiteContentFailureCount, 0));
  const policy = containerState.getFailurePolicy(target.entity);
  const committed = containerState.commitOutcome(target.entity, {
    outcomeID: attempt.outcomeID,
    outcome: "lost",
    characterID: Number(attempt.key),
    moduleItemID: attempt.moduleItemID,
    nowMs,
  });
  if (!committed?.success) throw outcomeWriteError(committed);
  // Depot and Homefront retain their own settlement owners.
  const failureCount = committed.owned === false
    ? (attempt.failureCount ??= currentFailures + 1) : committed.failureCount;
  target.entity.dungeonSiteContentFailureCount = failureCount;
  markContainerState(target, committed.owned === false
    ? HACKING_CONSTANTS.HACKING_STATE_SECURE : committed.state, nowMs);

  if (committed.owned !== false) {
    if (!retryPendingFailureEffects(target.scene, target.entity, { session, nowMs })) {
      throw new Error("HACKING_FAILURE_EFFECTS_PENDING");
    }
  } else if (hasHackFailureEncounter(target.entity)) {
    const triggered = dungeonUniverseSiteService.triggerSiteEncounter(
      target.scene,
      target.instanceID,
      "hack_failure",
      {
        nowMs,
        session,
        failedEntity: target.entity,
      },
    );
    if (triggered?.success === false) throw new Error(triggered.errorMsg || "HACKING_FAILURE_ENCOUNTER_FAILED");
  }

  const shouldDestroy = committed.owned === false
    ? !policy.neverDestroys && !policy.locksOut && (failureCount >= policy.maxFailures || policy.explodes)
    : committed.destroyed === true;
  if (shouldDestroy) {
    // A ghost-site response may already have removed this cache while
    // delivering the same loss receipt. Physical removal is idempotent too.
    if (!getSceneEntity(target.scene, target.entity.itemID) &&
        !require("../inventory/itemStore").findItemById(target.entity.itemID)) {
      return { success: true, data: { failureCount, destroyed: true } };
    }
    const destroyed = destroyTargetContainer(target, {
      broadcast: true,
      excludedSession: null,
      nowMs,
    });
    if (destroyed?.success === false) throw new Error(destroyed.errorMsg || "HACKING_CONTAINER_DESTRUCTION_FAILED");
    return destroyed;
  }

  return {
    success: true,
    data: {
      failureCount,
      destroyed: false,
    },
  };
}

// The hacker can no longer work the container: they left the site instance,
// entered warp, or fell out of the analyzer's range. Retail fails a hack whenever
// its window closes for any reason, and that failure counts toward the
// two-failure destruction exactly like a quit. A container that itself vanished
// from the scene is released without a penalty, as scene disposal already does.
function loseUnreachableAttempt(attempt, session, key, reason = "unreachable") {
  if (!attempt || attempt.completed) {
    return null;
  }
  // Once the core has fallen, interruption cannot turn that win into a loss.
  // A durable container receipt carries any unfinished secondary owner writes.
  if (attempt.pendingWin) {
    finishAction(attempt, session, key, attempt.pendingWin);
    return { reason, won: true };
  }
  attempt.pendingLossReason = reason;
  const nowMs = getWallclockNowMs();
  const target = attempt.target;
  const containerPresent = Boolean(
    target &&
    target.scene &&
    target.entity &&
    getSceneEntity(target.scene, attempt.targetID) === target.entity,
  );
  const failure = containerPresent
    ? failContainerAttempt(attempt, session, nowMs)
    : null;
  attempt.completed = true;
  ACTIVE_ATTEMPTS.delete(key);
  emitHackingTurn(session, [
    ...(attempt.pendingLossEvents || []).map(event => buildEvent(event.eventID,event.eventData)),
    buildEvent(HACKING_CONSTANTS.EVENT_GAME_LOST, {
      targetID: attempt.targetID || null,
    }),
  ]);
  if (containerPresent) {
    evaluateSiteCompletion(attempt, session, nowMs);
  }
  return { reason, containerPresent, failure };
}

// Scene tick: a hacker who warped, left the site instance, or drifted past the
// analyzer's range loses the hack now instead of on their next tile click.
function tickScene(scene) {
  if (!scene) {
    return 0;
  }
  retryPendingSuccessEffects(scene);
  const pendingFailures = scene._pendingHackingFailureEntityIDs;
  if (pendingFailures instanceof Set) {
    for (const itemID of [...pendingFailures]) {
      const entity = getSceneEntity(scene, itemID);
      if (!entity) { pendingFailures.delete(itemID); continue; }
      if (!retryPendingFailureEffects(scene, entity)) continue;
      if (containerState.isDestroyed(entity)) {
        const destroyed = destroyTargetContainer({ scene, entity }, { broadcast: true, nowMs: getWallclockNowMs() });
        if (destroyed?.success === false) continue;
      }
      pendingFailures.delete(itemID);
    }
  }
  let lost = 0;
  for (const [key, attempt] of ACTIVE_ATTEMPTS) {
    const target = attempt && attempt.target;
    if (!target || target.scene !== scene || attempt.completed || !attempt.session) {
      continue;
    }
    if (!attempt.pendingWin && !attempt.pendingLossReason && refreshAttemptTarget(attempt, attempt.session)) {
      continue;
    }
    try {
      loseUnreachableAttempt(attempt, attempt.session, key, attempt.pendingLossReason || "tick");
      lost += 1;
    } catch (error) {
      log.warn(`[hackingMgr] interrupted hack settlement will retry: ${error.message}`);
    }
  }
  return lost;
}

// Warp start: the retail hacking window closes the moment the ship enters warp.
function handleShipWarpStarted(scene, shipEntity) {
  const shipID = toPositiveInt(shipEntity && shipEntity.itemID, 0);
  if (shipID <= 0 || ACTIVE_ATTEMPTS.size === 0) {
    return 0;
  }
  let lost = 0;
  for (const [key, attempt] of ACTIVE_ATTEMPTS) {
    if (
      !attempt ||
      attempt.completed ||
      toPositiveInt(attempt.shipID, 0) !== shipID ||
      (scene && attempt.target && attempt.target.scene !== scene)
    ) {
      continue;
    }
    try {
      loseUnreachableAttempt(attempt, attempt.session || null, key, "warp");
      lost += 1;
    } catch (error) {
      log.warn(`[hackingMgr] warp hack settlement will retry: ${error.message}`);
    }
  }
  return lost;
}

// Site authority owns a timed explosion. Close its windows without recording a
// second analyzer failure; an already earned core win still crosses its barrier.
function failActiveAttemptsForSceneEntities(scene, entityIDs, reason = "site_explosion", options = {}) {
  const ids = new Set([...entityIDs].map(Number));
  let closed = 0;
  for (const [key, attempt] of ACTIVE_ATTEMPTS) {
    if (attempt.target?.scene !== scene || !ids.has(Number(attempt.targetID)) || attempt.completed) continue;
    if (attempt.pendingWin) {
      finishAction(attempt, attempt.session, key, attempt.pendingWin);
      closed += 1;
      continue;
    }
    if (options.settleWinsOnly === true) continue;
    // Its loss owner is already on this synchronous stack during hack_failure.
    if (attempt.pendingLossReason) continue;
    attempt.completed = true;
    ACTIVE_ATTEMPTS.delete(key);
    emitHackingTurn(attempt.session, [buildEvent(HACKING_CONSTANTS.EVENT_GAME_LOST, {
      targetID: attempt.targetID || null,
    })]);
    closed += 1;
  }
  return { success: true, closed, reason };
}

function beginAttempt(session, fields = {}) {
  const {
    targetID,
    gameType,
    moduleTypeID,
    difficulty,
    virusInitialCoherence,
    virusInitialStrength,
    virusSlots,
  } = fields;
  const nowMs = getWallclockNowMs();
  const key = getAttemptKey(session);
  if (!key) throw new Error("A logged-in character is required to hack.");
  const numericTargetID = toPositiveInt(targetID, 0);
  const target = resolveContainerTarget(targetID, session);
  if (target?.entity?.incursionControlKey && fields.serverAnalyzer !== true) throw new Error("Activate a fitted analyzer on this control array.");
  if (!fields.qa && (!target || fields.serverAnalyzer !== true)) {
    throw new Error("Activate a fitted analyzer on a local container.");
  }
  if (target && (containerState.isDestroyed(target.entity) ||
      containerState.getPendingFailureOutcomes(target.entity).length > 0 ||
      containerState.getState(target.entity) !== HACKING_CONSTANTS.HACKING_STATE_SECURE)) {
    throw new Error("This container is already hacked or being hacked.");
  }
  if (target && !require("../dungeon/fracturedLegacyRuntime").canHack(target.scene,
    getSessionShipEntity(target.scene, session), target.entity)) {
    throw new Error("Complete this site's mining and navigation objectives before hacking this console.");
  }
  // Starting on another container while a hack is open closes the open one the
  // way any other interruption does.
  const previous = ACTIVE_ATTEMPTS.get(key);
  if (
    previous &&
    !previous.completed
  ) {
    loseUnreachableAttempt(previous, session, key, "restart");
  }
  const depot = require("../seasons/eventHooks").depot;
  const depotRecord = depot.getRecord(target?.entity);
  if (depotRecord && (!fields.serverAnalyzer || !require("../seasons/campaignTrailCatalog").isEnabled() || depotRecord.instance.spawnState?.electionHacks?.[depotRecord.key])) {
    throw new Error("Activate a Data Analyzer on an unopened active Depot container.");
  }
  const shipEntity = target ? getSessionShipEntity(target.scene, session) : null;
  const normalizedDifficulty = Math.max(
    0,
    roundNumber(toFiniteNumber(difficulty, 1), 6),
  );
  const attempt = {
    key,
    outcomeID: randomUUID(),
    qa: fields.qa === true,
    serverAnalyzer: fields.serverAnalyzer === true,
    targetID: numericTargetID,
    target,
    session: session || null,
    shipID: toPositiveInt(shipEntity && shipEntity.itemID, 0) ||
      toPositiveInt(
        session && ((session._space && session._space.shipID) || session.shipID),
        0,
      ),
    maxRangeMeters: Math.max(0, toFiniteNumber(fields.maxRangeMeters, 0)),
    gameType: toInt(
      gameType,
      target && String(target.entity.dungeonSiteContentAnalyzer || "") === "relic"
        ? HACKING_CONSTANTS.GAMETYPE_ARCHEOLOGY
        : HACKING_CONSTANTS.GAMETYPE_HACKING,
    ),
    moduleTypeID: toPositiveInt(moduleTypeID, 0) || null,
    moduleItemID: toPositiveInt(fields.moduleItemID, 0),
    difficulty: normalizedDifficulty,
    virusCoherence: Math.max(1, toInt(virusInitialCoherence, 200)),
    virusStrength: Math.max(1, toInt(virusInitialStrength, 30)),
    virusSlots: Math.max(0, toInt(virusSlots, 3)),
    virusID: 1,
    completed: false,
    startedAtMs: nowMs,
  };
  if (!attempt.qa && (!attempt.moduleItemID || !isAttemptModulePresent(attempt) || attempt.maxRangeMeters <= 0)) {
    throw new Error("A fitted, online analyzer and its activation range are required.");
  }
  const board = boardEngine.create({
    difficulty: normalizedDifficulty,
    seed: boardSeedForTests ?? randomInt(0x100000000),
    coherence: attempt.virusCoherence,
    strength: attempt.virusStrength,
    slots: attempt.virusSlots,
    siteBoard: target?.entity?.dungeonSiteContentHackingBoard || null,
  });
  attempt.board = board;
  attempt.tiles = board.tiles;
  attempt.virusCoherence = board.virusCoherence;
  attempt.virusStrength = board.virusStrength;
  attempt.virusID = board.virusID;
  if (depotRecord) {
    attempt.depotBoard = true;
    attempt.tiles = require("./depotHackingBoard").create(target.entity.typeID);
  }
  attempt.coreCoord = attempt.tiles.find(tile => tile.type === HACKING_CONSTANTS.TYPE_CORE)?.coord;
  ACTIVE_ATTEMPTS.set(attempt.key, attempt);
  markContainerState(target, HACKING_CONSTANTS.HACKING_STATE_BEING_HACKED, nowMs);
  emitHackingTurn(session, buildStartEvents(attempt));
  return null;
}

function deliverSuccessEffects(attempt, session, nowMs) {
  const target = attempt && attempt.target;
  if (!(target && target.scene && target.entity)) {
    return null;
  }
  if (target.entity.incursionControlKey) return require("../incursion/incursionLogistics").acceptWin(target.entity, attempt.outcomeID);
  if (target.entity.homefrontKey) {
    const runtime = require("../homefront/homefrontHooks").runtime;
    attempt.preparedHomefrontHack ||= runtime.prepareHackOutcome(target.scene, target.entity,
      Number(session.characterID || session.charid), attempt.outcomeID);
    if (!attempt.preparedHomefrontHack) throw new Error("HOMEFRONT_HACK_AUTHORIZATION_FAILED");
    const delivered = runtime.objectiveEvent(
      target.scene,
      target.entity,
      Number(session.characterID || session.charid),
      "hack",
      1,
      nowMs,
      { receiptID: attempt.outcomeID, preparedHack: attempt.preparedHomefrontHack },
    );
    if (!delivered) throw new Error("HOMEFRONT_HACK_SETTLEMENT_FAILED");
    return null;
  }
  const options = {
    broadcast: true,
    excludedSession: null,
    nowMs,
    session,
  };
  const notified = dungeonUniverseSiteService.notifyMaterializedContainerHacked(target.scene, target.entity, options);
  if (notified?.success === false) throw new Error(notified.errorMsg || "HACK_SUCCESS_ENCOUNTER_PENDING");
  // A hacked container in a MISSION dungeon satisfies the mission's hack objective; only fall back to
  // the exploration data/relic signature-site completion for non-mission containers.
  const missionResult = dungeonUniverseSiteService.maybeSatisfyMissionHackObjective(
    target.scene,
    target.entity,
    options,
  );
  if (missionResult?.success === false && missionResult.reason !== "not_mission_instance") {
    throw new Error(missionResult.errorMsg || "HACK_MISSION_SETTLEMENT_PENDING");
  }
  if (missionResult && missionResult.reason !== "not_mission_instance") {
    return missionResult;
  }
  return null;
}

function outcomeWriteError(result) {
  return new Error([result?.errorMsg || "HACKING_OUTCOME_WRITE_FAILED", result?.cause].filter(Boolean).join(": "));
}

function deliverCareerWin(receipt) {
  if (!receipt?.careerWin) return;
  const career = require("../career/careerHackingEvidence").commitPreparedWin(receipt.careerWin);
  if (!career?.success) throw new Error(career?.errorMsg || "CAREER_HACK_WRITE_FAILED");
  if (career.eligible) {
    try { require("../career/careerProgress").sync(career.characterID); }
    catch (error) { log.warn(`[hackingMgr] career progress refresh failed: ${error.message}`); }
  }
}

// Loss receipts also form an outbox: a ghost encounter may fail to spawn or its
// acknowledgement may fail to flush after the container has already vanished.
function retryPendingFailureEffects(scene, entity, options = {}) {
  try {
    for (const receipt of containerState.getPendingFailureOutcomes(entity)) {
      const nowMs = receipt.nowMs || options.nowMs || getWallclockNowMs();
      if (hasHackFailureEncounter(entity)) {
        const triggered = dungeonUniverseSiteService.triggerSiteEncounter(scene,
          entity.dungeonSiteInstanceID, "hack_failure", { nowMs, session: options.session, failedEntity: entity });
        if (triggered?.success === false) throw new Error(triggered.errorMsg || "HACKING_FAILURE_ENCOUNTER_FAILED");
      }
      const marked = containerState.markFailureEffectsDelivered(entity, receipt.outcomeID, { nowMs });
      if (marked?.success === false) throw outcomeWriteError(marked);
    }
    return true;
  } catch (error) {
    (scene._pendingHackingFailureEntityIDs ||= new Set()).add(entity.itemID);
    log.warn(`[hackingMgr] failure effects will retry: ${error.message}`);
    return false;
  }
}

function evaluateSiteCompletion(attempt, session, nowMs) {
  const target = attempt?.target;
  if (!target?.scene || !target.entity || target.entity.homefrontKey || target.entity.incursionControlKey) return null;
  return dungeonUniverseSiteService.maybeCompleteMaterializedDataRelicSite(
    target.scene,
    target.entity,
    { broadcast: true, excludedSession: null, nowMs, session },
  );
}

function retryPendingSuccessEffects(scene, sourceEntity = null) {
  if (sourceEntity) {
    try {
      for (const receipt of containerState.getPendingSuccessOutcomes(sourceEntity)) {
        deliverCareerWin(receipt);
        const session = { characterID: receipt.characterID, charid: receipt.characterID };
        const attempt = { target: { scene, entity: sourceEntity }, outcomeID: receipt.outcomeID };
        deliverSuccessEffects(attempt, session, receipt.nowMs || getWallclockNowMs());
        const marked = containerState.markSuccessEffectsDelivered(sourceEntity, receipt.outcomeID);
        if (marked?.success === false) throw outcomeWriteError(marked);
      }
      return true;
    } catch (error) {
      (scene._pendingHackingSuccessEntityIDs ||= new Set()).add(sourceEntity.itemID);
      log.warn(`[hackingMgr] success effects will retry: ${error.message}`);
      return false;
    }
  }
  const pending = scene._pendingHackingSuccessEntityIDs;
  if (!(pending instanceof Set) || !pending.size) return true;
  for (const itemID of [...pending]) {
    const entity = getSceneEntity(scene, itemID);
    if (!entity) { pending.delete(itemID); continue; }
    if (retryPendingSuccessEffects(scene, entity)) {
      pending.delete(itemID);
      evaluateSiteCompletion({ target: { scene, entity } }, null, getWallclockNowMs());
    }
  }
  return pending.size === 0;
}

function settleWin(attempt, session, nowMs) {
  if (attempt.qa) return;
  const target = attempt.target;
  if (attempt.depotBoard) {
    require("../seasons/eventHooks").depot.commitHack(target.entity, session, nowMs);
  } else if (target.entity.homefrontKey) {
    // Repeating Homefront objectives have their own durable operation/receipt.
    deliverSuccessEffects(attempt, session, nowMs);
  } else {
    if (target.entity.incursionControlKey && !attempt.preparedIncursionWin) {
      attempt.preparedIncursionWin = require("../incursion/incursionLogistics").prepareWin(attempt, session);
    }
    if (!attempt.preparedCareerWin) {
      const career = require("../career/careerHackingEvidence").prepareWin(attempt, session, { nowMs });
      if (!career.success) throw new Error(career.errorMsg || "CAREER_HACK_WRITE_FAILED");
      attempt.preparedCareerWin = career;
    }
    const committed = containerState.commitOutcome(target.entity, {
      outcomeID: attempt.outcomeID, outcome: "won", characterID: Number(attempt.key),
      moduleItemID: attempt.moduleItemID, careerWin: attempt.preparedCareerWin.prepared, nowMs,
      ...(attempt.preparedIncursionWin ? { incursionWin: attempt.preparedIncursionWin } : {}),
    });
    if (!committed?.success) throw outcomeWriteError(committed);
    (target.scene._pendingHackingSuccessEntityIDs ||= new Set()).add(target.entity.itemID);
    // The container is the durable authority. Its outbox can finish career
    // evidence after a crash without needing the old fitted module or session.
    deliverCareerWin(committed.receipt);
    try {
      deliverSuccessEffects(attempt, session, nowMs);
      const marked = containerState.markSuccessEffectsDelivered(target.entity, attempt.outcomeID, { nowMs });
      if (marked?.success === false) throw new Error(marked.errorMsg || "HACK_SUCCESS_ACK_FAILED");
    } catch (error) {
      (target.scene._pendingHackingSuccessEntityIDs ||= new Set()).add(target.entity.itemID);
      log.warn(`[hackingMgr] durable win awaits success effects: ${error.message}`);
    }
  }
  markContainerState(target, HACKING_CONSTANTS.HACKING_STATE_HACKED, nowMs);
}

function performAction(session, action) {
  const key = getAttemptKey(session);
  const attempt = key && ACTIVE_ATTEMPTS.get(key);
  const ack = () => emitHackingTurn(session, [buildEvent(HACKING_CONSTANTS.EVENT_ACK)]);
  if (!attempt || attempt.completed || attempt.session !== session) { ack(); return null; }
  if (attempt.pendingWin) { finishAction(attempt, session, key, attempt.pendingWin); return null; }
  if (attempt.pendingLossReason || !refreshAttemptTarget(attempt, session)) {
    loseUnreachableAttempt(attempt, session, key, attempt.pendingLossReason || "scope");
    return null;
  }
  if (action.kind !== "virusUtility" && !action.coord) { ack(); return null; }
  const nowMs = getWallclockNowMs();
  let result;
  if (attempt.depotBoard) {
    if (action.kind !== "click") { ack(); return null; }
    result = require("./depotHackingBoard").step(attempt, action.coord);
  } else result = boardEngine.step(attempt.board, action);
  if (result.outcome === "won") attempt.pendingWin = result;
  finishAction(attempt, session, key, result, nowMs);
  return null;
}

function buildCoreContentsEvent(attempt) {
  if (attempt.qa || !attempt.target?.entity || !attempt.coreCoord) return null;
  // The live inventory is read only after durable win settlement. The native
  // tile hint reads each loot entry positionally as (typeID, quantity).
  const { listContainerItems } = require("../inventory/itemStore");
  const contentsList = listContainerItems(null, attempt.target.entity.itemID)
    .filter(item => toPositiveInt(item.typeID, 0) > 0)
    .map(item => ({ type: "tuple", items: [
      toPositiveInt(item.typeID, 0), Math.max(1, toPositiveInt(item.quantity, 1)),
    ] }));
  return buildEvent(HACKING_CONSTANTS.EVENT_CORE_CONTENTS, {
    coord: attempt.coreCoord, contentsList,
  });
}

function finishAction(attempt, session, key, result, nowMs = getWallclockNowMs()) {
  // A terminal win is latched until every required owner crosses its barrier.
  // Retrying a click, quitting or entering warp all finish that same outcome.
  if (result.outcome === "won") settleWin(attempt, session, nowMs);
  else if (result.outcome === "lost") {
    attempt.pendingLossReason = "combat";
    attempt.pendingLossEvents = result.events;
    failContainerAttempt(attempt, session, nowMs);
  }
  if (attempt.depotBoard) {
    attempt.tiles = result.tiles;
    attempt.virusCoherence = result.virusCoherence;
  } else {
    attempt.board = result.board;
    attempt.tiles = result.board.tiles;
    attempt.virusCoherence = result.board.virusCoherence;
    attempt.virusStrength = result.board.virusStrength;
  }
  const events = result.events.map(event => buildEvent(event.eventID, event.eventData));
  if (result.outcome) {
    if (result.outcome === "won") {
      const contents = buildCoreContentsEvent(attempt);
      if (contents) events.push(contents);
    }
    attempt.completed = true;
    ACTIVE_ATTEMPTS.delete(key);
    // The pure engine emits combat/utility effects; the service owns terminal
    // events, so clients never see a win before durable settlement succeeds.
    events.push(buildEvent(result.outcome === "won"
      ? HACKING_CONSTANTS.EVENT_GAME_WON : HACKING_CONSTANTS.EVENT_GAME_LOST,
    { targetID: attempt.targetID || null }));
  }
  emitHackingTurn(session, events);
  if (result.outcome) evaluateSiteCompletion(attempt, session, nowMs);
}

class HackingMgrService extends BaseService {
  constructor() {
    super("hackingMgr");
  }

  callMethod(method, args, session, kwargs, callContext = null) {
    // BaseService also dispatches plain instance methods. Analyzer admission is
    // a server-only entry point; only the native UI RPC surface is remotely callable.
    if (!["StartNewGameInstance", "ClickedOnTile", "QuitHackingAttempt",
      "UsedUtilityElement", "UsedUtilityElementOnVirus"].includes(BaseService.normalizeMethodName(method))) {
      return null;
    }
    return super.callMethod(method, args, session, kwargs, callContext);
  }

  Handle_StartNewGameInstance(args = [], session = null) {
    const [
      targetID,
      gameType,
      moduleTypeID,
      difficulty,
      virusInitialCoherence,
      virusInitialStrength,
      virusSlots,
    ] = normalizeCallArgs(args);
    const role = normalizeRoleValue(session?.role ?? session?.accountRole, 0n);
    if ((role & ROLE_QA) === 0n || (targetID !== null && targetID !== undefined)) {
      throw new Error("Activate an analyzer to hack a container. Standalone practice boards require the QA role.");
    }
    return beginAttempt(session, {
      targetID,
      gameType,
      moduleTypeID,
      difficulty,
      virusInitialCoherence,
      virusInitialStrength,
      virusSlots,
      maxRangeMeters: 0,
      qa: true,
    });
  }

  // Server-side entry used by the analyzer activation. It carries the module's
  // resolved activation range so the running hack can enforce it.
  startAnalyzerAttempt(session, context = {}) {
    return beginAttempt(session, {
      targetID: context.targetID,
      gameType: context.gameType,
      moduleTypeID: context.moduleTypeID,
      moduleItemID: context.moduleItemID,
      difficulty: context.difficulty,
      virusInitialCoherence: context.coherence,
      virusInitialStrength: context.strength,
      virusSlots: context.slots,
      maxRangeMeters: context.maxRangeMeters,
      serverAnalyzer: true,
    });
  }

  StartNewGameInstance(targetID, gameType, moduleTypeID, difficulty, coherence, strength, slots, session = null) {
    return this.Handle_StartNewGameInstance(
      [targetID, gameType, moduleTypeID, difficulty, coherence, strength, slots],
      session,
    );
  }

  Handle_ClickedOnTile(args = [], session = null) {
    const [tileCoord] = normalizeCallArgs(args);
    return performAction(session, { kind: "click", coord: unwrapCoord(tileCoord) });
  }

  ClickedOnTile(tileCoord, session = null) {
    return this.Handle_ClickedOnTile([tileCoord], session);
  }

  Handle_QuitHackingAttempt(args = [], session = null) {
    normalizeCallArgs(args);
    const key = getAttemptKey(session);
    const attempt = ACTIVE_ATTEMPTS.get(key);
    if (!attempt || attempt.completed || attempt.session !== session) {
      return null;
    }
    loseUnreachableAttempt(attempt, session, key, "quit");
    return null;
  }

  QuitHackingAttempt(session = null) {
    return this.Handle_QuitHackingAttempt([], session);
  }

  Handle_UsedUtilityElement(args = [], session = null) {
    const [index, coord] = normalizeCallArgs(args);
    return performAction(session, { kind: "utility", index, coord: unwrapCoord(coord) });
  }

  UsedUtilityElement(index, tileCoord, session = null) {
    return this.Handle_UsedUtilityElement([index, tileCoord], session);
  }

  Handle_UsedUtilityElementOnVirus(args = [], session = null) {
    const [index] = normalizeCallArgs(args);
    return performAction(session, { kind: "virusUtility", index });
  }

  UsedUtilityElementOnVirus(index, session = null) {
    return this.Handle_UsedUtilityElementOnVirus([index], session);
  }
}

HackingMgrService.handleSceneDisposed = handleSceneDisposed;
HackingMgrService.handleShipWarpStarted = handleShipWarpStarted;
HackingMgrService.failActiveAttemptsForSceneEntities = failActiveAttemptsForSceneEntities;
HackingMgrService.tickScene = tickScene;
HackingMgrService.retryPendingFailureEffects = retryPendingFailureEffects;
HackingMgrService.retryPendingSuccessEffects = retryPendingSuccessEffects;
HackingMgrService._testing = {
  buildEvent,
  clearActiveAttempts() {
    ACTIVE_ATTEMPTS.clear();
    boardSeedForTests = undefined;
  },
  constants: HACKING_CONSTANTS,
  getActiveAttemptCount() {
    return ACTIVE_ATTEMPTS.size;
  },
  getActiveAttemptSnapshot(session) {
    const attempt = ACTIVE_ATTEMPTS.get(getAttemptKey(session));
    return attempt ? structuredClone({ ...attempt, target: null, session: null }) : null;
  },
  setBoardSeed(seed) { boardSeedForTests = seed; },
  handleSceneDisposed,
  handleShipWarpStarted,
  resolveContainerTarget,
  tickScene,
};

module.exports = HackingMgrService;
