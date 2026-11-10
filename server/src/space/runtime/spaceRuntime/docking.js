"use strict";

const runtimeEntryDirname = require("path").resolve(__dirname, "../..");
const path = require("path");
const log = require(path.join(runtimeEntryDirname, "../utils/logger"));
const {
  canEntitiesInteractLocally,
  isSharedPveTarget,
  resolveEntityInteractionScope,
} = require(path.join(runtimeEntryDirname, "./destiny/identity/interactionScope.js"));
const worldData = require(path.join(runtimeEntryDirname, "./worldData"));
const {
  isEntityDisruptiveLanceDebuffed,
} = require(path.join(runtimeEntryDirname, "./modules/superweapons/disruptiveLanceDebuff"));
const {
  lazyRequire,
} = require("../runtimeModuleBoundary");
const {
  isShipMovementLockedByRuntime,
} = require("../shipActionRestrictions");
const {
  DEFAULT_STATION_DOCKING_RADIUS,
  buildDockingDebugState,
  canShipDockAtStation,
  getStationInteractionRadius,
  getStationUndockSpawnState,
} = require("../stationDockingGeometry");

module.exports = {

getStationInteractionRadius(station) {
    return getStationInteractionRadius(station);
  },

getStationUndockSpawnState(station, options = {}) {
    return getStationUndockSpawnState(station, options);
  },

canDockAtStation(session, stationID, maxDistance = DEFAULT_STATION_DOCKING_RADIUS) {
    const dockNow =
      session &&
      session._space &&
      Number.isFinite(Number(session._space.simTimeMs))
        ? Number(session._space.simTimeMs)
        : Date.now();
    try {
      const crimewatchState = lazyRequire("../services/security/crimewatchState");
      if (
        crimewatchState &&
        crimewatchState.isCriminallyFlagged(session && session.characterID, dockNow)
      ) {
        return false;
      }
    } catch (error) {
      log.warn(`[SpaceRuntime] Crimewatch dock check failed: ${error.message}`);
    }

    const entity = this.getEntity(session, session && session._space ? session._space.shipID : null);
    const structure = worldData.getStructureByID(stationID);
    const station =
      worldData.getStationByID(stationID) ||
      structure;
    if (!entity || !station) {
      return false;
    }
    if (!canEntitiesInteractLocally(entity, station)) {
      return false;
    }
    if (isShipMovementLockedByRuntime(entity, dockNow)) {
      return false;
    }
    // "tether/docking disabled ... for 60 seconds" — a Disruptive Lance hit
    // takes the station away as an escape route, not just the warp out.
    if (isEntityDisruptiveLanceDebuffed(entity, dockNow)) {
      return false;
    }
    if (structure) {
      try {
        const structureTetherRestrictionState = lazyRequire("../services/structure/structureTetherRestrictionState");
        const restriction = structureTetherRestrictionState.getCharacterStructureDockingRestriction(
          session && session.characterID,
          dockNow,
          {
            session,
          },
        );
        if (restriction.restricted) {
          return false;
        }
      } catch (error) {
        log.warn(`[SpaceRuntime] Structure docking restriction check failed: ${error.message}`);
      }
    }

    return canShipDockAtStation(entity, station, maxDistance);
  },

getDockingDebugState(session, stationID, maxDistance = DEFAULT_STATION_DOCKING_RADIUS) {
    const entity = this.getEntity(
      session,
      session && session._space ? session._space.shipID : null,
    );
    const station =
      worldData.getStationByID(stationID) ||
      worldData.getStructureByID(stationID);
    return buildDockingDebugState(entity, station, maxDistance);
  },

isDockingDisallowedByModules(session) {
    const scene = this.getSceneForSession(session);
    return scene ? scene.isDockingDisallowedByModules(session) : false;
  },

acceptDocking(session, stationID) {
    const scene = this.getSceneForSession(session);
    return scene
      ? scene.acceptDocking(session, stationID)
      : {
          success: false,
          errorMsg: "SCENE_NOT_FOUND",
        };
  },

// Start the approach a CmdDock from out of docking range is answered with.
  //
  // A station is flown at as Tranquility flies a ship at it, and the server
  // docks the ship when it arrives (see the scene's startStationDockingApproach
  // and completeArrivedDockingApproaches below). Anything else this is handed
  // keeps the follow it has always had: an Upwell structure docks through
  // structureDocking, and no recording shows Tranquility answering a structure
  // dock with DockingApproach.
  startDockingApproach(session, stationID) {
    const scene = this.getSceneForSession(session);
    if (!scene) {
      return false;
    }
    const target = scene.getEntityByID(stationID);
    if (target && target.kind === "station") {
      return scene.startStationDockingApproach(session, stationID);
    }
    return scene.followBall(session, stationID, DEFAULT_STATION_DOCKING_RADIUS, {
      dockingTargetID: stationID,
    });
  },

// Dock a ship whose docking approach has just brought it into range, if a
  // dock asked for at this moment would be accepted.
  //
  // These are the checks beyonce's CmdDock makes for a pilot already in range,
  // in its order and through the same calls, so that an approach can never dock
  // a ship a direct dock would refuse. A refusal is not answered to anybody
  // (there is no call to answer) and the approach is not tried again: the ship
  // flies on as ordered, and the pilot who still wants in asks, and is told why
  // not.
  completeDockingApproach(session, stationID) {
    const shipID = session && session._space ? session._space.shipID : null;
    if (
      lazyRequire("../services/ship/breacherPodDeathRuntime").isShipDeathPending(shipID)
    ) {
      return { success: false, errorMsg: "SHIP_DEATH_PENDING" };
    }
    if (this.isDockingDisallowedByModules(session)) {
      return { success: false, errorMsg: "DOCKING_DISALLOWED_BY_MODULE" };
    }
    if (!this.canDockAtStation(session, stationID)) {
      return { success: false, errorMsg: "DOCKING_NOT_ALLOWED" };
    }
    return this.acceptDocking(session, stationID);
  },

// Called for each scene after its tick: accept the dock of every docking
  // approach that arrived in range during it.
  completeArrivedDockingApproaches(scene) {
    if (
      !scene ||
      !(scene._stationDockingApproaches instanceof Map) ||
      scene._stationDockingApproaches.size === 0
    ) {
      return 0;
    }
    let arrivals;
    try {
      arrivals = scene.takeArrivedStationDockingApproaches();
    } catch (error) {
      // This runs inside the tick of every scene. An approach that cannot even
      // be looked at is dropped, not left to fail the tick again each time.
      scene._stationDockingApproaches.clear();
      log.warn(
        `[SpaceRuntime] Docking approaches dropped for system=${scene.systemID}: ${error.message}`,
      );
      return 0;
    }
    let accepted = 0;
    for (const arrival of arrivals) {
      const characterID = arrival.session && arrival.session.characterID;
      let result;
      try {
        result = this.completeDockingApproach(arrival.session, arrival.stationID);
      } catch (error) {
        log.warn(
          `[SpaceRuntime] Docking approach could not be completed for char=${characterID} station=${arrival.stationID}: ${error.message}`,
        );
        continue;
      }
      if (result && result.success) {
        accepted += 1;
        log.info(
          `[SpaceRuntime] Docking approach arrived, dock accepted for char=${characterID} station=${arrival.stationID}`,
        );
      } else {
        log.info(
          `[SpaceRuntime] Docking approach arrived but the dock was refused for char=${characterID} station=${arrival.stationID}: ${(result && result.errorMsg) || "UNKNOWN_ERROR"}`,
        );
      }
    }
    return accepted;
  },
};
