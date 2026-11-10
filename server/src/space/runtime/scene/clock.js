"use strict";

const runtimeEntryDirname = require("path").resolve(__dirname, "../..");
const path = require("path");
const {
  entityIDsEqual,
  getEntityMapKey,
  normalizeEntityID,
  normalizeEntityIDSet,
  normalizeNonNegativeInt64,
  normalizePersistentEntityID,
  toJSONSafeEntityID,
} = require(path.join(runtimeEntryDirname, "./destiny/identity/entityID.js"));
const {
  PILOT_WARP_ACTIVATION_DELAY_DESTINY_TICKS,
  PILOT_WARP_DESTINATION_ACQUIRE_LEAD_DESTINY_TICKS,
  PILOT_WARP_DESTINATION_STATIC_PRELOAD_DISTANCE_METERS,
  PILOT_WARP_HISTORY_SAFE_DESTINY_LEAD,
  PILOT_WARP_SOURCE_REMOVAL_SETTLE_MS,
} = require(path.join(runtimeEntryDirname, "./destiny/simulation/warpContract.js"));
const {
  DESTINY_TICK_INTERVAL_MS,
} = require(path.join(runtimeEntryDirname, "./destiny/constants.js"));
const sessionClock = require(path.join(runtimeEntryDirname, "./destiny/delivery/sessionClock.js"));
const {
  currentFileTime,
  buildFiletimeLong,
  buildMarshalReal,
} = require(path.join(runtimeEntryDirname, "../services/_shared/serviceHelpers"));
const {
  getEntitySurfaceDistance,
} = require("../entityDistance");
const {
  clamp,
  roundNumber,
  toFiniteNumber,
  toInt,
} = require("../../../common/numbers");
const {
  SIM_CLOCK_REBASE_INTERVAL_MS,
  clampTimeDilationFactor,
  fileTimeToMs,
  getWallclockNowMs,
  toFileTimeFromMs,
} = require("../runtimeClock");
const {
  recordSessionJumpTimingTrace,
} = require("../runtimeDebugInstrumentation");
const {
  hasFiniteEntityPosition,
} = require("../shipCloak");
const {
  addVectors,
  cloneVector,
  normalizeVector,
  scaleVector,
  subtractVectors,
} = require("../../../common/vector");

module.exports = {

getCurrentWallclockMs() {
    return getWallclockNowMs();
  },

getCurrentSimTimeMs() {
    return this.peekSimTimeForWallclock();
  },

getPositionSnapshot(entityOrID, options = {}) {
    return this.positionAuthority.readEntity(entityOrID, {
      atSimTimeMs: toFiniteNumber(options.atSimTimeMs, this.simTimeMs),
      reason: options.reason || "scene-position-read",
    });
  },

setEntityPosition(entityOrID, position, options = {}) {
    return this.positionAuthority.setEntityPosition(entityOrID, position, {
      ...options,
      atSimTimeMs: toFiniteNumber(options.atSimTimeMs, this.simTimeMs),
    });
  },

// The surface distance between two Balls, as the last Evolve left them:
// every range check reads it, with no projection.
getEntitySurfaceDistance(sourceEntity, targetEntity) {
    if (
      hasFiniteEntityPosition(sourceEntity) &&
      hasFiniteEntityPosition(targetEntity)
    ) {
      return getEntitySurfaceDistance(sourceEntity, targetEntity);
    }
    return Infinity;
  },

// The same pair read through the position authority: whether both Balls can
// be read, and their live centre and surface distances.
getEntitySurfaceState(sourceEntity, targetEntity) {
    const state = this.positionAuthority.getSurfaceState(
      sourceEntity,
      targetEntity,
      { atSimTimeMs: this.simTimeMs, reason: "range-read" },
    );
    return {
      ...state,
      projected: false,
      sourceEntity,
      targetEntity,
      positionSample: state,
    };
  },

peekSimTimeForWallclock(wallclockNow = this.getCurrentWallclockMs()) {
    const normalizedWallclockNow = toFiniteNumber(
      wallclockNow,
      this.getCurrentWallclockMs(),
    );
    const lastWallclockTickAt = toFiniteNumber(
      this.lastWallclockTickAt,
      normalizedWallclockNow,
    );
    const wallclockDeltaMs = Math.max(0, normalizedWallclockNow - lastWallclockTickAt);
    return Math.max(
      0,
      toFiniteNumber(this.simTimeMs, normalizedWallclockNow) +
        (wallclockDeltaMs * clampTimeDilationFactor(this.timeDilation)),
    );
  },

advanceClock(wallclockNow = this.getCurrentWallclockMs()) {
    const normalizedWallclockNow = toFiniteNumber(
      wallclockNow,
      this.getCurrentWallclockMs(),
    );
    const nextSimTimeMs = this.peekSimTimeForWallclock(normalizedWallclockNow);
    const previousSimTimeMs = Math.max(0, toFiniteNumber(this.simTimeMs, normalizedWallclockNow));
    const previousWallclockTickAt = toFiniteNumber(
      this.lastWallclockTickAt,
      normalizedWallclockNow,
    );
    this.lastWallclockTickAt = normalizedWallclockNow;
    this.simTimeMs = nextSimTimeMs;
    return {
      wallclockNowMs: normalizedWallclockNow,
      wallclockDeltaMs: Math.max(0, normalizedWallclockNow - previousWallclockTickAt),
      simNowMs: nextSimTimeMs,
      simDeltaMs: Math.max(0, nextSimTimeMs - previousSimTimeMs),
    };
  },

getCurrentFileTime() {
    return toFileTimeFromMs(this.getCurrentSimTimeMs(), currentFileTime());
  },

toFileTimeFromSimMs(value, fallback = this.getCurrentFileTime()) {
    return toFileTimeFromMs(value, fallback);
  },

getSessionClockOffsetMs(session) {
    return sessionClock.getSessionClockOffsetMs(session);
  },

// Where the pilot's client has this ship in warp: where the server has it.
// Both run the same Evolve from the one WarpTo, so there is no trail
// to model.
getPilotPerceivedWarpSnapshot(entity) {
    if (!entity || entity.mode !== "WARP") {
      return null;
    }
    return {
      complete: false,
      position: cloneVector(entity.position),
      velocity: cloneVector(entity.velocity),
    };
  },

getPilotPerceivedWarpPosition(entity) {
    const snapshot = this.getPilotPerceivedWarpSnapshot(entity);
    return snapshot ? snapshot.position : null;
  },

translateSimTimeForSession(session, rawSimTimeMs) {
    return sessionClock.translateSimTimeForSession(
      session,
      rawSimTimeMs,
      this.getCurrentSimTimeMs(),
    );
  },

getCurrentSessionSimTimeMs(session, rawSimTimeMs = this.getCurrentSimTimeMs()) {
    return sessionClock.getCurrentSessionSimTimeMs(
      session,
      rawSimTimeMs,
      this.getCurrentSimTimeMs(),
    );
  },

getCurrentSessionFileTime(session, rawSimTimeMs = this.getCurrentSimTimeMs()) {
    const currentSessionSimTimeMs = this.getCurrentSessionSimTimeMs(
      session,
      rawSimTimeMs,
    );
    return toFileTimeFromMs(currentSessionSimTimeMs, this.getCurrentFileTime());
  },

refreshSessionClockSnapshot(
    session,
    rawSimTimeMs = this.getCurrentSimTimeMs(),
    options = {},
  ) {
    if (!session || !session._space) {
      return null;
    }

    const currentSessionSimTimeMs =
      options.currentSimTimeMs === undefined || options.currentSimTimeMs === null
        ? this.getCurrentSessionSimTimeMs(session, rawSimTimeMs)
        : toFiniteNumber(options.currentSimTimeMs, this.getCurrentSessionSimTimeMs(session, rawSimTimeMs));
    const currentSessionSimFileTime = toFileTimeFromMs(
      currentSessionSimTimeMs,
      this.getCurrentFileTime(),
    );
    session._space.timeDilation = this.getTimeDilation();
    session._space.simTimeMs = currentSessionSimTimeMs;
    session._space.simFileTime = currentSessionSimFileTime;
    return {
      currentSimTimeMs: currentSessionSimTimeMs,
      currentSimFileTime: currentSessionSimFileTime,
      timeDilation: this.getTimeDilation(),
    };
  },

getTimeDilation() {
    return clampTimeDilationFactor(this.timeDilation);
  },

buildTimeStateSnapshot() {
    return {
      systemID: this.systemID,
      timeDilation: this.getTimeDilation(),
      simTimeMs: this.getCurrentSimTimeMs(),
      simFileTime: this.getCurrentFileTime(),
      destinyStamp: this.nextDestinyStamp,
    };
  },

syncSessionSimClock(session, options = {}) {
    if (!session || !session._space) {
      return null;
    }
    const expectedSpaceGeneration =
      options.expectedSpaceGeneration &&
      typeof options.expectedSpaceGeneration === "object"
        ? options.expectedSpaceGeneration
        : session._space;
    if (session._space !== expectedSpaceGeneration) {
      return null;
    }

    const rawSceneSimTimeMs = this.getCurrentSimTimeMs();
    const previousSimTimeMs =
      options.previousSimTimeMs === undefined || options.previousSimTimeMs === null
        ? fileTimeToMs(expectedSpaceGeneration.simFileTime, rawSceneSimTimeMs)
        : toFiniteNumber(options.previousSimTimeMs, rawSceneSimTimeMs);
    const currentSimTimeMs =
      options.currentSimTimeMs === undefined || options.currentSimTimeMs === null
        ? this.getCurrentSessionSimTimeMs(session, rawSceneSimTimeMs)
        : toFiniteNumber(
            options.currentSimTimeMs,
            this.getCurrentSessionSimTimeMs(session, rawSceneSimTimeMs),
          );
    const previousSimFileTime = toFileTimeFromMs(
      previousSimTimeMs,
      this.getCurrentFileTime(),
    );
    const currentSimFileTime = toFileTimeFromMs(
      currentSimTimeMs,
      this.getCurrentFileTime(),
    );
    const shouldEmitRebase =
      options.emit !== false &&
      typeof session.sendNotification === "function" &&
      (options.forceRebase === true || previousSimFileTime !== currentSimFileTime);

    if (shouldEmitRebase) {
      const rebaseDeliveryResult = session.sendNotification(
        "DoSimClockRebase",
        "clientID",
        [[
          { type: "long", value: previousSimFileTime },
          { type: "long", value: currentSimFileTime },
        ]],
      );
      if (rebaseDeliveryResult === false) {
        return false;
      }
      if (session._space !== expectedSpaceGeneration) {
        return null;
      }
    }

    const preserveBootstrapClockOffset =
      expectedSpaceGeneration.initialStateSent !== true &&
      expectedSpaceGeneration.deferInitialBallparkStateUntilBind === true;
    if (!preserveBootstrapClockOffset) {
      expectedSpaceGeneration.clockOffsetMs = roundNumber(
        currentSimTimeMs - rawSceneSimTimeMs,
        3,
      );
    }
    this.refreshSessionClockSnapshot(session, currentSimTimeMs, {
      currentSimTimeMs,
    });

    const result = {
      previousSimTimeMs,
      currentSimTimeMs,
      previousSimFileTime,
      currentSimFileTime,
      timeDilation: this.getTimeDilation(),
    };
    recordSessionJumpTimingTrace(session, "sync-session-sim-clock", {
      emit: options.emit !== false,
      forceRebase: options.forceRebase === true,
      deltaMs: roundNumber(currentSimTimeMs - previousSimTimeMs, 3),
      result,
    });
    return result;
  },

syncAllSessionSimClocks(options = {}) {
    const synced = [];
    for (const session of this.sessions.values()) {
      const result = this.syncSessionSimClock(session, options);
      if (result) {
        synced.push({
          clientID: session.clientID,
          characterID: session.characterID,
          ...result,
        });
      }
    }
    return synced;
  },

maybeBroadcastSimClockUpdate(clockState) {
    if (!clockState || this.sessions.size === 0) {
      return [];
    }

    const wallclockNowMs = toFiniteNumber(
      clockState.wallclockNowMs,
      this.getCurrentWallclockMs(),
    );
    const minimumIntervalMs =
      this.getTimeDilation() < 1
        ? SIM_CLOCK_REBASE_INTERVAL_MS
        : DESTINY_TICK_INTERVAL_MS;
    if (
      wallclockNowMs - toFiniteNumber(
        this.lastSimClockBroadcastWallclockAt,
        0,
      ) < minimumIntervalMs
    ) {
      return [];
    }

    this.lastSimClockBroadcastWallclockAt = wallclockNowMs;
    return this.syncAllSessionSimClocks({
      emit: true,
      forceRebase: true,
      currentSimTimeMs: clockState.simNowMs,
    });
  },

  // Sets this scene's time dilation factor on the server, which slows the sim clock (warp,
  // movement, Destiny stamps). The client's TiDi HUD notification is sent separately, by /tidi
  // and the autoscaler through utils/synchronizedTimeDilation.js.
  setTimeDilation(value, options = {}) {
    const previousFactor = this.getTimeDilation();
    const nextFactor = clampTimeDilationFactor(value, previousFactor);

    const clockState = this.advanceClock(options.wallclockNowMs);
    const previousSimTimeMs = clockState.simNowMs;
    this.timeDilation = nextFactor;
    this.lastTimeDilationRecoveryAtMs =
      previousFactor < 1 && nextFactor >= 1
        ? previousSimTimeMs
        : 0;

    this.lastSimClockBroadcastWallclockAt = clockState.wallclockNowMs;
    if (options.syncSessions !== false) {
      this.syncAllSessionSimClocks({
        ...options,
        previousSimTimeMs,
        currentSimTimeMs: this.getCurrentSimTimeMs(),
        forceRebase: options.forceRebase === true,
      });
    }

    return {
      systemID: this.systemID,
      previousFactor,
      factor: nextFactor,
      simTimeMs: this.getCurrentSimTimeMs(),
      simFileTime: this.getCurrentFileTime(),
      syncedSessionCount: this.sessions.size,
    };
  },
};
