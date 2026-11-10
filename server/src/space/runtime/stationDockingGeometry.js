"use strict";

module.exports = {
  buildDockingDebugState,
  canShipDockAtStation,
  clearPendingDock,
  getLegacyStationNormalizationTarget,
  getShipDockingDistanceToStation,
  getStationApproachPosition,
  getStationConfiguredUndockDistance,
  getStationDockDirection,
  getStationDockPosition,
  getStationInteractionRadius,
  getStationUndockSpawnState,
  hasRealStationDockData,
  isNearlySameDirection,
  isStructureDockable,
  normalizeLegacyStationState,
  snapShipToStationPerimeter,
};

const runtimeEntryDirname = require("path").resolve(__dirname, "..");
const path = require("path");
const {
  applyPendingDockStateCommand,
} = require(path.join(runtimeEntryDirname, "./destiny/commands/docking.js"));
const structureLocatorGeometry = require(path.join(
  runtimeEntryDirname,
  "../services/structure/structureLocatorGeometry",
));
const stationLocatorGeometry = require(path.join(
  runtimeEntryDirname,
  "../services/station/stationLocatorGeometry",
));
const worldData = require(path.join(runtimeEntryDirname, "./worldData"));
const {
  roundNumber,
  toFiniteNumber,
} = require("../../common/numbers");
const {
  summarizeVector,
} = require("./runtimeDebugInstrumentation");
const {
  DEFAULT_RIGHT,
  DUPLICATE_DIRECTION_DOT,
  addVectors,
  cloneVector,
  distance,
  dotProduct,
  magnitude,
  normalizeVector,
  scaleVector,
  subtractVectors,
} = require("../../common/vector");

const DEFAULT_STATION_INTERACTION_RADIUS = 1000;

const DEFAULT_STATION_UNDOCK_DISTANCE = 8000;

const DEFAULT_STATION_DOCKING_RADIUS = 2500;

const STATION_DOCK_ACCEPT_DELAY_MS = 4000;

const LEGACY_STATION_NORMALIZATION_RADIUS = 100000;

function getStationConfiguredUndockDistance(station) {
  const undockPosition = station && station.undockPosition;
  if (!station || !station.position || !undockPosition) {
    return 0;
  }

  return distance(
    cloneVector(station.position),
    cloneVector(undockPosition),
  );
}

function hasRealStationDockData(station) {
  return Boolean(
    station &&
      station.dockPosition &&
      station.dockOrientation &&
      magnitude(cloneVector(station.dockOrientation)) > 0,
  );
}

function isStructureDockable(station) {
  return Boolean(
    station &&
      (
        station.kind === "structure" ||
        station.isStructure === true ||
        Number(station.structureID || 0) > 0
      ),
  );
}

function getStationDockPosition(station, options = {}) {
  if (isStructureDockable(station)) {
    return structureLocatorGeometry.getStructureDockPosition(station, {
      shipTypeID: options.shipTypeID,
      selectionStrategy: options.selectionStrategy || "hash",
      selectionKey: options.selectionKey,
    });
  }

  if (station) {
    return stationLocatorGeometry.getStationDockPosition(station, {
      shipTypeID: options.shipTypeID,
      selectionStrategy: options.selectionStrategy || "hash",
      selectionKey: options.selectionKey,
    });
  }

  if (station && station.dockPosition) {
    return cloneVector(station.dockPosition, station.position);
  }

  return cloneVector(station && station.position);
}

function getStationApproachPosition(station, options = {}) {
  if (options.useDockPosition === true) {
    return getStationDockPosition(station, options);
  }

  return cloneVector(station && station.position);
}

function getStationDockDirection(station) {
  if (station && !isStructureDockable(station)) {
    return normalizeVector(
      stationLocatorGeometry.buildStationDockingGeometry(station, {
        selectionStrategy: "first",
      }).dockOrientation,
      DEFAULT_RIGHT,
    );
  }

  if (station && station.dockOrientation) {
    return normalizeVector(station.dockOrientation, DEFAULT_RIGHT);
  }

  return normalizeVector(
    station && station.undockDirection,
    DEFAULT_RIGHT,
  );
}

function getStationInteractionRadius(station) {
  const configuredVisualRadius = toFiniteNumber(station && station.radius, 0);
  if (configuredVisualRadius > 0) {
    return configuredVisualRadius;
  }

  const configuredRadius = toFiniteNumber(
    station && station.interactionRadius,
    0,
  );
  if (configuredRadius > 0) {
    return configuredRadius;
  }

  return DEFAULT_STATION_INTERACTION_RADIUS;
}

function getStationUndockSpawnState(station, options = {}) {
  if (isStructureDockable(station)) {
    return structureLocatorGeometry.buildStructureUndockSpawnState(station, {
      shipTypeID: options.shipTypeID,
      selectionStrategy: options.selectionStrategy || "random",
      selectionKey: options.selectionKey,
      extraUndockDistance: Math.max(
        0,
        toFiniteNumber(options.extraUndockDistance, 0),
      ),
      random: options.random,
    });
  }

  if (station) {
    return stationLocatorGeometry.buildStationUndockSpawnState(station, {
      shipTypeID: options.shipTypeID,
      selectionStrategy: options.selectionStrategy || "random",
      selectionKey: options.selectionKey,
      extraUndockDistance: Math.max(
        0,
        toFiniteNumber(options.extraUndockDistance, 0),
      ),
      random: options.random,
    });
  }

  const dockDirection = normalizeVector(
    cloneVector(
      station &&
        (station.dockOrientation || station.undockDirection),
      DEFAULT_RIGHT,
    ),
    DEFAULT_RIGHT,
  );
  const storedUndockOffset = station
    ? subtractVectors(
        cloneVector(station.undockPosition, station.position),
        cloneVector(station.position),
      )
    : null;
  const direction = normalizeVector(
    magnitude(storedUndockOffset) > 0
      ? storedUndockOffset
      : dockDirection,
    DEFAULT_RIGHT,
  );
  const spawnDistance = Math.max(
    DEFAULT_STATION_UNDOCK_DISTANCE,
    getStationConfiguredUndockDistance(station),
    getStationInteractionRadius(station) + 2500,
  );

  return {
    direction,
    position: addVectors(
      cloneVector(station && station.position),
      scaleVector(direction, spawnDistance),
    ),
  };
}

function isNearlySameDirection(left, right, minDot = DUPLICATE_DIRECTION_DOT) {
  return dotProduct(
    normalizeVector(left, DEFAULT_RIGHT),
    normalizeVector(right, DEFAULT_RIGHT),
  ) >= minDot;
}

function getShipDockingDistanceToStation(entity, station) {
  if (!entity || !station) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.max(
    0,
    distance(entity.position, station.position) -
      entity.radius -
      getStationInteractionRadius(station),
  );
}

function canShipDockAtStation(entity, station, maxDistance = DEFAULT_STATION_DOCKING_RADIUS) {
  return getShipDockingDistanceToStation(entity, station) <= Math.max(0, toFiniteNumber(maxDistance, DEFAULT_STATION_DOCKING_RADIUS));
}

function buildDockingDebugState(entity, station, maxDistance = DEFAULT_STATION_DOCKING_RADIUS) {
  if (!entity || !station) {
    return null;
  }

  const dockPosition = getStationDockPosition(station, {
    shipTypeID: entity.typeID,
    selectionKey: entity.itemID,
  });
  const approachPosition = getStationApproachPosition(station, {
    shipTypeID: entity.typeID,
    selectionKey: entity.itemID,
    useDockPosition: Number(entity.dockingTargetID || 0) === Number(station.itemID || 0),
  });

  return {
    canDock: canShipDockAtStation(entity, station, maxDistance),
    dockingDistance: roundNumber(
      getShipDockingDistanceToStation(entity, station),
    ),
    distanceToStationCenter: roundNumber(distance(entity.position, station.position)),
    distanceToDockPoint: roundNumber(distance(entity.position, dockPosition)),
    distanceToApproachPoint: roundNumber(distance(entity.position, approachPosition)),
    dockingThreshold: roundNumber(maxDistance),
    shipRadius: roundNumber(entity.radius),
    stationRadius: roundNumber(getStationInteractionRadius(station)),
    shipPosition: summarizeVector(entity.position),
    shipVelocity: summarizeVector(entity.velocity),
    stationPosition: summarizeVector(station.position),
    approachPosition: summarizeVector(approachPosition),
    dockPosition: summarizeVector(dockPosition),
    targetEntityID: entity.targetEntityID || 0,
    dockingTargetID: entity.dockingTargetID || 0,
    mode: entity.mode,
    speedFraction: roundNumber(entity.speedFraction, 3),
  };
}

function snapShipToStationPerimeter(entity, station) {
  const desiredDistance = Math.max(
    DEFAULT_STATION_UNDOCK_DISTANCE,
    getStationConfiguredUndockDistance(station),
    getStationInteractionRadius(station) + entity.radius + 500,
  );
  const approachDirection = normalizeVector(
    subtractVectors(entity.position, station.position),
    cloneVector(station.undockDirection, DEFAULT_RIGHT),
  );

  entity.position = addVectors(
    cloneVector(station.position),
    scaleVector(approachDirection, desiredDistance),
  );
  entity.targetPoint = cloneVector(station.position);
}

function getLegacyStationNormalizationTarget(entity) {
  if (!entity || entity.kind !== "ship") {
    return null;
  }

  if (
    entity.targetEntityID &&
    (entity.mode === "FOLLOW" || entity.mode === "GOTO")
  ) {
    const trackedStation = worldData.getStationByID(entity.targetEntityID);
    if (trackedStation && canShipDockAtStation(entity, trackedStation)) {
      return trackedStation;
    }
  }

  if (
    entity.mode !== "STOP" ||
    magnitude(entity.velocity) > 1
  ) {
    return null;
  }

  let closestStation = null;
  let closestDistance = Number.POSITIVE_INFINITY;
  for (const station of worldData.getStationsForSystem(entity.systemID)) {
    const stationDistance = getShipDockingDistanceToStation(entity, station);
    if (stationDistance < closestDistance) {
      closestDistance = stationDistance;
      closestStation = station;
    }
  }

  return closestDistance <= LEGACY_STATION_NORMALIZATION_RADIUS ? closestStation : null;
}

function normalizeLegacyStationState(entity) {
  if (
    !entity ||
    entity.kind !== "ship"
  ) {
    return false;
  }

  const station = getLegacyStationNormalizationTarget(entity);
  if (!station) {
    return false;
  }

  snapShipToStationPerimeter(entity, station);
  return true;
}

// A dock that failed at completion leaves the ship in space. The dock
// acceptance's Stop made it non-massive (scene/pilotCommands.js); it is an
// ordinary ship again, or no missile could hit it again.
function clearPendingDock(entity) {
  if (entity) {
    applyPendingDockStateCommand(entity, null);
    entity.isMassive = true;
    entity.massive = true;
  }
}

Object.assign(module.exports, {
  DEFAULT_STATION_DOCKING_RADIUS,
  DEFAULT_STATION_INTERACTION_RADIUS,
  DEFAULT_STATION_UNDOCK_DISTANCE,
  LEGACY_STATION_NORMALIZATION_RADIUS,
  STATION_DOCK_ACCEPT_DELAY_MS,
});
