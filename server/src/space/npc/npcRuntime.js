"use strict";

const {
  cloneVector,
} = require("../../common/vector");

const {
  toFiniteNumber,
} = require("../../common/numbers");

const path = require("path");

const spaceRuntime = require(path.join(__dirname, "../runtime"));
const npcService = require(path.join(__dirname, "./npcService"));
const {
  createWarpJitter,
  npcWarpStreamSeed,
} = require(path.join(__dirname, "../destiny/simulation/warpJitter"));
const {
  ONE_AU_IN_METERS,
  findSafeWarpOriginAnchor,
} = require(path.join(__dirname, "./npcWarpOrigins"));
const {
  applyNpcWarpCompletionWakeDeadlineCommand,
} = require(path.join(__dirname, "../destiny/commands/npcWarpCompletion.js"));

const NPC_WARP_VISIBILITY_SUPPRESS_MS = 250;
// Controllers should not wake on the same Gameplay tick that completes the
// sessionless ingress. If they do, FOLLOW/ORBIT can be issued just before the
// authoritative warp-complete STOP/SetBallPosition handoff, which is exactly
// the "moves for a moment then snaps dead" behavior seen in the client logs.
// `client/crime7.txt` and `client/crime9.txt` then showed the visible-origin
// CONCORD warp still needed one more full scene beat after landing before the
// controller starts issuing pursuit orders; otherwise the ships peel away
// before the client has finished reading the arrival.
const NPC_WARP_WAKE_GRACE_TICKS = 2;
const NPC_COMMAND_WARP_INGRESS_DURATION_MS = 2_500;
const NPC_COMMAND_WARP_LANDING_RADIUS_METERS = 3_000;
// The warp refusals an interdiction sphere gives.
const SPHERE_WARP_REFUSALS = new Set([
  "WARP_DISRUPTED_BY_BUBBLE",
  "WARP_DISRUPTED_PATH_TOO_SHORT",
]);

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function buildWarpLandingPoint(center, index = 0, total = 1, radiusMeters = NPC_COMMAND_WARP_LANDING_RADIUS_METERS) {
  const resolvedCenter = cloneVector(center);
  const divisor = Math.max(1, toPositiveInt(total, 1));
  const angle = ((Math.PI * 2) / divisor) * Math.max(0, index);
  const resolvedRadiusMeters = Math.max(0, toFiniteNumber(radiusMeters, NPC_COMMAND_WARP_LANDING_RADIUS_METERS));
  return {
    x: resolvedCenter.x + (Math.cos(angle) * resolvedRadiusMeters),
    y: resolvedCenter.y,
    z: resolvedCenter.z + (Math.sin(angle) * resolvedRadiusMeters),
  };
}

function cleanupSpawnedEntries(spawned) {
  const entries = Array.isArray(spawned) ? spawned : [];
  for (const entry of entries) {
    const entityID = toPositiveInt(entry && entry.entity && entry.entity.itemID, 0);
    if (!entityID) {
      continue;
    }
    npcService.destroyNpcControllerByEntityID(entityID, {
      removeContents: true,
    });
  }
}

function estimateNpcWarpWakeAtMs(scene, options = {}) {
  const now = scene ? scene.getCurrentSimTimeMs() : 0;
  const tickIntervalMs = Math.max(
    1,
    toFiniteNumber(scene && scene._tickIntervalMs, 1000),
  );
  return Math.max(
    now,
    toFiniteNumber(options.ingressCompleteAtMs, now),
  ) + (tickIntervalMs * NPC_WARP_WAKE_GRACE_TICKS);
}

function startManagedNpcWarp(context, point, options = {}) {
  if (!context || !context.scene || !context.entity) {
    return {
      success: false,
      errorMsg: "SHIP_NOT_FOUND",
    };
  }

  const scene = context.scene;
  const visibilitySuppressMs = Math.max(
    1,
    toFiniteNumber(
      options.visibilitySuppressMs,
      NPC_WARP_VISIBILITY_SUPPRESS_MS,
    ),
  );
  // Only the behaviour warp asks for jitter (retail's NPCWarpTo). Scripted warps
  // such as CONCORD, mining and mission fleets land where they were sent.
  const jitterRadiusMeters = toFiniteNumber(options.jitterRadiusMeters, 0);
  const offset = jitterRadiusMeters > 0
    ? createWarpJitter(
      npcWarpStreamSeed(context.entityID, scene.getCurrentSimTimeMs()),
      { radiusMeters: jitterRadiusMeters },
    ).next()
    : { x: 0, y: 0, z: 0 };
  const destination = cloneVector(point);
  const warpResult = scene.startSessionlessWarpIngress(
    context.entityID,
    { x: destination.x + offset.x, y: destination.y + offset.y, z: destination.z + offset.z },
    {
      ...options,
      // Let the shared visibility sync acquire the ship on the next Gameplay tick
      // instead of forcing a same-tick AddBalls2 burst. That preserves an
      // actual visible arrival window and avoids the "spawned in place"
      // feeling from same-tick acquire + immediate warp-complete correction.
      acquireForRelevantSessions: options.acquireForRelevantSessions === true,
      visibilitySuppressMs,
      ingressDurationMs: Math.max(
        visibilitySuppressMs,
        toFiniteNumber(options.ingressDurationMs, visibilitySuppressMs),
      ),
    },
  );
  if (!warpResult.success || !warpResult.data) {
    return warpResult;
  }
  const wakeAtMs = estimateNpcWarpWakeAtMs(scene, {
    ingressCompleteAtMs: toFiniteNumber(
      warpResult.data.ingressCompleteAtMs,
      scene.getCurrentSimTimeMs(),
    ),
  });
  if (warpResult.data.entity) {
    applyNpcWarpCompletionWakeDeadlineCommand(warpResult.data.entity, wakeAtMs);
  }

  return {
    success: true,
    data: {
      ...context,
      ...warpResult.data,
      ingressCompleteAtMs: wakeAtMs,
    },
  };
}

function resolveNpcContext(entityID) {
  const normalizedEntityID = toPositiveInt(entityID, 0);
  if (!normalizedEntityID) {
    return {
      success: false,
      errorMsg: "NPC_NOT_FOUND",
    };
  }

  const controller = npcService.getControllerByEntityID(normalizedEntityID);
  if (!controller) {
    return {
      success: false,
      errorMsg: "NPC_NOT_FOUND",
    };
  }

  const systemID = toPositiveInt(controller.systemID, 0);
  if (!systemID) {
    return {
      success: false,
      errorMsg: "SOLAR_SYSTEM_NOT_FOUND",
    };
  }

  const controllerSceneKey = String(controller.sceneKey || "").trim();
  const hasExactSceneAuthority = controllerSceneKey !== "";
  const scene = hasExactSceneAuthority
    ? (
        typeof spaceRuntime.getSceneByDescriptor === "function"
          ? spaceRuntime.getSceneByDescriptor({
              sceneKey: controllerSceneKey,
              sceneKind: controller.sceneKind,
              instanceID: controller.instanceID,
              locationID: controller.locationID || systemID,
              systemID,
            })
          : null
      )
    : (
        spaceRuntime.findSceneContainingDynamicEntity(normalizedEntityID) ||
        spaceRuntime.ensureScene(systemID)
      );
  const entity = scene ? scene.getEntityByID(normalizedEntityID) : null;
  if (!scene || !entity) {
    return {
      success: false,
      errorMsg: "SHIP_NOT_FOUND",
    };
  }

  return {
    success: true,
    data: {
      entityID: normalizedEntityID,
      controller,
      systemID,
      scene,
      entity,
    },
  };
}

function wakeNpcController(entityID, whenMs = 0) {
  return npcService.wakeNpcController(entityID, whenMs);
}

function scheduleNpcController(entityID, whenMs = 0) {
  return npcService.scheduleNpcController(entityID, whenMs);
}

function getControllerByEntityID(entityID) {
  return npcService.getControllerByEntityID(entityID);
}

function activateNpcController(entityID, whenMs = 0) {
  return npcService.activateNpcController(entityID, whenMs);
}

function pauseNpcController(entityID, reason = "paused") {
  return npcService.pauseNpcController(entityID, reason);
}

function deactivateNpcControllerCombat(entityID, options = {}) {
  const contextResult = resolveNpcContext(entityID);
  if (!contextResult.success) {
    return contextResult;
  }
  const {
    scene,
    entity,
    controller,
  } = contextResult.data;
  const {
    deactivateNpcControllerCombat: deactivateControllerCombat,
  } = require(path.join(__dirname, "./npcBehaviorLoop"));
  return deactivateControllerCombat(scene, entity, controller, options);
}

function tickNpcControllersInScene(scene, entityIDs, nowMs) {
  if (!scene || typeof npcService.tickControllersByEntityID !== "function") {
    return {
      success: false,
      errorMsg: "NPC_TICK_UNAVAILABLE",
    };
  }
  npcService.tickControllersByEntityID(scene, entityIDs, nowMs);
  return {
    success: true,
  };
}

function spawnBatchForSession(session, options = {}) {
  return npcService.spawnNpcBatchForSession(session, options);
}

function spawnBatchInSystem(systemID, options = {}) {
  return npcService.spawnNpcBatchInSystem(systemID, options);
}

function spawnWarpBatchForSession(session, options = {}) {
  if (!session || !session._space) {
    return {
      success: false,
      errorMsg: "NOT_IN_SPACE",
    };
  }

  const systemID = toPositiveInt(session._space.systemID || session.solarsystemid2 || session.solarsystemid, 0);
  const shipID = toPositiveInt(session._space.shipID, 0);
  if (!systemID || !shipID) {
    return {
      success: false,
      errorMsg: "SHIP_NOT_FOUND",
    };
  }

  const scene = typeof spaceRuntime.getSceneForSession === "function"
    ? spaceRuntime.getSceneForSession(session)
    : null;
  const targetEntity = scene ? scene.getEntityByID(shipID) : null;
  if (!scene || !targetEntity) {
    return {
      success: false,
      errorMsg: "SHIP_NOT_FOUND",
    };
  }

  const originAnchor = findSafeWarpOriginAnchor(scene, targetEntity, {
    clearanceMeters: Math.max(
      ONE_AU_IN_METERS,
      toFiniteNumber(options.originClearanceMeters, ONE_AU_IN_METERS),
    ),
    minDistanceMeters: toFiniteNumber(options.originMinDistanceMeters, ONE_AU_IN_METERS * 2),
    maxDistanceMeters: toFiniteNumber(options.originMaxDistanceMeters, ONE_AU_IN_METERS * 4),
    stepMeters: toFiniteNumber(options.originStepMeters, ONE_AU_IN_METERS / 2),
  });

  const spawnResult = npcService.spawnNpcBatchInSystem(systemID, {
    ...options,
    sceneDescriptor: scene.sceneDescriptor || options.sceneDescriptor,
    preferredTargetID: shipID,
    transient: options.transient !== false,
    broadcast: false,
    skipInitialBehaviorTick: true,
    anchorDescriptor: {
      kind: "coordinates",
      position: originAnchor.position,
      direction: originAnchor.direction,
      name: options.anchorName || "Transient NPC Warp Origin",
    },
  });
  if (!spawnResult.success || !spawnResult.data) {
    return spawnResult;
  }

  const spawned = Array.isArray(spawnResult.data.spawned)
    ? spawnResult.data.spawned.filter((entry) => entry && entry.entity)
    : [];
  if (spawned.length === 0) {
    return {
      success: false,
      errorMsg: "NPC_NATIVE_SPAWN_FAILED",
      suggestions: spawnResult.suggestions || [],
    };
  }

  for (const entry of spawned) {
    const attackResult = issueAttackOrder(
      toPositiveInt(entry.entity && entry.entity.itemID, 0),
      shipID,
      {
        keepLock: true,
      },
    );
    if (!attackResult.success) {
      cleanupSpawnedEntries(spawned);
      return attackResult;
    }
  }

  const landingRadiusMeters = Math.max(
    0,
    toFiniteNumber(
      options.landingRadiusMeters,
      NPC_COMMAND_WARP_LANDING_RADIUS_METERS,
    ),
  );
  const warpRequests = spawned.map((entry, index) => ({
    entityID: toPositiveInt(entry.entity && entry.entity.itemID, 0),
    point: buildWarpLandingPoint(
      targetEntity.position,
      index,
      spawned.length,
      landingRadiusMeters,
    ),
    options: {
      forceImmediateStart: true,
      broadcastWarpStartToVisibleSessions: true,
      targetEntityID: shipID,
      useNativeWarpProfile: true,
      // TQ lets the mode-3 ball finish locally from the shared profile; it
      // does not fight that solver with a bare early Stop packet.
      suppressCompletionStopUpdates: true,
      ingressDurationMs: Math.max(
        NPC_WARP_VISIBILITY_SUPPRESS_MS,
        toFiniteNumber(
          options.ingressDurationMs,
          NPC_COMMAND_WARP_INGRESS_DURATION_MS,
        ),
      ),
      visibilitySuppressMs: Math.max(
        1,
        toFiniteNumber(
          options.visibilitySuppressMs,
          NPC_WARP_VISIBILITY_SUPPRESS_MS,
        ),
      ),
      warpSpeedAU: toFiniteNumber(options.warpSpeedAU, 0) > 0
        ? toFiniteNumber(options.warpSpeedAU, 0)
        : undefined,
    },
  }));
  const warpResult = warpBatchToPoints(warpRequests, {
    groupWake: true,
  });
  if (!warpResult.success || !warpResult.data) {
    cleanupSpawnedEntries(spawned);
    return warpResult;
  }

  // Only the members that warp in: one a sphere refused was removed.
  const warpedIDs = new Set(
    warpResult.data.results.map((entry) => toPositiveInt(entry && entry.entityID, 0)),
  );
  return {
    success: true,
    data: {
      ...spawnResult.data,
      spawned: spawned.filter((entry) => warpedIDs.has(
        toPositiveInt(entry && entry.entity && entry.entity.itemID, 0),
      )),
      originAnchor,
      warpBatch: warpResult.data,
      targetEntityID: shipID,
    },
    suggestions: spawnResult.suggestions || [],
  };
}

function spawnNpcForSession(session, options = {}) {
  return npcService.spawnNpcForSession(session, options);
}

function spawnConcordBatchForSession(session, options = {}) {
  return npcService.spawnConcordBatchForSession(session, options);
}

function spawnConcordForSession(session, options = {}) {
  return npcService.spawnConcordForSession(session, options);
}

function spawnGroupInSystem(systemID, options = {}) {
  return npcService.spawnNpcGroupInSystem(systemID, options);
}

function spawnSite(siteQuery, options = {}) {
  return npcService.spawnNpcSite(siteQuery, options);
}

function issueOrder(entityID, order) {
  return npcService.issueManualOrder(entityID, order);
}

function issueAttackOrder(entityID, targetID, options = {}) {
  return issueOrder(entityID, {
    type: "attack",
    targetID: toPositiveInt(targetID, 0),
    allowWeapons: options.allowWeapons !== false,
    keepLock: options.keepLock !== false,
    allowPodKill: options.allowPodKill === true,
  });
}

function holdFire(entityID) {
  return issueOrder(entityID, {
    type: "holdFire",
  });
}

function resumeBehavior(entityID) {
  return issueOrder(entityID, {
    type: "resumeBehavior",
  });
}

function stop(entityID, options = {}) {
  const contextResult = resolveNpcContext(entityID);
  if (!contextResult.success || !contextResult.data) {
    return contextResult;
  }

  const ok = contextResult.data.scene.stopShipEntity(
    contextResult.data.entityID,
    {
      ...options,
      allowSessionlessWarpAbort: options.allowSessionlessWarpAbort !== false,
      reason: options.reason || "npcStop",
    },
  );
  if (!ok) {
    return {
      success: false,
      errorMsg: "NPC_STOP_FAILED",
    };
  }

  if (options.issueStopOrder !== false) {
    const orderResult = npcService.issueManualOrder(entityID, {
      type: "stop",
    });
    if (!orderResult.success) {
      return orderResult;
    }
  } else if (options.wakeController !== false) {
    npcService.wakeNpcController(entityID, 0);
  }

  return {
    success: true,
    data: contextResult.data,
  };
}

function follow(entityID, targetEntityID, range = 0, options = {}) {
  const contextResult = resolveNpcContext(entityID);
  if (!contextResult.success || !contextResult.data) {
    return contextResult;
  }

  const ok = contextResult.data.scene.followShipEntity(
    contextResult.data.entityID,
    toPositiveInt(targetEntityID, 0),
    toFiniteNumber(range, 0),
    options,
  );
  if (!ok) {
    return {
      success: false,
      errorMsg: "NPC_FOLLOW_FAILED",
    };
  }

  if (options.wakeController !== false) {
    npcService.wakeNpcController(entityID, 0);
  }

  return {
    success: true,
    data: contextResult.data,
  };
}

function orbit(entityID, targetEntityID, distance, options = {}) {
  const contextResult = resolveNpcContext(entityID);
  if (!contextResult.success || !contextResult.data) {
    return contextResult;
  }

  const ok = contextResult.data.scene.orbitShipEntity(
    contextResult.data.entityID,
    toPositiveInt(targetEntityID, 0),
    toFiniteNumber(distance, 0),
    options,
  );
  if (!ok) {
    return {
      success: false,
      errorMsg: "NPC_ORBIT_FAILED",
    };
  }

  if (options.wakeController !== false) {
    npcService.wakeNpcController(entityID, 0);
  }

  return {
    success: true,
    data: contextResult.data,
  };
}

function warpToPoint(entityID, point, options = {}) {
  const contextResult = resolveNpcContext(entityID);
  if (!contextResult.success || !contextResult.data) {
    return contextResult;
  }

  const warpResult = startManagedNpcWarp(
    contextResult.data,
    point,
    {
      ...options,
      // Refused when its queued order applies: the NPC stays where it
      // is and thinks again at once, not at the landing it expected.
      onRefusedWhenApplied(result) {
        if (options.scheduleWake !== false) {
          npcService.scheduleNpcController(
            entityID,
            contextResult.data.scene.getCurrentSimTimeMs(),
          );
        }
        if (typeof options.onRefusedWhenApplied === "function") {
          options.onRefusedWhenApplied(result);
        }
      },
    },
  );
  if (!warpResult.success || !warpResult.data) {
    return warpResult;
  }

  if (options.scheduleWake !== false) {
    npcService.scheduleNpcController(
      entityID,
      toFiniteNumber(
        warpResult.data.ingressCompleteAtMs,
        contextResult.data.scene.getCurrentSimTimeMs(),
      ),
    );
  }

  return {
    success: true,
    data: {
      ...contextResult.data,
      ...warpResult.data,
    },
  };
}

function warpToEntity(entityID, targetEntityID, options = {}) {
  const contextResult = resolveNpcContext(entityID);
  if (!contextResult.success || !contextResult.data) {
    return contextResult;
  }

  const targetEntity = contextResult.data.scene.getEntityByID(
    toPositiveInt(targetEntityID, 0),
  );
  if (!targetEntity) {
    return {
      success: false,
      errorMsg: "TARGET_NOT_FOUND",
    };
  }

  return warpToPoint(entityID, targetEntity.position, {
    ...options,
    targetEntityID: toPositiveInt(targetEntityID, 0),
  });
}

function warpBatchToPoints(requests, options = {}) {
  const normalizedRequests = Array.isArray(requests)
    ? requests.filter((request) => (
      request &&
      toPositiveInt(request.entityID, 0) > 0 &&
      request.point &&
      typeof request.point === "object"
    ))
    : [];
  if (normalizedRequests.length === 0) {
    return {
      success: false,
      errorMsg: "NPC_WARP_BATCH_EMPTY",
    };
  }

  const results = [];
  const refused = [];
  let commonWakeAtMs = 0;

  for (const request of normalizedRequests) {
    const contextResult = resolveNpcContext(request.entityID);
    if (!contextResult.success || !contextResult.data) {
      return contextResult;
    }

    const memberEntityID = contextResult.data.entityID;
    const requestOptions = {
      ...options,
      ...(request.options || {}),
      scheduleWake: false,
      // A member refused when its queued order applies is removed,
      // as one refused when its order is asked for: it never warped in.
      onRefusedWhenApplied(result) {
        if (result && SPHERE_WARP_REFUSALS.has(result.errorMsg)) {
          npcService.destroyNpcControllerByEntityID(memberEntityID, {
            removeContents: true,
          });
        }
      },
    };
    const warpResult = startManagedNpcWarp(
      contextResult.data,
      request.point,
      requestOptions,
    );
    // A member a sphere refuses never warps in: it is removed, and
    // the rest of the batch still warps.
    if (warpResult && SPHERE_WARP_REFUSALS.has(warpResult.errorMsg)) {
      npcService.destroyNpcControllerByEntityID(contextResult.data.entityID, {
        removeContents: true,
      });
      refused.push({
        entityID: contextResult.data.entityID,
        errorMsg: warpResult.errorMsg,
      });
      continue;
    }
    if (!warpResult.success || !warpResult.data) {
      return warpResult;
    }

    const resultEntry = {
      ...contextResult.data,
      ...warpResult.data,
    };
    results.push(resultEntry);
    commonWakeAtMs = Math.max(
      commonWakeAtMs,
      toFiniteNumber(
        warpResult.data.ingressCompleteAtMs,
        contextResult.data.scene.getCurrentSimTimeMs(),
      ),
    );
  }

  if (results.length === 0) {
    return {
      success: false,
      errorMsg: refused[0].errorMsg,
      data: { refused },
    };
  }

  if (options.scheduleWake !== false) {
    const groupedWake = options.groupWake !== false;
    for (const resultEntry of results) {
      npcService.scheduleNpcController(
        resultEntry.entityID,
        groupedWake
          ? commonWakeAtMs
          : toFiniteNumber(
            resultEntry.ingressCompleteAtMs,
            commonWakeAtMs,
          ),
      );
    }
  }

  return {
    success: true,
    data: {
      results,
      refused,
      commonWakeAtMs,
    },
  };
}

function despawn(entityID, options = {}) {
  return npcService.destroyNpcControllerByEntityID(entityID, options);
}

module.exports = {
  resolveNpcContext,
  wakeNpcController,
  scheduleNpcController,
  getControllerByEntityID,
  activateNpcController,
  pauseNpcController,
  deactivateNpcControllerCombat,
  tickNpcControllersInScene,
  spawnBatchForSession,
  spawnBatchInSystem,
  spawnWarpBatchForSession,
  spawnNpcForSession,
  spawnConcordBatchForSession,
  spawnConcordForSession,
  spawnGroupInSystem,
  spawnSite,
  issueOrder,
  issueAttackOrder,
  holdFire,
  resumeBehavior,
  stop,
  follow,
  orbit,
  warpToPoint,
  warpToEntity,
  warpBatchToPoints,
  despawn,
  __testing: { startManagedNpcWarp },
};
