"use strict";

// Scene feature hooks: upstream's per-scene features told about each lifecycle
// point of a scene, in upstream's order (Upstream release 261018.1, 44922d2,
// made each call inline at its point).
//
// Each function is a literal list of feature calls, with no registration.
// Every call runs in its own try: a throw is logged with the feature, the
// point and the solar system, and the next call runs, so one failing feature
// never stops another, the tick or a removal. No function throws or returns
// a value.
//
// Calls that decide rather than notify stay inline where main has them:
// tow's spawn refusal, the missile-only
// registrations in launchMissile, the destruction claims, the Gameplay-tick
// feature sections and the scene-load reconciles.
//
// A feature moves a Ball only through a queued Destiny command, sends no
// Destiny update itself, and sends gameplay events through the Character
// batch.
//
// tickSceneFeatures runs the per-scene feature ticks after each scene's
// Gameplay tick.
//
// Each feature runtime is required at its call: several require the runtime
// back, and a feature that fails to load fails alone.

const runtimeEntryDirname = require("path").resolve(__dirname, "../..");
const path = require("path");
const log = require(path.join(runtimeEntryDirname, "../utils/logger"));

function runFeature(scene, point, feature, call) {
  try {
    call();
  } catch (error) {
    try {
      log.error(
        `[SceneFeatureHooks] ${feature} failed at ${point} in system=${scene && scene.systemID}: ` +
        `${error && error.stack ? error.stack : error}`,
      );
    } catch (_) {
      // A logger failure stops nothing either.
    }
  }
}

// A Ball joins the scene: spawnDynamicEntity (via "spawn", with the tow
// objective context its spawn validated and the spawn options) or a pilot's
// attach (via "attach", with the session). Runs after the Ball is in the
// scene's maps and before it is persisted.
function notifyEntityAdded(scene, entity, context = {}) {
  const point = "entityAdded";
  const via = context && context.via === "attach" ? "attach" : "spawn";
  runFeature(scene, point, "tow", () => {
    const tow = require("../../../services/spaceComponents/towGameObjectiveRuntime");
    if (via === "spawn") {
      tow.registerSceneEntity(scene, entity, context.towObjective || undefined, context.spawnOptions || {});
    } else {
      tow.registerSceneEntity(scene, entity);
    }
  });
  runFeature(scene, point, "breacherPods", () => {
    require("../../combat/breacherPods").registerSceneEntity(scene, entity);
  });
  if (via === "attach") {
    runFeature(scene, point, "customsInspection", () => {
      const session = context.session || (entity && entity.session) || null;
      if (session) {
        require("../../../services/security/customsInspectionRuntime").handleSessionAttached(session);
      }
    });
    runFeature(scene, point, "selfDestruct", () => {
      const session = context.session || (entity && entity.session) || null;
      if (session) {
        require("../../../services/ship/selfDestructRuntime").handleSessionAttached(session);
      }
    });
  }
}

// A Ball leaves the scene. path "unregister": unregisterDynamicEntity, only
// once deferRemovalWhileEvolving has returned false (the real removal, from
// bringOutTheDeads inside a tick, never the moribund mark), with the
// removal's options; "purge": purgeDestroyedShipEntityTopology, upstream's
// purge subset; "static": removeStaticEntity. Runs before persistence and
// before the Ball leaves the scene's maps.
function notifyEntityRemoved(scene, entity, options = {}, { path: removalPath = "unregister" } = {}) {
  const point = "entityRemoved";
  const unregister = removalPath === "unregister";
  const purge = removalPath === "purge";
  const removalOptions = options || {};
  if (unregister || purge) {
    runFeature(scene, point, "mobileMicroJumpUnit", () => {
      require("../../../services/ship/mobileMicroJumpUnitRuntime").clearSpoolsForEntity(scene, entity);
    });
    runFeature(scene, point, "fireShow", () => {
      require("../../FireShow/fireShowRuntime").handleEntityRemoved(scene, entity);
    });
  }
  runFeature(scene, point, "transientStargates", () => {
    require("../../transientStargates").handleEntityRemoved(scene, entity);
  });
  if (unregister) {
    runFeature(scene, point, "defenderMissiles", () => {
      require("../../modules/defenderMissileRuntime").handleEntityRemoved(scene, entity);
    });
    runFeature(scene, point, "bombs", () => {
      require("../../modules/bombRuntime").handleEntityRemoved(scene, entity);
    });
    runFeature(scene, point, "breacherPods", () => {
      require("../../combat/breacherPods").handleEntityRemoved(scene, entity, removalOptions);
    });
  }
  if (unregister || purge) {
    runFeature(scene, point, "tow", () => {
      require("../../../services/spaceComponents/towGameObjectiveRuntime").handleEntityRemoved(scene, entity);
    });
    runFeature(scene, point, "pvpFilament", () => {
      require("../../../services/activity/pvpFilamentQueueRuntime").handleEntityRemoved(scene, entity);
    });
  }
}

// A session leaves the scene: detachSession (reason "detach", with the
// detach options) or disembarkSession (reason "disembark", a ship change that
// may keep the pilot in this scene). Runs while the session is still an
// Observer, before dropDestinyObserver on detach and before the session is
// deleted on disembark, so Dogma events a feature queues (the rack heat clear
// among them) leave in its Character batch or its final flush. `entity` is
// the ship it flies, or null. The reason picks upstream's list for that
// point: a disembark tells only safe logoff, self-destruct, link-with-ship,
// rack heat, tow and customs, and leaves the pilot's PvP filament queue,
// Mobile Micro Jump Unit spools, firework show and transient stargate alone.
function notifySessionLeaving(scene, session, entity, { reason = "detach", options = {} } = {}) {
  if (reason === "disembark") {
    notifyDisembarking(scene, session, entity);
    return;
  }
  const point = "sessionLeaving";
  const leaveOptions = options || {};
  runFeature(scene, point, "safeLogoff", () => {
    if (session && session._safeLogoff) {
      require("../../../services/ship/safeLogoffRuntime").abort(session);
    }
  });
  runFeature(scene, point, "selfDestruct", () => {
    if (leaveOptions.preserveCustomsCase !== true) {
      require("../../../services/ship/selfDestructRuntime").handleSceneDeparture(session, options);
    }
  });
  runFeature(scene, point, "linkWithShip", () => {
    require("../../../services/spaceComponents/linkWithShipRuntime").breakLinksForSession(
      scene,
      session,
      leaveOptions.reason || "scene-departure",
    );
  });
  runFeature(scene, point, "customsInspection", () => {
    const customs = require("../../../services/security/customsInspectionRuntime");
    if (leaveOptions.preserveCustomsCase === true) {
      // A generation rebind keeps the same pilot, ship and scene authority.
    } else if (String(leaveOptions.lifecycleReason || "").includes("disconnect")) {
      customs.handleSessionDisconnected(session);
    } else {
      customs.handleSceneDeparture(session, leaveOptions);
    }
  });
  runFeature(scene, point, "tow", () => {
    require("../../../services/spaceComponents/towGameObjectiveRuntime").handleSessionDisconnected(session);
  });
  runFeature(scene, point, "pvpFilament", () => {
    require("../../../services/activity/pvpFilamentQueueRuntime").handleSessionDisconnected(session);
  });
  runFeature(scene, point, "rackHeat", () => {
    require("../moduleHeat").notifyEntityRackHeatSourcesToOwner(scene, entity, { ownerLeaving: true });
  });
  runFeature(scene, point, "mobileMicroJumpUnit", () => {
    require("../../../services/ship/mobileMicroJumpUnitRuntime").clearSpoolsForSession(scene, session);
  });
  runFeature(scene, point, "fireShow", () => {
    require("../../FireShow/fireShowRuntime").handleSessionDisconnected(session, scene);
  });
  runFeature(scene, point, "transientStargates", () => {
    require("../../transientStargates").handleSessionDisconnected(session, scene);
  });
}

// notifySessionLeaving's disembark list (44922d2's disembarkSession): safe
// logoff, self-destruct, link-with-ship, then, when the pilot leaves a ship,
// its rack heat clear, tow and customs.
function notifyDisembarking(scene, session, entity) {
  const point = "sessionLeaving";
  const shipID = session && session._space ? session._space.shipID : null;
  runFeature(scene, point, "safeLogoff", () => {
    if (session && session._safeLogoff) {
      require("../../../services/ship/safeLogoffRuntime").abort(session);
    }
  });
  runFeature(scene, point, "selfDestruct", () => {
    require("../../../services/ship/selfDestructRuntime").handleSceneDeparture(session, {
      shipID,
      lifecycleReason: "disembark",
    });
  });
  runFeature(scene, point, "linkWithShip", () => {
    require("../../../services/spaceComponents/linkWithShipRuntime").breakLinksForSession(
      scene,
      session,
      "disembark",
    );
  });
  if (!entity) {
    return;
  }
  runFeature(scene, point, "rackHeat", () => {
    require("../moduleHeat").notifyEntityRackHeatSourcesToOwner(scene, entity, { ownerLeaving: true });
  });
  runFeature(scene, point, "tow", () => {
    require("../../../services/spaceComponents/towGameObjectiveRuntime").handleSessionDisconnected(session);
  });
  runFeature(scene, point, "customsInspection", () => {
    require("../../../services/security/customsInspectionRuntime").handleSceneDeparture(session, {
      lifecycleReason: "ship-control-departure",
      sceneKey: scene.sceneKey,
      shipID,
    });
  });
}

// The scene is being disposed: disposeScene, once disposal is certain and
// before the scene's game clock is released, so a feature can still read sim
// time.
function notifySceneDisposing(scene, _options = {}) {
  const point = "sceneDisposing";
  runFeature(scene, point, "linkWithShip", () => {
    require("../../../services/spaceComponents/linkWithShipRuntime").disposeScene(scene);
  });
  runFeature(scene, point, "tow", () => {
    require("../../../services/spaceComponents/towGameObjectiveRuntime").disposeScene(scene);
  });
  runFeature(scene, point, "pvpFilament", () => {
    require("../../../services/activity/pvpFilamentQueueRuntime").disposeScene(scene);
  });
  runFeature(scene, point, "mobileMicroJumpUnit", () => {
    require("../../../services/ship/mobileMicroJumpUnitRuntime").disposeScene(scene);
  });
  runFeature(scene, point, "fireShow", () => {
    require("../../FireShow/fireShowRuntime").clearScene(scene);
  });
  runFeature(scene, point, "transientStargates", () => {
    require("../../transientStargates").clearScene(scene);
  });
  runFeature(scene, point, "defenderMissiles", () => {
    require("../../modules/defenderMissileRuntime").clearSceneDefenders(scene);
  });
  runFeature(scene, point, "breacherPods", () => {
    require("../../combat/breacherPods").clearScene(scene);
  });
  runFeature(scene, point, "bombs", () => {
    require("../../modules/bombRuntime").clearSceneBombs(scene);
  });
  runFeature(scene, point, "selfDestruct", () => {
    require("../../../services/ship/selfDestructRuntime").handleSceneDisposed(scene.sceneKey);
  });
  runFeature(scene, point, "safeLogoff", () => {
    require("../../../services/ship/safeLogoffRuntime").handleSceneDisposed(scene);
  });
  runFeature(scene, point, "customsInspection", () => {
    require("../../../services/security/customsInspectionRuntime").handleSceneDisposed(scene.sceneKey);
  });
}

// After each scene's Gameplay tick, from the runtime tick (after the
// scene.tick try): the per-scene feature ticks, each in its own try, so no
// throw reaches the runtime's setInterval.
// Docking-approach completion docks a ship its approach flew into range.
function tickSceneFeatures(scene, _wallclockNowMs) {
  const point = "tick";
  runFeature(scene, point, "dockingApproach", () => {
    require("../../runtime").completeArrivedDockingApproaches(scene);
  });
  runFeature(scene, point, "mobileMicroJumpUnit", () => {
    require("../../../services/ship/mobileMicroJumpUnitRuntime").tickScene(scene);
  });
  runFeature(scene, point, "fireShow", () => {
    require("../../FireShow/fireShowRuntime").tickScene(scene);
  });
  runFeature(scene, point, "transientStargates", () => {
    require("../../transientStargates").tickScene(scene);
  });
  runFeature(scene, point, "skyhookRaids", () => {
    require("../../../services/sovereignty/skyhookRaidRuntime").tickScene(scene);
  });
  runFeature(scene, point, "linkWithShip", () => {
    require("../../../services/spaceComponents/linkWithShipRuntime").tickScene(scene);
  });
}

module.exports = {
  notifyEntityAdded,
  notifyEntityRemoved,
  notifySceneDisposing,
  notifySessionLeaving,
  tickSceneFeatures,
};
