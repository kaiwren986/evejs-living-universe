"use strict";

const path = require("path");

const log = require(path.join(__dirname, "../../../utils/logger"));
const config = require(path.join(__dirname, "../../../config"));
const deadspaceWarpPolicy = require(path.join(
  __dirname,
  "../../../services/dungeon/deadspaceWarpPolicy.js",
));
const {
  entityIDsEqual,
  normalizePersistentEntityID,
} = require("../identity/entityID");
const {
  isNativeWarpDistanceTooShort,
} = require("../simulation/warp");
const {
  entityWarpIn,
  isAligningForWarp,
  isWarpish,
  setupWarpConstants,
  warpTo,
} = require("../simulation/evolve");
const {
  hasQueuedMovement,
  queueMovementCommand,
} = require("./movementQueueing");
const {
  createWarpJitter,
  pilotWarpStreamSeed,
} = require("../simulation/warpJitter");
const SAME_WARP_DESTINATION_TOLERANCE_METERS = 1;

function vectorsNearlyEqual(left, right, tolerance = SAME_WARP_DESTINATION_TOLERANCE_METERS) {
  if (!left || !right || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  return (
    Math.abs(Number(left.x || 0) - Number(right.x || 0)) <= tolerance &&
    Math.abs(Number(left.y || 0) - Number(right.y || 0)) <= tolerance &&
    Math.abs(Number(left.z || 0) - Number(right.z || 0)) <= tolerance
  );
}

// The destination context of the warp the Ball is in (aligning or warping),
// as it was asked for: `warpDestination.requestedWarp || warpDestination`, so
// a warp a sphere moved still answers to the order that asked for it, and
// repeating that order is redundant.
function getActiveWarpDestination(entity) {
  if (
    !isWarpish(entity) ||
    !entity.warpDestination ||
    typeof entity.warpDestination !== "object"
  ) {
    return null;
  }
  const { requestedWarp } = entity.warpDestination;
  return requestedWarp && typeof requestedWarp === "object"
    ? requestedWarp
    : entity.warpDestination;
}

function getActiveWarpRawDestination(entity) {
  const destination = getActiveWarpDestination(entity);
  return destination ? destination.rawDestination || null : null;
}

function getActiveWarpDestinationStaticInstanceID(entity) {
  const destination = getActiveWarpDestination(entity);
  return normalizePersistentEntityID(
    destination ? destination.destinationStaticInstanceID : null,
  );
}

function getRawWarpCommandDistance(entity, point) {
  const position = entity && entity.position ? entity.position : {};
  const destination = point && typeof point === "object" ? point : {};
  const delta = ["x", "y", "z"].map((axis) => {
    const left = Number(position[axis]);
    const right = Number(destination[axis]);
    return Number.isFinite(left) && Number.isFinite(right) ? right - left : 0;
  });
  return Math.hypot(...delta);
}

function getActiveWarpDestinationDungeonRoomKey(entity) {
  const destination = getActiveWarpDestination(entity);
  return String(
    destination ? destination.destinationDungeonRoomKey || "" : "",
  ).trim() || null;
}

function getActiveWarpDestinationDungeonSiteID(entity) {
  const destination = getActiveWarpDestination(entity);
  return normalizePersistentEntityID(
    destination ? destination.destinationDungeonSiteID : null,
  );
}

function destinationInstanceIDsEqual(left, right) {
  return left === null
    ? right === null
    : right !== null && entityIDsEqual(left, right);
}

function isRedundantWarpToPoint(
  entity,
  point,
  destinationStaticInstanceID,
  destinationDungeonRoomKey = null,
  destinationDungeonSiteID = null,
) {
  return (
    vectorsNearlyEqual(getActiveWarpRawDestination(entity), point) &&
    destinationInstanceIDsEqual(
      getActiveWarpDestinationStaticInstanceID(entity),
      destinationStaticInstanceID,
    ) &&
    getActiveWarpDestinationDungeonRoomKey(entity) === (
      String(destinationDungeonRoomKey || "").trim() || null
    ) &&
    destinationInstanceIDsEqual(
      getActiveWarpDestinationDungeonSiteID(entity),
      normalizePersistentEntityID(destinationDungeonSiteID),
    )
  );
}

function resolveCommandDestinationStaticInstanceID(
  runtime,
  session,
  options = {},
) {
  const hasRequestedRoomKey = Object.prototype.hasOwnProperty.call(
    options,
    "destinationDungeonRoomKey",
  );
  const hasRequestedSiteID = Object.prototype.hasOwnProperty.call(
    options,
    "destinationDungeonSiteID",
  );
  if (!Object.prototype.hasOwnProperty.call(
    options,
    "destinationStaticInstanceID",
  )) {
    if (hasRequestedRoomKey || hasRequestedSiteID) {
      return {
        success: false,
        errorMsg: "DUNGEON_INSTANCE_NOT_AUTHORIZED",
      };
    }
    return {
      success: true,
      instanceID: null,
      roomKey: null,
      siteID: null,
    };
  }
  const requestedInstanceID = normalizePersistentEntityID(
    options.destinationStaticInstanceID,
  );
  const hasContextResolver = typeof runtime
    .resolveAuthorizedDestinationDungeonContext === "function";
  const hasInstanceResolver = typeof runtime
    .resolveAuthorizedDestinationStaticInstanceID === "function";
  if (
    requestedInstanceID === null ||
    (!hasContextResolver && !hasInstanceResolver)
  ) {
    return {
      success: false,
      errorMsg: "DUNGEON_INSTANCE_NOT_AUTHORIZED",
    };
  }
  let authorizedInstanceID = null;
  let roomKey = null;
  let siteID = null;
  if (hasContextResolver) {
    const context = runtime.resolveAuthorizedDestinationDungeonContext(
      session,
      requestedInstanceID,
      {
        ...(hasRequestedRoomKey
          ? { roomKey: options.destinationDungeonRoomKey }
          : {}),
        ...(hasRequestedSiteID
          ? { siteID: options.destinationDungeonSiteID }
          : {}),
      },
    );
    authorizedInstanceID = normalizePersistentEntityID(
      context && context.instanceID,
    );
    roomKey = String(context && context.roomKey || "").trim() || null;
    siteID = normalizePersistentEntityID(context && context.siteID);
  } else if (!hasRequestedRoomKey && !hasRequestedSiteID) {
    authorizedInstanceID = normalizePersistentEntityID(
      runtime.resolveAuthorizedDestinationStaticInstanceID(
        session,
        requestedInstanceID,
      ),
    );
  }
  if (
    authorizedInstanceID === null ||
    !entityIDsEqual(authorizedInstanceID, requestedInstanceID)
  ) {
    return {
      success: false,
      errorMsg: "DUNGEON_INSTANCE_NOT_AUTHORIZED",
    };
  }
  return {
    success: true,
    instanceID: authorizedInstanceID,
    roomKey,
    siteID,
  };
}

// Fails closed. A `typeof` guard here would skip the cloak rule silently when
// the scene lacks the method, letting a standard cloak carry a ship into warp
// with no error anywhere — the same silent-skip that let a stale fake scene pass
// wormholeParity while the assertion it was supposed to make never ran. A scene
// that cannot answer this is a broken build, so say so instead of guessing.
function isWarpBlockedByCloak(runtime, entity) {
  if (typeof runtime.isEntityWarpBlockedByCloak !== "function") {
    throw new Error(
      "Scene is missing isEntityWarpBlockedByCloak, so the cloak/warp rule cannot be enforced.",
    );
  }
  return runtime.isEntityWarpBlockedByCloak(entity);
}

// The scramble gate: a warp scrambled ship cannot warp. Asked when the
// warp is ordered, again when the queued warp applies (a scramble can land in
// between), and at every Destiny tick while the ship aligns. Fails closed, like
// the cloak rule above.
function isWarpBlockedByScramble(runtime, entity) {
  if (typeof runtime.isShipWarpScrambled !== "function") {
    throw new Error(
      "Scene is missing isShipWarpScrambled, so the scramble/warp rule cannot be enforced.",
    );
  }
  return runtime.isShipWarpScrambled(entity) === true;
}

function resolveDungeonEntryWarpTarget(runtime, instance) {
  const instanceID = normalizePersistentEntityID(instance && instance.instanceID);
  if (instanceID === null) {
    return null;
  }
  const candidates = [];
  const seenEntityIDs = new Set();
  const appendGate = (entity) => {
    const entityID = normalizePersistentEntityID(entity && entity.itemID);
    const entityInstanceID = normalizePersistentEntityID(
      entity && entity.dungeonSiteInstanceID,
    );
    if (
      !entity ||
      entity.dungeonMaterializedGate !== true ||
      entityID === null ||
      entityInstanceID === null ||
      !entityIDsEqual(entityInstanceID, instanceID) ||
      seenEntityIDs.has(entityID.toString())
    ) {
      return;
    }
    seenEntityIDs.add(entityID.toString());
    candidates.push(entity);
  };
  for (const entity of Array.isArray(runtime && runtime.staticEntities)
    ? runtime.staticEntities
    : []) {
    appendGate(entity);
  }
  if (runtime && runtime.staticEntitiesByID instanceof Map) {
    for (const entity of runtime.staticEntitiesByID.values()) {
      appendGate(entity);
    }
  }
  if (candidates.length <= 0) {
    return null;
  }

  candidates.sort((left, right) => (
    Number(left && left.itemID) - Number(right && right.itemID)
  ));
  const destinationRoomKeys = new Set(
    candidates
      .map((gate) => String(gate.dungeonGateDestinationRoomKey || "").trim())
      .filter(Boolean),
  );
  const activeAuthoredRoomKeys = new Set(
    Object.entries(
      instance && instance.roomStatesByKey &&
      typeof instance.roomStatesByKey === "object"
        ? instance.roomStatesByKey
        : {},
    )
      .filter(([, roomState]) => (
        String(
          roomState && roomState.metadata &&
          roomState.metadata.rawRoomProfile &&
          roomState.metadata.rawRoomProfile.initialState || "",
        ).trim().toLowerCase() === "active"
      ))
      .map(([roomKey]) => roomKey),
  );
  const selectedGate =
    candidates.find((gate) => activeAuthoredRoomKeys.has(
      String(gate.dungeonGateSourceRoomKey || "").trim(),
    )) ||
    candidates.find((gate) => {
      const sourceRoomKey = String(
        gate.dungeonGateSourceRoomKey || "",
      ).trim();
      return sourceRoomKey && !destinationRoomKeys.has(sourceRoomKey);
    }) ||
    candidates[0];
  const position = selectedGate && selectedGate.position;
  if (!position || typeof position !== "object") {
    return null;
  }
  const point = {
    x: Number(position.x),
    y: Number(position.y),
    z: Number(position.z),
  };
  if (!Object.values(point).every(Number.isFinite)) {
    return null;
  }
  return {
    destinationDungeonRoomKey: String(
      selectedGate.dungeonGateSourceRoomKey || "",
    ).trim() || null,
    destinationDungeonSiteID:
      selectedGate.dungeonSiteID ??
      (instance.metadata && instance.metadata.siteID) ??
      null,
    point,
    targetEntityID: selectedGate.itemID,
  };
}

// A warp order: one WarpTo, queued like any order and
// applied at the next Destiny tick's doPreTick, where the Ball becomes a WARP
// Ball aligning with effectStamp -1. Evolve does the rest on the server and on
// every client alike, from effectStamp and the tick counter: the align, the
// activation, the curve and the drop. Nothing more is sent for the warp.
//
// Beside the Ball, gameplay keeps the order's destination context on
// `entity.warpDestination` (what was asked for, what is there): the landing,
// the dungeon room and the fleet warp read it.
function createMovementWarpCommands(deps = {}) {
  const {
    armMovementTrace,
    cloneVector,
    destiny,
    evaluateDeadspaceWarp = deadspaceWarpPolicy.evaluateDeadspaceWarp,
    getClientParityWarpInPoint,
    getStargateWarpLandingPoint,
    getStationWarpTargetPosition,
    getTargetMotionPosition,
    getWarpStopDistanceForTarget,
    gotoPointEntity,
    findActiveWarpDisruptorForEntity,
    resolveWarpSphereOutcome,
    logMovementDebug,
    logWarpDebug,
    normalizeVector,
    prewarmStartupControllersForWarpDestination,
    persistShipEntity,
    resolveStargateWarpTarget,
    subtractVectors,
    tagUpdatesRequireExistingVisibility,
    toFiniteNumber = (value, fallback = 0) => {
      const numeric = Number(value);
      return Number.isFinite(numeric) ? numeric : fallback;
    },
    // A warp's own random stream from its seed; by default
    // common/random's createRng, through createWarpJitter. Tests inject one.
    createWarpRandom,
    MIN_WARP_DISTANCE_METERS,
  } = deps;
  const serviceMinimumWarpDistanceMeters = Math.max(
    0,
    toFiniteNumber(MIN_WARP_DISTANCE_METERS, 150_000),
  );
  // Each ship's count of warp streams made, a part of the next one's seed.
  const warpStreamCounts = new WeakMap();

  // A pilot warp's own stream: a createRng stream seeded from the
  // ship's ID, the tick and the ship's order count, never the server's
  // shared stream. Its jitter and, for a stargate, its landing's scatter
  // draw from it.
  function createPilotWarpStream(runtime, entity) {
    const count = (warpStreamCounts.get(entity) || 0) + 1;
    warpStreamCounts.set(entity, count);
    const seed = pilotWarpStreamSeed(
      entity.itemID,
      runtime.getCurrentSimTimeMs(),
      count,
    );
    return createWarpJitter(
      seed,
      typeof createWarpRandom === "function" ? { random: createWarpRandom(seed) } : {},
    );
  }

  function resolveWarpSpeedAU(entity, explicitWarpSpeedAU) {
    const explicit = toFiniteNumber(explicitWarpSpeedAU, 0);
    const authored = toFiniteNumber(entity && entity.warpSpeedAU, 0);
    const requested = explicit > 0 ? explicit : authored > 0 ? authored : 3;
    const roundedFactor = Math.round(requested * 1000);
    return Number.isFinite(roundedFactor) && roundedFactor > 0
      ? Math.max(1, roundedFactor) / 1000
      : 3;
  }

  // What a warp order asks for, worked out from where the Ball is now.
  function buildWarpRequest(entity, destination, options = {}) {
    const rawDestination = cloneVector(destination, entity.position);
    const stopDistance = Math.max(0, toFiniteNumber(options.stopDistance, 0));
    const direction = normalizeVector(
      subtractVectors(rawDestination, entity.position),
      entity.direction,
    );
    const targetPoint = subtractVectors(rawDestination, {
      x: direction.x * stopDistance,
      y: direction.y * stopDistance,
      z: direction.z * stopDistance,
    });
    const warpSpeedAU = resolveWarpSpeedAU(entity, options.warpSpeedAU);
    return {
      rawDestination,
      stopDistance,
      targetPoint,
      totalDistance: getRawWarpCommandDistance(entity, targetPoint),
      warpSpeedAU,
      warpFactor: Math.max(1, Math.round(warpSpeedAU * 1000)),
      targetEntityID: toFiniteNumber(options.targetEntityID, 0) || null,
      destinationStaticInstanceID: normalizePersistentEntityID(
        options.destinationStaticInstanceID,
      ),
      destinationDungeonRoomKey:
        String(options.destinationDungeonRoomKey || "").trim() || null,
      destinationDungeonSiteID: normalizePersistentEntityID(
        options.destinationDungeonSiteID,
      ),
      nativeGoto: isNativeWarpDistanceTooShort(
        getRawWarpCommandDistance(entity, rawDestination),
      ),
    };
  }

  // The order, as doPreTick applies it: WarpTo on the Ball, its destination
  // context kept for gameplay. Returns the engine's answer.
  function applyWarpOrder(runtime, entity, request) {
    const result = warpTo(entity, request.rawDestination, {
      minRange: request.stopDistance,
      warpFactor: request.warpFactor,
    });
    if (result.ignored || result.noop) {
      return result;
    }
    entity.orbitDistance = 0;
    entity.dockingTargetID = null;
    entity.speedFraction = 1;
    if (result.warp) {
      entity.warpDestination = {
        rawDestination: cloneVector(request.rawDestination),
        stopDistance: request.stopDistance,
        targetPoint: cloneVector(request.targetPoint),
        targetEntityID: request.targetEntityID,
        destinationStaticInstanceID: request.destinationStaticInstanceID,
        destinationDungeonRoomKey: request.destinationDungeonRoomKey,
        destinationDungeonSiteID: request.destinationDungeonSiteID,
        warpSpeedAU: request.warpSpeedAU,
        warpDisruptorID: request.warpDisruptorID || null,
        requestedWarp: request.requested || null,
        ignoreWarpDisruptionField: request.ignoreWarpDisruptionField === true,
        requestedAtMs: runtime.getCurrentSimTimeMs(),
        activatedAtMs: null,
        origin: null,
      };
    }
    return result;
  }

  // The Warp outcome for the order (retail's ApplyWarpDisruptors,
  // Client/behaviors/entity.py L52-68): for the path from the Ball to its
  // landing point (the destination after warp-at range, the request's
  // targetPoint), the one
  // sphere that stops or drags the warp moves it to the outcome's landing
  // point, with no warp-at range, before the warp is given to Destiny. The
  // WarpTo every Observer gets then carries that point (spaceMgr.py
  // L392-403, L601-624), so Server's and every client's Evolve fly the same
  // warp, wherever the landing point lies. A
  // warp moved by a sphere lands in open space: it keeps none of its
  // destination's context (target, dungeon room, instance), and keeps the
  // warp it asked for as `requested`.
  function applyWarpOutcome(runtime, entity, request) {
    if (typeof resolveWarpSphereOutcome !== "function") {
      return { success: true, request };
    }
    const outcome = resolveWarpSphereOutcome(
      runtime,
      entity,
      entity.position,
      request.targetPoint,
      { nowMs: runtime.getCurrentSimTimeMs() },
    );
    if (!outcome || !outcome.landingPoint) {
      return { success: true, request };
    }
    const landingDistanceMeters = toFiniteNumber(
      outcome.landingDistanceMeters,
      getRawWarpCommandDistance(entity, outcome.landingPoint),
    );
    // A path the sphere cuts short of a warp is refused, as retail's
    // ApplyWarpDisruptors raises ("Warp path too short due to bubble
    // disruptor", behaviors/entity.py L63-66).
    if (landingDistanceMeters < serviceMinimumWarpDistanceMeters) {
      return {
        success: false,
        errorMsg: "WARP_DISTANCE_TOO_CLOSE",
        data: { disruptorID: outcome.disruptorID || null },
      };
    }
    return {
      success: true,
      request: {
        ...request,
        rawDestination: cloneVector(outcome.landingPoint),
        stopDistance: 0,
        targetPoint: cloneVector(outcome.landingPoint),
        totalDistance: landingDistanceMeters,
        targetEntityID: null,
        destinationStaticInstanceID: null,
        destinationDungeonRoomKey: null,
        destinationDungeonSiteID: null,
        nativeGoto: false,
        warpDisruptorID: outcome.disruptorID || null,
        // What the warp asked for before any sphere: a repeated
        // order compares against it, and a fleet warp's followers take their
        // destination from it.
        requested: request.requested || describeRequestedWarp(request),
      },
    };
  }

  // The sphere rules of a sessionless warp (a fighter's, an NPC's), as
  // retail's NPCWarpTo (behaviors/entity.py L52-72): a Ball inside an active
  // sphere is refused, then the Warp outcome for its path moves or refuses
  // the warp (applyWarpOutcome). `{ success, request }`, or the refusal.
  function applyWarpSpheres(runtime, entity, request) {
    if (typeof findActiveWarpDisruptorForEntity !== "function") {
      return { success: true, request };
    }
    const disruptor = findActiveWarpDisruptorForEntity(runtime, entity, {
      nowMs: runtime.getCurrentSimTimeMs(),
    });
    if (disruptor) {
      return {
        success: false,
        errorMsg: "WARP_DISRUPTED_BY_BUBBLE",
        data: disruptor,
      };
    }
    return applyWarpOutcome(runtime, entity, request);
  }

  // A pilot warp's jitter: asked
  // again for the point the Ball is already aligning or warping to (or has
  // queued), it keeps that warp's offset, even over an offset the caller
  // gives, so the order stays a no-op (a fleet warp sent
  // again). Otherwise `fresh`, an offset the caller gives (a fleet
  // warp's per-ship one, the queued apply's replay of its order's), is used
  // as given; else a new offset within 2,500 m from the warp's own stream.
  function resolveWarpJitter(runtime, entity, rawPoint, fresh = null) {
    if (!entity) {
      return fresh ? { ...fresh } : null;
    }
    const previous = entity.warpJitterOrder;
    if (
      previous &&
      rawPoint &&
      (isWarpish(entity) || hasQueuedMovement(runtime, entity)) &&
      vectorsNearlyEqual(previous.askedPoint, rawPoint)
    ) {
      return { ...previous.offset };
    }
    return fresh ? { ...fresh } : createPilotWarpStream(runtime, entity).next();
  }

  // The parts of a warp request a sphere changes, as asked for.
  function describeRequestedWarp(request) {
    return {
      rawDestination: cloneVector(request.rawDestination),
      stopDistance: request.stopDistance,
      targetPoint: cloneVector(request.targetPoint),
      targetEntityID: request.targetEntityID,
      destinationStaticInstanceID: request.destinationStaticInstanceID,
      destinationDungeonRoomKey: request.destinationDungeonRoomKey,
      destinationDungeonSiteID: request.destinationDungeonSiteID,
    };
  }

  // What every Observer of the Ball gets for the order, at the tick it
  // applies, in TQ's order: the warp's FX (an acceleration gate's first),
  // the speed it aligns at, then the WarpTo. TQ logs ("Warping to citadel and
  // docking fully" 25368, "Autopilot thru a few systems" 32458) send
  // OnSpecialFX(effects.Warping), SetSpeedFraction(1.0), WarpTo on one stamp.
  // The warp it starts is never re-pointed afterwards.
  function buildWarpOrderUpdates(entity, request, stamp, options = {}) {
    const updates = [];
    if (
      options.missionGateEffectSourceID !== undefined &&
      options.missionGateEffectSourceID !== null
    ) {
      updates.push({
        stamp,
        payload: destiny.buildOnSpecialFXPayload(
          options.missionGateEffectSourceID,
          "effects.WarpGateEffect",
          { targetID: entity.itemID, active: false },
        ),
      });
    }
    updates.push({
      stamp,
      payload: destiny.buildOnSpecialFXPayload(entity.itemID, "effects.Warping", {
        active: false,
      }),
    });
    updates.push(...tagUpdatesRequireExistingVisibility([
      {
        stamp,
        payload: destiny.buildSetSpeedFractionPayload(entity.itemID, 1),
      },
      {
        stamp,
        payload: destiny.buildWarpToPayload(
          entity.itemID,
          request.rawDestination,
          request.stopDistance,
          request.warpFactor,
        ),
      },
    ]));
    return updates;
  }

  function routeNativeGotoFallback(runtime, entity, request, now, options = {}) {
    if (typeof gotoPointEntity !== "function") {
      return {
        success: false,
        errorMsg: "NATIVE_GOTO_FALLBACK_UNAVAILABLE",
      };
    }
    const routed = gotoPointEntity(runtime, entity, request.rawDestination, {
      ...options,
      nowMs: now,
      commandSource: "nativeWarpFallback",
    });
    if (routed !== true) {
      return {
        success: false,
        errorMsg: "NATIVE_GOTO_FALLBACK_FAILED",
      };
    }
    logMovementDebug("warp.native-goto", entity, {
      rawDestination: request.rawDestination,
    });
    return {
      success: true,
      data: request,
      nativeGotoFallback: true,
    };
  }

  function isRedundantWarpOrder(runtime, entity, request) {
    return (
      !request.nativeGoto &&
      !hasQueuedMovement(runtime, entity) &&
      isRedundantWarpToPoint(
        entity,
        request.rawDestination,
        request.destinationStaticInstanceID,
        request.destinationDungeonRoomKey,
        request.destinationDungeonSiteID,
      )
    );
  }

  // Applies a validated order now (the queue is being applied, or the Ball
  // has not joined the movement yet) and tells every Observer.
  function issueWarpOrder(runtime, entity, request, options = {}) {
    const now = runtime.getCurrentSimTimeMs();
    if (request.nativeGoto) {
      return routeNativeGotoFallback(runtime, entity, request, now, options);
    }
    const result = applyWarpOrder(runtime, entity, request);
    if (result.ignored) {
      return { success: false, errorMsg: "WARP_DESTINATION_INVALID" };
    }
    if (result.noop) {
      return { success: true, data: request, redundant: true };
    }
    persistShipEntity(entity);
    armMovementTrace(entity, "warp", { request }, now);
    logMovementDebug("warp.requested", entity);
    logWarpDebug("warp.requested", entity, {
      totalDistance: request.totalDistance,
      warpFactor: request.warpFactor,
    });
    sendWarpUpdates(
      runtime,
      entity,
      buildWarpOrderUpdates(entity, request, runtime.nextDestinyStamp, options),
    );
    return { success: true, data: request };
  }

  // The order's updates to the Ball's Grid bubble history: every Observer of
  // the Ball, its pilot included, gets the one action.
  function sendWarpUpdates(runtime, entity, updates) {
    runtime.queueBubbleHistory(updates);
  }

  // EntityWarpIn, as doPreTick applies it: the Ball enters warp at once, its
  // curve five ticks in, and every Observer gets the one action.
  function issueEntityWarpIn(runtime, entity, request, options = {}) {
    const now = runtime.getCurrentSimTimeMs();
    entity.orbitDistance = 0;
    entity.dockingTargetID = null;
    const result = entityWarpIn(entity, request.targetPoint, {
      warpFactor: request.warpFactor,
      currentTime: runtime.nextDestinyStamp,
    });
    if (result.ignored) {
      return { success: false, errorMsg: "WARP_DESTINATION_INVALID" };
    }
    entity.speedFraction = 1;
    entity.warpDestination = {
      rawDestination: cloneVector(request.rawDestination),
      stopDistance: request.stopDistance,
      targetPoint: cloneVector(request.targetPoint),
      targetEntityID: request.targetEntityID,
      destinationStaticInstanceID: request.destinationStaticInstanceID,
      destinationDungeonRoomKey: request.destinationDungeonRoomKey,
      destinationDungeonSiteID: request.destinationDungeonSiteID,
      warpSpeedAU: request.warpSpeedAU,
      warpDisruptorID: request.warpDisruptorID || null,
      requestedWarp: request.requested || null,
      requestedAtMs: now,
      activatedAtMs: null,
      origin: null,
    };
    if (result.warpIn && typeof runtime.handleWarpActivated === "function") {
      runtime.handleWarpActivated(entity, { simTimeMs: now });
    }
    persistShipEntity(entity);
    const stamp = runtime.nextDestinyStamp;
    const updates = tagUpdatesRequireExistingVisibility([
      {
        stamp,
        payload: destiny.buildEntityWarpInPayload(
          entity.itemID,
          request.targetPoint,
          request.warpFactor,
        ),
      },
    ]);
    if (
      options.missionGateEffectSourceID !== undefined &&
      options.missionGateEffectSourceID !== null
    ) {
      updates.push({
        stamp,
        payload: destiny.buildOnSpecialFXPayload(
          options.missionGateEffectSourceID,
          "effects.WarpGateEffect",
          { targetID: entity.itemID, active: false },
        ),
      });
    }
    sendWarpUpdates(runtime, entity, updates);
    logMovementDebug("warp.entity-warp-in", entity, {
      effectStamp: entity.effectStamp,
    });
    return {
      success: true,
      data: {
        entity,
        request,
        ingressCompleteAtMs: now + estimateWarpDurationMs(entity),
      },
    };
  }

  // How long the warp the Ball is in lasts, from its constants.
  function estimateWarpDurationMs(entity) {
    const constants = setupWarpConstants(entity.warpFactor, entity.warpDistance);
    return Math.max(
      0,
      (constants.accelTime + constants.cruiseTime + constants.decelTime) * 1000,
    );
  }

  const commands = {
    warpToEntity(runtime, session, targetEntityID, options = {}) {
      const entity = runtime.getShipEntityForSession(session);
      const target = runtime.getEntityByID(targetEntityID);
      if (!entity || !target) {
        return {
          success: false,
          errorMsg: "TARGET_NOT_FOUND",
        };
      }

      const targetInstanceID = normalizePersistentEntityID(
        target.dungeonSiteInstanceID ??
        target.airNpeInstanceID ??
        (target.kind === "ship" ? target.dungeonCurrentInstanceID : null),
      );
      if (targetInstanceID !== null) {
        const destinationResolution = resolveCommandDestinationStaticInstanceID(
          runtime,
          session,
          options,
        );
        if (
          destinationResolution.success !== true ||
          destinationResolution.instanceID === null ||
          !entityIDsEqual(destinationResolution.instanceID, targetInstanceID)
        ) {
          return {
            success: false,
            errorMsg: "DUNGEON_INSTANCE_NOT_AUTHORIZED",
          };
        }
      }
      if (
        typeof runtime.canSessionSeeDungeonScopedEntity === "function" &&
        !runtime.canSessionSeeDungeonScopedEntity(session, target, {
          ...(targetInstanceID !== null
            ? {
                dedicatedSiteStaticInstanceIDOverride:
                  targetInstanceID,
              }
            : {}),
        })
      ) {
        return {
          success: false,
          errorMsg: "TARGET_NOT_FOUND",
        };
      }

      if (target.kind === "stargate") {
        // The gate's surface point toward the ship, with no scatter of its
        // own: the warp's jitter moves it, as every warp's, so a warp to 0
        // lands within 2,500 m of the surface, in jump range.
        const stargateWarpTarget =
          typeof resolveStargateWarpTarget === "function"
            ? resolveStargateWarpTarget(
                entity,
                target,
                toFiniteNumber(options.minimumRange, 0),
                { scatter: false },
              )
            : {
                rawDestination: getStargateWarpLandingPoint(
                  entity,
                  target,
                  toFiniteNumber(options.minimumRange, 0),
                  { random: () => 0 },
                ),
                stopDistance: 0,
              };
        return runtime.warpToPoint(
          session,
          stargateWarpTarget.rawDestination,
          {
            ...options,
            stopDistance: Math.max(
              0,
              toFiniteNumber(stargateWarpTarget.stopDistance, 0),
            ),
            targetEntityID: target.itemID,
          },
        );
      }

      const clientParityWarpInPoint =
        typeof getClientParityWarpInPoint === "function"
          ? getClientParityWarpInPoint(target)
          : null;
      if (clientParityWarpInPoint) {
        return runtime.warpToPoint(session, clientParityWarpInPoint, {
          ...options,
          stopDistance: Math.max(0, toFiniteNumber(options.minimumRange, 0)),
          targetEntityID: target.itemID,
        });
      }

      const stopDistance = getWarpStopDistanceForTarget(
        entity,
        target,
        toFiniteNumber(options.minimumRange, 0),
      );
      const dockable = Boolean(
        target && (target.kind === "station" || target.kind === "structure"),
      );
      const warpTargetPoint = dockable
        ? getStationWarpTargetPosition(target, {
            shipTypeID: entity.typeID,
            selectionKey: entity.itemID,
          })
        : getTargetMotionPosition(target);
      return runtime.warpToPoint(session, warpTargetPoint, {
        ...options,
        stopDistance,
        targetEntityID: target.itemID,
        // Jittered like every warp, whatever the target (stations, structures
        // and other targets used within a range included).
      });
    },

    // A pilot's warp to a point (warpToPointChecked). A refusal reports the
    // warp it asked for (`requested`, as a pulled order does), so a fleet
    // warp whose commander is refused can still send its members there:
    // the members' own warps are checked on their own.
    //
    // Every pilot warp is jittered: its destination is moved by a
    // random offset within 2,500 m, so the sphere test and the warp-at range
    // see the jittered point, as retail jitters before ApplyWarpDisruptors
    // (behaviors/entity.py L53-70). The distance checks (the 150 km minimum,
    // the deadspace check) read the point asked for, so the same order
    // gets the same answer every time (warpToPointChecked). `options.warpJitter`
    // gives the offset for a new order (a fleet warp's per-ship one; the
    // queued apply's replay of its order's), or null for none; every target is
    // jittered. A warp, a fleet warp's included, asked again for the
    // point the Ball already goes to keeps that warp's offset.
    warpToPoint(runtime, session, rawPoint, rawOptions = {}) {
      const { warpJitter: givenJitter, ...options } = rawOptions || {};
      const entity = runtime.getShipEntityForSession(session);
      const warpJitter = givenJitter === null
        ? null
        : resolveWarpJitter(runtime, entity, rawPoint, givenJitter);
      const point = warpJitter && rawPoint && typeof rawPoint === "object"
        ? {
          x: toFiniteNumber(rawPoint.x, 0) + toFiniteNumber(warpJitter.x, 0),
          y: toFiniteNumber(rawPoint.y, 0) + toFiniteNumber(warpJitter.y, 0),
          z: toFiniteNumber(rawPoint.z, 0) + toFiniteNumber(warpJitter.z, 0),
        }
        : rawPoint;
      const result = commands.warpToPointChecked(runtime, session, rawPoint, {
        ...options,
        warpJitter: warpJitter || null,
      });
      if (entity && result && result.success === true && warpJitter && rawPoint) {
        entity.warpJitterOrder = {
          askedPoint: cloneVector(rawPoint),
          offset: { ...warpJitter },
        };
      }
      // The offset the order took, or null: a fleet warp places its members
      // around the commander's destination before its jitter.
      if (result && typeof result === "object") {
        result.warpJitter = warpJitter ? { ...warpJitter } : null;
      }
      if (result && result.success === false && !result.requested) {
        const entity = runtime.getShipEntityForSession(session);
        if (entity && point && typeof point === "object") {
          result.requested = describeRequestedWarp(buildWarpRequest(entity, point, {
            stopDistance: options.stopDistance,
            targetEntityID: options.targetEntityID,
            destinationStaticInstanceID: options.destinationStaticInstanceID,
            destinationDungeonRoomKey: options.destinationDungeonRoomKey,
            destinationDungeonSiteID: options.destinationDungeonSiteID,
          }));
        }
      }
      return result;
    },

    // `point` is the destination asked for; `options.warpJitter` the offset
    // the warp itself goes by. The distance checks read `point`.
    warpToPointChecked(runtime, session, point, options = {}) {
      const warpJitter = options.warpJitter || null;
      const entity = runtime.getShipEntityForSession(session);
      if (!entity || entity.pendingDock) {
        return {
          success: false,
          errorMsg: "SHIP_NOT_FOUND",
        };
      }

      // A standard cloaking device holds the ship out of warp: the pilot must
      // decloak first. Warp-safe (covert ops) cloaks carry the ship into warp
      // and so never block the command.
      if (require("../../../services/seasons/eventHooks").fabricator.disruption(runtime,entity)) {
        return {success:false,errorMsg:"WARP_DISRUPTED_BY_BUBBLE"};
      }
      if (isWarpBlockedByCloak(runtime, entity)) {
        return {
          success: false,
          errorMsg: "WARP_BLOCKED_BY_CLOAK",
        };
      }

      // Checked again when the queued warp applies: a refusal then is logged
      // by the queue.
      if (isWarpBlockedByScramble(runtime, entity)) {
        return {
          success: false,
          errorMsg: "WARP_SCRAMBLED",
        };
      }

      const destinationResolution = resolveCommandDestinationStaticInstanceID(
        runtime,
        session,
        options,
      );
      if (destinationResolution.success !== true) {
        return destinationResolution;
      }
      let destinationStaticInstanceID = destinationResolution.instanceID;
      let destinationDungeonRoomKey = destinationResolution.roomKey;
      let destinationDungeonSiteID = destinationResolution.siteID;
      let effectiveWarpOptions = options;

      // Deadspace (mission-pocket) warp restriction: gates are the only way between rooms, and
      // you cannot warp within a complex. Gate transit warps pass options.dungeonGateTransit.
      // It reads the point asked for, not the jittered one. A clamped warp
      // goes to the site's entry as the check gives it, jittered like every
      // warp.
      let warpPoint = point;
      if (
        config.deadspaceWarpRestrictionEnabled !== false &&
        options.dungeonGateTransit !== true &&
        options.ignoreDeadspaceWarpRestriction !== true
      ) {
        try {
          const decision = evaluateDeadspaceWarp(entity, point, {
            ...options,
            resolveDungeonEntryWarpTarget: (instance) => (
              resolveDungeonEntryWarpTarget(runtime, instance)
            ),
          });
          if (decision && decision.action === "block") {
            logMovementDebug("warp.requested.deadspace-blocked", entity);
            return { success: false, errorMsg: decision.errorMsg || "DunCannotWarpWithinComplex" };
          }
          if (decision && decision.action === "clamp" && decision.point) {
            logMovementDebug("warp.requested.deadspace-clamped", entity);
            warpPoint = decision.point;
            const clampedInstanceID = normalizePersistentEntityID(
              decision.siteInstanceID,
            );
            if (
              destinationStaticInstanceID !== null &&
              (
                clampedInstanceID === null ||
                !entityIDsEqual(destinationStaticInstanceID, clampedInstanceID)
              )
            ) {
              return {
                success: false,
                errorMsg: "DUNGEON_INSTANCE_NOT_AUTHORIZED",
              };
            }
            if (destinationStaticInstanceID !== null) {
              destinationDungeonRoomKey = String(
                decision.destinationDungeonRoomKey || "",
              ).trim() || null;
              destinationDungeonSiteID = normalizePersistentEntityID(
                decision.destinationDungeonSiteID,
              );
            }
            effectiveWarpOptions = {
              ...options,
              stopDistance: 0,
              ...(decision.targetEntityID != null
                ? { targetEntityID: decision.targetEntityID }
                : {}),
            };
          }
        } catch (error) {
          log.warn(`[SpaceRuntime] Deadspace warp check failed: ${error.message}`);
        }
      }

      const requestOptions = {
        ...effectiveWarpOptions,
        destinationDungeonRoomKey,
        destinationDungeonSiteID,
        destinationStaticInstanceID,
        warpSpeedAU: options.warpSpeedAU || entity.warpSpeedAU,
      };
      // The warp as asked, before its jitter: what the 150 km minimum reads.
      const askedRequest = buildWarpRequest(entity, warpPoint, requestOptions);
      const jitteredPoint = warpJitter
        ? {
          x: toFiniteNumber(warpPoint.x, 0) + toFiniteNumber(warpJitter.x, 0),
          y: toFiniteNumber(warpPoint.y, 0) + toFiniteNumber(warpJitter.y, 0),
          z: toFiniteNumber(warpPoint.z, 0) + toFiniteNumber(warpJitter.z, 0),
        }
        : warpPoint;
      let request = jitteredPoint === warpPoint
        ? askedRequest
        : buildWarpRequest(entity, jitteredPoint, requestOptions);
      if (isRedundantWarpOrder(runtime, entity, request)) {
        logMovementDebug("warp.requested.redundant", entity);
        return {
          success: true,
          data: entity.warpDestination || null,
          redundant: true,
        };
      }

      if (options.ignoreCrimewatchCheck !== true) {
        try {
          const crimewatchState = require(path.join(
            __dirname,
            "../../../services/security/crimewatchState",
          ));
          const crimewatchNow =
            session &&
            session._space &&
            Number.isFinite(Number(session._space.simTimeMs))
              ? Number(session._space.simTimeMs)
              : runtime.getCurrentSimTimeMs();
          if (
            crimewatchState &&
            crimewatchState.isCriminallyFlagged(
              session && session.characterID,
              crimewatchNow,
            )
          ) {
            return {
              success: false,
              errorMsg: "CRIMINAL_TIMER_ACTIVE",
            };
          }
        } catch (error) {
          log.warn(`[SpaceRuntime] Crimewatch warp check failed: ${error.message}`);
        }
      }

      // From the point asked for: the same order, the same answer.
      if (askedRequest.totalDistance < serviceMinimumWarpDistanceMeters) {
        return {
          success: false,
          errorMsg: "WARP_DISTANCE_TOO_CLOSE",
        };
      }

      if (
        options.ignoreWarpDisruptionField !== true &&
        typeof findActiveWarpDisruptorForEntity === "function"
      ) {
        const disruptor = findActiveWarpDisruptorForEntity(runtime, entity, {
          session,
          nowMs: runtime.getCurrentSimTimeMs(),
        });
        if (disruptor) {
          return {
            success: false,
            errorMsg: "WARP_DISRUPTED_BY_BUBBLE",
            data: disruptor,
          };
        }
        const disrupted = applyWarpOutcome(runtime, entity, request);
        if (disrupted.success !== true) {
          return disrupted;
        }
        request = disrupted.request;
      }
      request.ignoreWarpDisruptionField = options.ignoreWarpDisruptionField === true;

      if (queueMovementCommand(
        runtime,
        entity,
        "warpToPoint",
        // Applied, the order is checked again from the point asked for and
        // goes by the same jitter, not a new one.
        () => commands.warpToPoint(runtime, session, point, { ...options, warpJitter }),
      )) {
        return {
          success: true,
          data: request,
          queued: true,
        };
      }

      const now = runtime.getCurrentSimTimeMs();
      if (typeof runtime.cancelStargateJumpCloakBeforePilotCommand === "function") {
        runtime.cancelStargateJumpCloakBeforePilotCommand(session, "warp", {
          nowMs: now,
        });
      } else if (typeof runtime.cancelStargateJumpCloak === "function") {
        runtime.cancelStargateJumpCloak(session, "warp", {
          nowMs: now,
        });
      }
      if (session && !request.nativeGoto) {
        const prewarmTargetEntity = request.targetEntityID
          ? runtime.getEntityByID(request.targetEntityID)
          : null;
        const prewarmResult = prewarmStartupControllersForWarpDestination(runtime, {
          excludedSession: session,
          nowMs: now,
          relevantEntities: prewarmTargetEntity ? [prewarmTargetEntity] : [],
          relevantPositions: [request.targetPoint, request.rawDestination],
        });
        if (!prewarmResult.success) {
          log.warn(
            `[SpaceRuntime] Warp destination prewarm failed for system=${runtime.systemID} ship=${entity.itemID}: ${prewarmResult.errorMsg || "UNKNOWN_ERROR"}`,
          );
        }
      }
      return issueWarpOrder(runtime, entity, request, {
        missionGateEffectSourceID:
          options.dungeonGateTransit === true
            ? options.missionGateEffectSourceID
            : null,
      });
    },

    // A ship aligning for warp under a scramble stops. The align gate
    // asks this for every aligning ship at the top of every Destiny tick's
    // doPreTick (scene gateAligningWarps), so a steady scramble stops
    // the align, not only a hostile cycle that changes the target's
    // aggregate. The Stop is queued like any movement change and decided
    // again when it applies, with that tick's queue: the ships still aligning
    // and still scrambled then stop, before that tick's Evolve can take them
    // into warp. Asked between Destiny ticks, it waits for the next one. A ship already in warp is left alone (nothing pulls it out).
    // Returns true when the ship is (or will be) stopped.
    stopWarpScrambledAlign(runtime, entity) {
      if (
        !entity ||
        !isAligningForWarp(entity) ||
        !isWarpBlockedByScramble(runtime, entity)
      ) {
        return false;
      }
      if (queueMovementCommand(
        runtime,
        entity,
        "warpScrambledStop",
        () => commands.stopWarpScrambledAlign(runtime, entity),
      )) {
        return true;
      }
      logMovementDebug("warp.align.blocked.scrambled", entity);
      return runtime.stopShipEntity(entity, { reason: "warpScrambled" }) === true;
    },

    // A ship aligning for warp inside an active sphere stops, as a
    // scrambled one does (above): a sphere raised over a ship after its
    // order (an interdictor's probe, a heavy interdictor's field) must keep
    // it out of warp, as the order-time refusal keeps out a ship already
    // inside one. Retail's NPC warp refuses a ship inside a sphere
    // (Client/behaviors/entity.py L60-61); whether retail's server stops a
    // player's align is unpublished. The
    // align gate asks this for every aligning ship at the top of every
    // Destiny tick's doPreTick; the Stop is queued and decided
    // again when it applies with that tick's queue, so every Observer gets
    // one ordinary Stop and no Evolve takes the ship into warp.
    // The sphere set, immunity and interaction scope are the order-time
    // check's; a warp that ignores spheres (a fighter's recall) is left
    // alone. Returns true when the ship is (or will be) stopped.
    stopWarpDisruptedAlign(runtime, entity) {
      if (
        !entity ||
        !isAligningForWarp(entity) ||
        (entity.warpDestination &&
          entity.warpDestination.ignoreWarpDisruptionField === true) ||
        typeof findActiveWarpDisruptorForEntity !== "function" ||
        !findActiveWarpDisruptorForEntity(runtime, entity, {
          nowMs: runtime.getCurrentSimTimeMs(),
        })
      ) {
        return false;
      }
      if (queueMovementCommand(
        runtime,
        entity,
        "warpDisruptedStop",
        () => commands.stopWarpDisruptedAlign(runtime, entity),
      )) {
        return true;
      }
      logMovementDebug("warp.align.blocked.sphere", entity);
      return runtime.stopShipEntity(entity, { reason: "warpDisrupted" }) === true;
    },

    warpDynamicEntityToPoint(runtime, entityOrID, point, options = {}) {
      const entity =
        typeof entityOrID === "object" && entityOrID !== null
          ? entityOrID
          : runtime.getEntityByID(entityOrID);
      if (
        !entity ||
        (entity.kind !== "ship" && entity.kind !== "fighter") ||
        entity.pendingDock
      ) {
        return {
          success: false,
          errorMsg: "SHIP_NOT_FOUND",
        };
      }

      const destinationResolution = resolveCommandDestinationStaticInstanceID(
        runtime,
        options.session || entity.session || null,
        options,
      );
      if (destinationResolution.success !== true) {
        return destinationResolution;
      }
      let request = buildWarpRequest(entity, point, {
        ...options,
        destinationDungeonRoomKey: destinationResolution.roomKey,
        destinationDungeonSiteID: destinationResolution.siteID,
        destinationStaticInstanceID: destinationResolution.instanceID,
        warpSpeedAU: options.warpSpeedAU || entity.warpSpeedAU,
      });
      if (isRedundantWarpOrder(runtime, entity, request)) {
        logMovementDebug("warp.requested.sessionless.redundant", entity);
        return {
          success: true,
          data: entity.warpDestination || null,
          redundant: true,
        };
      }
      if (request.totalDistance < serviceMinimumWarpDistanceMeters) {
        return {
          success: false,
          errorMsg: "WARP_DISTANCE_TOO_CLOSE",
        };
      }

      if (options.ignoreWarpDisruptionField !== true) {
        const disrupted = applyWarpSpheres(runtime, entity, request);
        if (disrupted.success !== true) {
          return disrupted;
        }
        request = disrupted.request;
      }
      request.ignoreWarpDisruptionField = options.ignoreWarpDisruptionField === true;

      if (queueMovementCommand(
        runtime,
        entity,
        "warpDynamicEntityToPoint",
        () => commands.warpDynamicEntityToPoint(runtime, entity, point, options),
      )) {
        return {
          success: true,
          data: request,
          queued: true,
        };
      }

      const gateEffect = {
        missionGateEffectSourceID:
          options.dungeonGateTransit === true
            ? options.missionGateEffectSourceID
            : null,
      };
      // A start with no align (an acceleration gate's fallback) is retail's
      // EntityWarpIn.
      if (options.forceImmediateStart === true && !request.nativeGoto) {
        return issueEntityWarpIn(runtime, entity, request, gateEffect);
      }
      return issueWarpOrder(runtime, entity, request, gateEffect);
    },

    // Ends a warp's align at once (an acceleration gate, the deadwarp
    // command): retail's EntityWarpIn to where the warp was going.
    forceStartPendingWarp(runtime, entityOrID, options = {}) {
      const entity =
        typeof entityOrID === "object" && entityOrID !== null
          ? entityOrID
          : runtime.getEntityByID(entityOrID);
      if (
        !entity ||
        (entity.kind !== "ship" && entity.kind !== "fighter")
      ) {
        return {
          success: false,
          errorMsg: "SHIP_NOT_FOUND",
        };
      }
      // A warp queued for the Ball (a warp command just before this one) is
      // aligning by the time this applies.
      if (!isAligningForWarp(entity) && !hasQueuedMovement(runtime, entity)) {
        return {
          success: false,
          errorMsg: "WARP_NOT_PENDING",
        };
      }
      if (queueMovementCommand(
        runtime,
        entity,
        "forceStartPendingWarp",
        () => commands.forceStartPendingWarp(runtime, entity, options),
      )) {
        return {
          success: true,
          data: { entity },
          queued: true,
        };
      }
      if (!isAligningForWarp(entity)) {
        return {
          success: false,
          errorMsg: "WARP_NOT_PENDING",
        };
      }
      const destination = entity.warpDestination || {};
      const request = buildWarpRequest(
        entity,
        destination.rawDestination || entity.targetPoint,
        {
          stopDistance: entity.warpMinRange,
          warpSpeedAU: toFiniteNumber(entity.warpFactor, 3000) / 1000,
          targetEntityID: destination.targetEntityID,
          destinationStaticInstanceID: destination.destinationStaticInstanceID,
          destinationDungeonRoomKey: destination.destinationDungeonRoomKey,
          destinationDungeonSiteID: destination.destinationDungeonSiteID,
        },
      );
      return issueEntityWarpIn(runtime, entity, request);
    },

    // An NPC's warp: retail's EntityWarpIn, queued. The spheres refuse or
    // pull it as retail's NPCWarpTo does, when it is asked for and
    // again when it applies; a refusal changes nothing on the NPC. A refusal
    // when the queued order applies has no caller left to return to, so it
    // goes to `options.onRefusedWhenApplied(result)`.
    startSessionlessWarpIngress(runtime, entityOrID, point, options = {}) {
      const entity =
        typeof entityOrID === "object" && entityOrID !== null
          ? entityOrID
          : runtime.getEntityByID(entityOrID);
      if (!entity || entity.kind !== "ship") {
        return {
          success: false,
          errorMsg: "SHIP_NOT_FOUND",
        };
      }
      let request = buildWarpRequest(entity, point, {
        ...options,
        stopDistance: options.stopDistance,
        warpSpeedAU: options.warpSpeedAU || entity.warpSpeedAU,
      });
      if (options.ignoreWarpDisruptionField !== true) {
        const disrupted = applyWarpSpheres(runtime, entity, request);
        if (disrupted.success !== true) {
          logMovementDebug("warp.npc.refused-by-sphere", entity, {
            errorMsg: disrupted.errorMsg,
          });
          return disrupted;
        }
        request = disrupted.request;
      }
      if (queueMovementCommand(
        runtime,
        entity,
        "startSessionlessWarpIngress",
        () => {
          const applied = commands.startSessionlessWarpIngress(runtime, entity, point, options);
          if (
            applied &&
            applied.success === false &&
            typeof options.onRefusedWhenApplied === "function"
          ) {
            options.onRefusedWhenApplied(applied);
          }
          return applied;
        },
      )) {
        // The warp starts at the next Destiny tick; callers schedule the
        // NPC's wake from when it lands.
        const estimate = setupWarpConstants(request.warpFactor, request.totalDistance);
        return {
          success: true,
          queued: true,
          data: {
            entity,
            ingressCompleteAtMs:
              runtime.getCurrentSimTimeMs() + 1000 +
              ((estimate.accelTime + estimate.cruiseTime + estimate.decelTime) * 1000),
            acquireResult: null,
          },
        };
      }
      if (request.nativeGoto) {
        return routeNativeGotoFallback(
          runtime,
          entity,
          request,
          runtime.getCurrentSimTimeMs(),
          options,
        );
      }
      const result = issueEntityWarpIn(runtime, entity, request);
      if (!result.success) {
        return result;
      }
      return {
        success: true,
        data: {
          entity,
          ingressCompleteAtMs: result.data.ingressCompleteAtMs,
          acquireResult: options.acquireForRelevantSessions === true
            ? {
                deferredToFinalSceneTick: true,
                deliveredEntityCount: 0,
                deliveredSessionCount: 0,
              }
            : null,
        },
      };
    },
  };
  return commands;
}

module.exports = {
  createMovementWarpCommands,
};
