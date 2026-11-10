"use strict";

const runtimeEntryDirname = require("path").resolve(__dirname, "../..");
const path = require("path");
const {
  currentFileTime,
  buildFiletimeLong,
  buildMarshalReal,
} = require(path.join(runtimeEntryDirname, "../services/_shared/serviceHelpers"));
const {
  toFiniteNumber,
} = require("../../../common/numbers");
const {
  getWallclockNowMs,
  setWallclockNowProvider,
} = require("../runtimeClock");

module.exports = {

getSceneTimeSnapshot(systemID) {
    const scene = this.ensureScene(systemID);
    return scene ? scene.buildTimeStateSnapshot() : null;
  },

getSolarSystemTimeDilation(systemID) {
    const scene = this.ensureScene(systemID);
    return scene ? scene.getTimeDilation() : 1;
  },

setSolarSystemTimeDilation(systemID, factor, options = {}) {
    const scene = this.ensureScene(systemID);
    if (!scene) {
      return {
        success: false,
        errorMsg: "SOLAR_SYSTEM_NOT_FOUND",
      };
    }

    return {
      success: true,
      data: scene.setTimeDilation(factor, {
        ...options,
        syncSessions: options.syncSessions !== false,
        emit: options.emit !== false,
        forceRebase: options.forceRebase !== false,
      }),
    };
  },

getSimulationTimeMsForSession(session, fallback = Date.now()) {
    const scene = this.getSceneForSession(session);
    return scene
      ? scene.getCurrentSessionSimTimeMs(session)
      : toFiniteNumber(fallback, Date.now());
  },

getSimulationFileTimeForSession(session, fallback = currentFileTime()) {
    const scene = this.getSceneForSession(session);
    return scene ? scene.getCurrentSessionFileTime(session) : fallback;
  },

getSimulationTimeMsForSystem(systemID, fallback = Date.now()) {
    const scene = this.ensureScene(systemID);
    return scene ? scene.getCurrentSimTimeMs() : toFiniteNumber(fallback, Date.now());
  },

getSimulationFileTimeForSystem(systemID, fallback = currentFileTime()) {
    const scene = this.ensureScene(systemID);
    return scene ? scene.getCurrentFileTime() : fallback;
  },

syncSessionSimClock(session, options = {}) {
    const scene = this.getSceneForSession(session);
    return scene ? scene.syncSessionSimClock(session, options) : null;
  },

// wallclockNowMs lets a caller that owns the clock drive this tick at a time
  // of its choosing; the scene clock derives sim time from it. The production
  // interval calls tick() with no argument and reads the wall clock, unchanged.
  /** The wall clock every scene, wake-up and Abyssal timer judges time by. */
  getWallclockNowMs() {
    return getWallclockNowMs();
  },

/**
   * Own the runtime's wall clock. The gameplay harness points it at its
   * virtual clock so scene time between ticks, scene wake-ups and the
   * Abyssal timers agree with the ticks it drives; null restores Date.now().
   */
  setWallclockNowProvider(provider) {
    setWallclockNowProvider(provider);
  },
};
