"use strict";

const runtimeEntryDirname = require("path").resolve(__dirname, "../..");
const path = require("path");
const log = require(path.join(runtimeEntryDirname, "../utils/logger"));
const {
  materializeAmbientStartupControllersForScene,
  dematerializeAmbientStartupControllersForScene,
} = require(path.join(runtimeEntryDirname, "./npc/npcAmbientMaterialization"));
const {
  materializeDormantCombatControllersForScene,
  dematerializeDormantCombatControllersForScene,
} = require(path.join(runtimeEntryDirname, "./npc/npcCombatDormancy"));
const {
  toFiniteNumber,
  toInt,
} = require("../../../common/numbers");
const {
  SCENE_KIND_ABYSSAL,
  SCENE_KIND_SOLAR_SYSTEM,
  buildAbyssalSceneKey,
  getSceneKeyForSession,
  normalizeSceneDescriptor,
  normalizeSceneText,
} = require("../sceneIdentity");
const {
  buildStructureObserverSpaceState,
} = require("../structureSessionHost");

// How long an arrival prewarm's content prepare stands in for the arrival's
// own. A stargate hold is about 4 s; the margin covers Time Dilation.
const ARRIVAL_PREWARM_VALID_MS = 30_000;

module.exports = {

getSceneForSession(session) {
    if (!session || !session._space) {
      return null;
    }

    const sceneKey = getSceneKeyForSession(session);
    return sceneKey ? this.scenes.get(sceneKey) || null : null;
  },

getAbyssalOfflineSessionForRun(runID, characterID) {
    const normalizedRunID = toInt(runID, 0);
    const normalizedCharacterID = toInt(characterID, 0);
    if (normalizedRunID <= 0 || normalizedCharacterID <= 0) {
      return null;
    }

    const expectedSceneKey = buildAbyssalSceneKey(normalizedRunID);
    const scene = this.scenes.get(expectedSceneKey);
    if (
      !scene ||
      scene.sceneKind !== SCENE_KIND_ABYSSAL ||
      toInt(scene.instanceID, 0) !== normalizedRunID ||
      normalizeSceneText(scene.sceneKey, "") !== expectedSceneKey ||
      !(scene.sessions instanceof Map) ||
      !(scene.dynamicEntities instanceof Map)
    ) {
      return null;
    }

    for (const candidate of scene.sessions.values()) {
      if (
        !candidate ||
        candidate._abyssalOfflineSession !== true ||
        toInt(candidate._abyssalOfflineRunID, 0) !== normalizedRunID ||
        toInt(candidate.characterID || candidate.charid, 0) !== normalizedCharacterID ||
        !candidate._space ||
        candidate._space.sceneKind !== SCENE_KIND_ABYSSAL ||
        normalizeSceneText(candidate._space.sceneKey, "") !== expectedSceneKey ||
        toInt(candidate._space.instanceID, 0) !== normalizedRunID
      ) {
        continue;
      }
      const shipID = toInt(candidate._space.shipID, 0);
      const entity = shipID > 0 ? scene.dynamicEntities.get(shipID) : null;
      if (
        entity &&
        entity.kind === "ship" &&
        entity.session === candidate
      ) {
        return candidate;
      }
    }
    return null;
  },

retireAbyssalOfflineSessionsForAttachment(scene, session, entity) {
    if (
      !scene ||
      scene.sceneKind !== SCENE_KIND_ABYSSAL ||
      !(scene.sessions instanceof Map) ||
      !session ||
      !entity
    ) {
      return 0;
    }
    const characterID = toInt(session.characterID || session.charid, 0);
    const shipID = toInt(entity.itemID, 0);
    if (characterID <= 0 || shipID <= 0) {
      return 0;
    }

    let retiredCount = 0;
    for (const [clientID, candidate] of [...scene.sessions.entries()]) {
      if (
        !candidate ||
        candidate === session ||
        candidate._abyssalOfflineSession !== true ||
        toInt(candidate.characterID || candidate.charid, 0) !== characterID ||
        toInt(candidate._space && candidate._space.shipID, 0) !== shipID
      ) {
        continue;
      }
      scene.sessions.delete(clientID);
      if (candidate.socket && candidate.socket._abyssalOfflineTransport === true) {
        candidate.socket.destroyed = true;
      }
      candidate._space = null;
      retiredCount += 1;
    }
    return retiredCount;
  },

// Every route into space (gate, wormhole, GM move, jump drive, undock, login,
// Abyssal entry and return) brings the HUD's system-wide effects in step with
// the scene. A same-scene re-attach sends nothing.
syncSystemWideEffectsForAttachment(scene, session, systemID) {
    return require(path.join(
      runtimeEntryDirname,
      "../services/exploration/wormholes/systemWideEffectsSync",
    )).syncSessionSystemWideEffects(
      session,
      scene && scene.sceneKind === SCENE_KIND_SOLAR_SYSTEM ? systemID : 0,
    );
  },

attachSession(session, shipItem, options = {}) {
    if (!session || !shipItem) {
      return null;
    }
    const previousSimTimeMs =
      options.previousSimTimeMs === undefined || options.previousSimTimeMs === null
        ? (
          session && session._space
            ? this.getSimulationTimeMsForSession(session, null)
            : null
        )
        : toFiniteNumber(options.previousSimTimeMs, null);
    const sceneDescriptor = normalizeSceneDescriptor(
      options.sceneDescriptor || options.systemID || session.solarsystemid || session.solarsystemid2,
    );
    const numericSystemID = toInt(sceneDescriptor && sceneDescriptor.locationID, 0);
    if (!numericSystemID) {
      return null;
    }

    const shouldReconcileUniverseSites =
      sceneDescriptor.sceneKind === SCENE_KIND_SOLAR_SYSTEM &&
      options.reconcileUniverseSites !== false;
    const entryPreparation = shouldReconcileUniverseSites
      ? this.prepareUniverseSitesForPlayerEntry(numericSystemID, {
        ...options,
        reconcileUniverseSites: true,
      })
      : { success: true, prepared: true };
    const preparationFailed = !entryPreparation || entryPreparation.success === false;
    let preparedForEntry = Boolean(entryPreparation && entryPreparation.prepared === true);
    const preparationDeferred = Boolean(
      entryPreparation && entryPreparation.deferred === true,
    );
    const scene = this.ensureScene(sceneDescriptor, {
      reconcileUniverseSites:
        shouldReconcileUniverseSites && !preparationFailed && (
          preparedForEntry ||
          options.deferUniverseSiteReconcile !== true
        ),
      universeSiteReconcileReason: options.universeSiteReconcileReason,
      synchronousUniverseSiteReconcile: options.synchronousUniverseSiteReconcile === true,
      universeSiteReconcileInitialDelayMs: options.universeSiteReconcileInitialDelayMs,
      nowMs: options.nowMs,
    });
    if (!scene) {
      return null;
    }
    if (preparationFailed && shouldReconcileUniverseSites) {
      const fallbackPreparation = this.recoverUniverseSitesForPlayerEntry(
        scene,
        numericSystemID,
        options,
      );
      preparedForEntry = Boolean(fallbackPreparation && fallbackPreparation.success === true);
    }
    if (shouldReconcileUniverseSites) {
      this.materializePreparedUniverseSitesForPlayerEntry(scene, entryPreparation);
    }
    const offlineAttachmentSession =
      scene.sceneKind === SCENE_KIND_ABYSSAL
        ? this.getAbyssalOfflineSessionForRun(
            scene.instanceID,
            session.characterID || session.charid,
          )
        : null;
    const resumingExactOfflineShip = Boolean(
      offlineAttachmentSession &&
      toInt(offlineAttachmentSession._space && offlineAttachmentSession._space.shipID, 0) ===
        toInt(shipItem.itemID, 0),
    );
    const existingShipEntity = scene.dynamicEntities instanceof Map
      ? scene.dynamicEntities.get(toInt(shipItem.itemID, 0))
      : null;
    if (
      existingShipEntity &&
      existingShipEntity.session &&
      existingShipEntity.session._abyssalOfflineSession === true &&
      !resumingExactOfflineShip
    ) {
      log.warn(
        `[SpaceRuntime] Refusing conflicting Abyssal offline attachment ` +
          `char=${toInt(session.characterID || session.charid, 0)} ` +
          `ship=${toInt(shipItem.itemID, 0)} scene=${normalizeSceneText(scene.sceneKey, "none")}`,
      );
      return null;
    }
    const wakeStartedAtMs = Date.now();
    // The retained scene has remained awake while the pilot was offline. A
    // forced catch-up tick here could destroy the ship and then let the stale
    // login item re-create it in the next line. Make the ownership handoff
    // atomic with respect to scene simulation instead.
    const wakeResult = resumingExactOfflineShip
      ? { success: true, skipped: true, reason: "abyssal-offline-handoff" }
      : this.wakeSceneForImmediateUse(scene, {
          reason: "attach-session",
          relevantPositions: [
            shipItem &&
            shipItem.spaceState &&
            shipItem.spaceState.position,
          ].filter(Boolean),
          materializeAmbientStartup: sceneDescriptor.sceneKind === SCENE_KIND_SOLAR_SYSTEM,
          materializeDormantCombat: sceneDescriptor.sceneKind === SCENE_KIND_SOLAR_SYSTEM,
        });
    const wakeElapsedMs = Date.now() - wakeStartedAtMs;
    if (wakeElapsedMs >= 500) {
      log.info(
        `[SpaceRuntime] wakeSceneForImmediateUse system=${numericSystemID} ` +
        `reason=attach-session took ${wakeElapsedMs}ms`,
      );
    }
    if (!wakeResult || wakeResult.success === false) {
      log.warn(
        `[SpaceRuntime] wakeSceneForImmediateUse failed for system=${numericSystemID}: ` +
        `${wakeResult && wakeResult.errorMsg ? wakeResult.errorMsg : "UNKNOWN_ERROR"}`,
      );
    }
    if (session && session._space) {
      this.detachSession(session, { broadcast: false,
        preserveCustomsCase: session._space.sceneKey === scene.sceneKey &&
          Number(session._space.shipID) === Number(shipItem.itemID),
      });
    }
    const attachStartedAtMs = Date.now();
    const attached = resumingExactOfflineShip && existingShipEntity
      ? scene.attachSessionToExistingEntity(session, shipItem, existingShipEntity, {
          ...options,
          sceneDescriptor,
          forceSimClockRebase: options.forceSimClockRebase === true,
          previousSimTimeMs,
          preserveAuthoritativeEntityState: true,
          spawnStopped: false,
          undockDirection: null,
        })
      : scene.attachSession(session, shipItem, {
          ...options,
          sceneDescriptor,
          forceSimClockRebase: options.forceSimClockRebase === true,
          previousSimTimeMs,
        });
    if (attached) {
      this.noteSolarSystemSceneOccupied(scene);
      this.retireAbyssalOfflineSessionsForAttachment(scene, session, attached);
      this.syncSystemWideEffectsForAttachment(scene, session, numericSystemID);
    }
    const attachElapsedMs = Date.now() - attachStartedAtMs;
    if (attachElapsedMs >= 500) {
      log.info(
        `[SpaceRuntime] scene.attachSession system=${numericSystemID} ship=${Number(shipItem && shipItem.itemID) || 0} ` +
        `took ${attachElapsedMs}ms`,
      );
    }
    if (
      shouldReconcileUniverseSites &&
      !preparedForEntry &&
      !preparationDeferred
    ) {
      const universeSiteAnchor = attached || {
        position:
          shipItem &&
          shipItem.spaceState &&
          shipItem.spaceState.position,
      };
      const universeSiteOptions = {
        reason: options.universeSiteReconcileReason || "attach-session",
        nowMs: Date.now(),
        broadcast: true,
        excludedSession: session || null,
        session: session || null,
        synchronousUniverseSiteReconcile: preparationFailed,
      };
      if (options.deferUniverseSiteReconcile === true && !preparationFailed) {
        this.queueAttachUniverseSiteReconcile(
          scene,
          universeSiteAnchor,
          universeSiteOptions,
        );
      } else {
        this.runAttachUniverseSiteReconcile(
          scene,
          universeSiteAnchor,
          universeSiteOptions,
        );
      }
    }
    // Its customs case and self-destruct countdown resume from the scene's
    // attach (Scene feature hooks).
    return attached;
  },

// The front half of attachSession for a system a pilot is about to enter:
// content prepare, scene bootstrap and the prepared-site materialize. A
// stargate jump runs it inside its hold so the handoff only attaches. The
// scene is marked so the arrival's prepare does not run again.
prewarmSolarSystemForArrival(systemID, options = {}) {
    const sceneDescriptor = normalizeSceneDescriptor(systemID);
    const numericSystemID = toInt(sceneDescriptor && sceneDescriptor.locationID, 0);
    if (!numericSystemID || sceneDescriptor.sceneKind !== SCENE_KIND_SOLAR_SYSTEM) {
      return { success: false, errorMsg: "INVALID_SOLAR_SYSTEM" };
    }
    const existingScene = this.scenes.get(sceneDescriptor.sceneKey) || null;
    const wallclockNowMs = Date.now();
    if (existingScene && existingScene.sessions instanceof Map && existingScene.sessions.size > 0) {
      return { success: true, skipped: true, reason: "scene_already_awake" };
    }
    if (
      existingScene &&
      toFiniteNumber(existingScene._arrivalPrewarmExpiresAtWallclockMs, 0) >= wallclockNowMs
    ) {
      return { success: true, skipped: true, reason: "already_prewarmed" };
    }

    const startedAtMs = Date.now();
    const entryPreparation = this.prepareUniverseSitesForPlayerEntry(numericSystemID, {
      reconcileUniverseSites: true,
      universeSiteReconcileReason: options.reason || "arrival-prewarm",
      nowMs: options.nowMs,
    });
    const prepared = Boolean(
      entryPreparation &&
      entryPreparation.success !== false &&
      entryPreparation.prepared === true,
    );
    const scene = this.ensureScene(sceneDescriptor, {
      reconcileUniverseSites: prepared,
      universeSiteReconcileReason: options.reason || "arrival-prewarm",
      nowMs: options.nowMs,
    });
    if (!scene) {
      return { success: false, errorMsg: "SCENE_NOT_FOUND" };
    }
    if (prepared) {
      this.materializePreparedUniverseSitesForPlayerEntry(scene, entryPreparation);
      // A failed prepare leaves no mark, so the arrival runs the full path.
      scene._arrivalPrewarmExpiresAtWallclockMs =
        Date.now() + ARRIVAL_PREWARM_VALID_MS;
    }
    return {
      success: true,
      prepared,
      created: !existingScene,
      elapsedMs: Date.now() - startedAtMs,
    };
  },

attachSessionToExistingEntity(session, shipItem, entity, options = {}) {
    if (!session || !shipItem || !entity || entity.kind !== "ship") {
      return null;
    }
    const previousSimTimeMs =
      options.previousSimTimeMs === undefined || options.previousSimTimeMs === null
        ? (
          session && session._space
            ? this.getSimulationTimeMsForSession(session, null)
            : null
        )
        : toFiniteNumber(options.previousSimTimeMs, null);
    const sceneDescriptor = normalizeSceneDescriptor(
      options.sceneDescriptor || options.systemID || session.solarsystemid || session.solarsystemid2,
    );
    const numericSystemID = toInt(sceneDescriptor && sceneDescriptor.locationID, 0);
    if (!numericSystemID) {
      return null;
    }

    const shouldReconcileUniverseSites =
      sceneDescriptor.sceneKind === SCENE_KIND_SOLAR_SYSTEM &&
      options.reconcileUniverseSites !== false;
    const entryPreparation = shouldReconcileUniverseSites
      ? this.prepareUniverseSitesForPlayerEntry(numericSystemID, {
        ...options,
        reconcileUniverseSites: true,
      })
      : { success: true, prepared: true };
    const preparationFailed = !entryPreparation || entryPreparation.success === false;
    let preparedForEntry = Boolean(entryPreparation && entryPreparation.prepared === true);
    const preparationDeferred = Boolean(
      entryPreparation && entryPreparation.deferred === true,
    );
    const scene = this.ensureScene(sceneDescriptor, {
      reconcileUniverseSites:
        shouldReconcileUniverseSites && !preparationFailed && (
          preparedForEntry ||
          options.deferUniverseSiteReconcile !== true
        ),
      universeSiteReconcileReason: options.universeSiteReconcileReason,
      synchronousUniverseSiteReconcile: options.synchronousUniverseSiteReconcile === true,
      universeSiteReconcileInitialDelayMs: options.universeSiteReconcileInitialDelayMs,
      nowMs: options.nowMs,
    });
    if (!scene) {
      return null;
    }
    if (preparationFailed && shouldReconcileUniverseSites) {
      const fallbackPreparation = this.recoverUniverseSitesForPlayerEntry(
        scene,
        numericSystemID,
        options,
      );
      preparedForEntry = Boolean(fallbackPreparation && fallbackPreparation.success === true);
    }
    if (shouldReconcileUniverseSites) {
      this.materializePreparedUniverseSitesForPlayerEntry(scene, entryPreparation);
    }
    const offlineAttachmentSession =
      scene.sceneKind === SCENE_KIND_ABYSSAL
        ? this.getAbyssalOfflineSessionForRun(
            scene.instanceID,
            session.characterID || session.charid,
          )
        : null;
    const resumingExactOfflineShip = Boolean(
      offlineAttachmentSession &&
      toInt(offlineAttachmentSession._space && offlineAttachmentSession._space.shipID, 0) ===
        toInt(entity.itemID, 0) &&
      entity.session === offlineAttachmentSession,
    );
    if (
      entity.session &&
      entity.session._abyssalOfflineSession === true &&
      !resumingExactOfflineShip
    ) {
      log.warn(
        `[SpaceRuntime] Refusing conflicting existing-entity Abyssal offline attachment ` +
          `char=${toInt(session.characterID || session.charid, 0)} ` +
          `ship=${toInt(entity.itemID, 0)} scene=${normalizeSceneText(scene.sceneKey, "none")}`,
      );
      return null;
    }
    if (!resumingExactOfflineShip) {
      this.wakeSceneForImmediateUse(scene, {
        reason: "attach-session-existing-entity",
        relevantEntities: [entity].filter(Boolean),
        materializeAmbientStartup: sceneDescriptor.sceneKind === SCENE_KIND_SOLAR_SYSTEM,
        materializeDormantCombat: sceneDescriptor.sceneKind === SCENE_KIND_SOLAR_SYSTEM,
      });
    }
    if (session && session._space) {
      this.detachSession(session, { broadcast: false,
        preserveCustomsCase: session._space.sceneKey === scene.sceneKey &&
          Number(session._space.shipID) === Number(shipItem.itemID),
      });
    }
    const attached = scene.attachSessionToExistingEntity(session, shipItem, entity, {
      ...options,
      sceneDescriptor,
      forceSimClockRebase: options.forceSimClockRebase === true,
      previousSimTimeMs,
      preserveAuthoritativeEntityState: resumingExactOfflineShip,
      ...(resumingExactOfflineShip
        ? { spawnStopped: false, undockDirection: null }
        : {}),
    });
    if (attached) {
      this.noteSolarSystemSceneOccupied(scene);
      this.retireAbyssalOfflineSessionsForAttachment(scene, session, attached);
      this.syncSystemWideEffectsForAttachment(scene, session, numericSystemID);
    }
    if (
      shouldReconcileUniverseSites &&
      !preparedForEntry &&
      !preparationDeferred
    ) {
      const universeSiteOptions = {
        reason:
          options.universeSiteReconcileReason ||
          "attach-session-existing-entity",
        nowMs: Date.now(),
        broadcast: true,
        excludedSession: session || null,
        session: session || null,
        synchronousUniverseSiteReconcile: preparationFailed,
      };
      if (options.deferUniverseSiteReconcile === true && !preparationFailed) {
        this.queueAttachUniverseSiteReconcile(
          scene,
          attached || entity,
          universeSiteOptions,
        );
      } else {
        this.runAttachUniverseSiteReconcile(
          scene,
          attached || entity,
          universeSiteOptions,
        );
      }
    }
    // Its customs case and self-destruct countdown resume from the scene's
    // attach (Scene feature hooks).
    return attached;
  },

detachSession(session, options = {}) {
    if (!session || !session._space) {
      return;
    }

    const scene = this.getSceneForSession(session);
    if (scene) {
      // Safe logoff, self-destruct, link-with-ship and customs are told by the
      // scene's detach, while the session is still its Observer (Scene feature
      // hooks).
      const detachResult = scene.detachSession(session, options);
      if (scene.sessions instanceof Map && scene.sessions.size === 0) {
        this.noteSolarSystemSceneEmpty(scene, options.wallclockNowMs);
        dematerializeAmbientStartupControllersForScene(scene, {
          broadcast: false,
        });
        dematerializeDormantCombatControllersForScene(scene, {
          broadcast: false,
          nowMs: toFiniteNumber(
            scene.getCurrentSimTimeMs && scene.getCurrentSimTimeMs(),
            Date.now(),
          ),
        });
      }
      return detachResult;
    } else {
      session._space = null;
    }
    return null;
  },

disembarkSession(session, options = {}) {
    if (!session || !session._space) {
      return null;
    }

    const scene = this.getSceneForSession(session);
    if (!scene) {
      session._space = null;
      return null;
    }

    // Safe logoff, self-destruct, link-with-ship and customs are told by the
    // scene's disembark, before the session leaves it (Scene feature hooks).
    const entity = scene.disembarkSession(session, options);
    if (scene.sessions instanceof Map && scene.sessions.size === 0) {
      this.noteSolarSystemSceneEmpty(scene, options.wallclockNowMs);
      dematerializeAmbientStartupControllersForScene(scene, {
        broadcast: false,
      });
      dematerializeDormantCombatControllersForScene(scene, {
        broadcast: false,
        nowMs: toFiniteNumber(
          scene.getCurrentSimTimeMs && scene.getCurrentSimTimeMs(),
          Date.now(),
        ),
      });
    }
    return entity;
  },

markBeyonceBound(session) {
    const scene = this.getSceneForSession(session);
    if (scene) {
      scene.markBeyonceBound(session);
    }
  },

bindControlledStructureSession(session, structureID, options = {}) {
    const systemID = toInt(
      options.solarSystemID ||
        (session && session._space && session._space.systemID) ||
        (session && (session.solarsystemid2 || session.solarsystemid)),
      0,
    );
    if (!session || toInt(structureID, 0) <= 0 || systemID <= 0) {
      return { success: false, errorMsg: "STRUCTURE_NOT_FOUND" };
    }
    const scene = this.ensureScene(systemID);
    if (!scene) {
      return { success: false, errorMsg: "STRUCTURE_NOT_FOUND" };
    }
    const result = scene.bindControlledStructureSession(
      session,
      structureID,
      options,
    );
    if (result && result.success === true) {
      this.noteSolarSystemSceneOccupied(scene);
    }
    return result;
  },

releaseControlledStructureSession(session, options = {}) {
    const scene = this.getSceneForSession(session);
    if (!scene) {
      const sessionStillClaimsControl = Boolean(
        session &&
        toInt(session.shipID || session.shipid, 0) > 0 &&
        toInt(session.shipID || session.shipid, 0) ===
          toInt(session.structureID || session.structureid, 0),
      );
      if (session && !sessionStillClaimsControl) {
        delete session._structureControlPreviousSpace;
        session._structureViewSpace = null;
      }
      return sessionStillClaimsControl
        ? {
            success: false,
            errorMsg: "STRUCTURE_CONTROL_SCENE_NOT_FOUND",
            data: { changed: false, entity: null },
          }
        : { success: true, data: { changed: false, entity: null } };
    }
    const result = scene.releaseControlledStructureSession(session, options);
    if (result && result.success === true) {
      if (scene.sessions instanceof Map && scene.sessions.size === 0) {
        this.noteSolarSystemSceneEmpty(scene, options.wallclockNowMs);
      } else {
        this.noteSolarSystemSceneOccupied(scene);
      }
    }
    return result;
  },

bootstrapDockedStructureView(session, options = {}) {
    if (!session || session._space) {
      return false;
    }

    const structureID = toInt(
      session && (session.structureID || session.structureid),
      0,
    );
    const systemID = toInt(
      session && (session.solarsystemid || session.solarsystemid2),
      0,
    );
    if (structureID <= 0 || systemID <= 0) {
      return false;
    }

    const scene = this.ensureScene(systemID);
    if (!scene) {
      return false;
    }

    scene.syncStructureEntitiesFromState({
      broadcast: false,
    });
    const structureEntity = scene.getEntityByID(structureID);
    if (!structureEntity || structureEntity.kind !== "structure") {
      return false;
    }

    const previousSpaceState = session._space || null;
    const previousObserverState =
      options.reset === true ||
      !session._structureViewSpace ||
      session._structureViewSpace.pendingBallparkBind === true
        ? null
        : session._structureViewSpace;
    session._structureViewSpace = buildStructureObserverSpaceState(
      scene,
      structureID,
      previousObserverState,
    );
    session._structureViewSpace.pendingBallparkBind = false;
    session._space = session._structureViewSpace;
    // Docking ran detachSession(), which removes the session from scene.sessions.
    // ensureInitialBallpark() refuses to deliver to a session the scene does not
    // own, so register for the duration of the bootstrap only -- the observer
    // view must not leave the session attached to space afterwards.
    const sceneSessions = scene.sessions instanceof Map ? scene.sessions : null;
    const sceneOwnedSession = sceneSessions
      ? sceneSessions.get(session.clientID)
      : undefined;
    const registeredObserverSession = Boolean(
      sceneSessions && sceneOwnedSession !== session,
    );
    if (registeredObserverSession) {
      sceneSessions.set(session.clientID, session);
    }
    this.noteSolarSystemSceneOccupied(scene);
    try {
      const bootstrapResult = scene.ensureInitialBallpark(session, {
        ...options,
        force: options.force === true,
      });
      session._structureViewSpace = session._space;
      return bootstrapResult;
    } finally {
      session._space = previousSpaceState;
      if (registeredObserverSession) {
        if (sceneOwnedSession === undefined) {
          sceneSessions.delete(session.clientID);
        } else {
          sceneSessions.set(session.clientID, sceneOwnedSession);
        }
      }
      if (sceneSessions && sceneSessions.size === 0) {
        this.noteSolarSystemSceneEmpty(scene, options.wallclockNowMs);
      }
    }
  },

prepareDockedStructureView(session) {
    if (!session || session._space) {
      return false;
    }

    const structureID = toInt(
      session && (session.structureID || session.structureid),
      0,
    );
    const systemID = toInt(
      session && (session.solarsystemid || session.solarsystemid2),
      0,
    );
    if (structureID <= 0 || systemID <= 0) {
      return false;
    }

    const scene = this.ensureScene(systemID);
    if (!scene) {
      return false;
    }

    scene.syncStructureEntitiesFromState({
      broadcast: false,
    });
    const structureEntity = scene.getEntityByID(structureID);
    if (!structureEntity || structureEntity.kind !== "structure") {
      return false;
    }

    session._structureViewSpace = buildStructureObserverSpaceState(
      scene,
      structureID,
      null,
    );
    session._structureViewSpace.pendingBallparkBind = true;
    return true;
  },

clearDockedStructureView(session) {
    if (session) {
      session._structureViewSpace = null;
    }
  },
};
