"use strict";

function normalizePositiveInteger(value) {
  const numericValue = Number(value);
  return Number.isSafeInteger(numericValue) && numericValue > 0
    ? numericValue
    : 0;
}

function resolveDirectWorldTransportDestination(locationID, dependencies = {}) {
  const numericLocationID = normalizePositiveInteger(locationID);
  if (!numericLocationID) {
    return null;
  }

  const solarSystem =
    typeof dependencies.getSolarSystemByID === "function"
      ? dependencies.getSolarSystemByID(numericLocationID)
      : null;
  if (solarSystem) {
    return {
      kind: "solarSystem",
      solarSystemID: numericLocationID,
      label:
        solarSystem.solarSystemName ||
        `solar system ${numericLocationID}`,
    };
  }

  const station =
    typeof dependencies.getStationByID === "function"
      ? dependencies.getStationByID(numericLocationID)
      : null;
  if (station) {
    return {
      kind: "station",
      stationID: numericLocationID,
      label:
        station.stationName ||
        `station ${numericLocationID}`,
    };
  }

  const structure =
    typeof dependencies.getStructureByID === "function"
      ? dependencies.getStructureByID(numericLocationID)
      : null;
  if (structure) {
    const pointAnchor =
      typeof dependencies.buildPointAnchor === "function"
        ? dependencies.buildPointAnchor(
          structure,
          structure.solarSystemID,
        )
        : null;
    const label =
      (pointAnchor && pointAnchor.label) ||
      structure.itemName ||
      structure.name ||
      `structure ${numericLocationID}`;
    // A structure nobody docks at (a Sovereignty Hub, a FLEX structure) is a
    // place in space: docking a session there left the client with a
    // structureid and no ballpark (real client, WUZ-WM, 2026-11-07).
    if (structure.dockable === false && pointAnchor) {
      return { ...pointAnchor, label };
    }
    return {
      ...(pointAnchor || {}),
      kind: "structure",
      structureID: numericLocationID,
      label:
        (pointAnchor && pointAnchor.label) ||
        structure.itemName ||
        structure.name ||
        `structure ${numericLocationID}`,
    };
  }

  return null;
}

function resolveStoredTransportDestination(locationID, dependencies = {}) {
  const resolveWorldLocation =
    typeof dependencies.resolveWorldLocation === "function"
      ? dependencies.resolveWorldLocation
      : () => null;
  const findItemById =
    typeof dependencies.findItemById === "function"
      ? dependencies.findItemById
      : () => null;
  const resolveItemAnchor =
    typeof dependencies.resolveItemAnchor === "function"
      ? dependencies.resolveItemAnchor
      : () => null;

  const visitedItemIDs = new Set();
  let currentLocationID = normalizePositiveInteger(locationID);

  while (currentLocationID) {
    const worldDestination = resolveWorldLocation(currentLocationID);
    if (worldDestination) {
      return worldDestination;
    }

    if (visitedItemIDs.has(currentLocationID)) {
      return null;
    }
    visitedItemIDs.add(currentLocationID);

    const item = findItemById(currentLocationID);
    if (!item) {
      return null;
    }

    const itemAnchor = resolveItemAnchor(item);
    if (itemAnchor) {
      return itemAnchor;
    }

    currentLocationID = normalizePositiveInteger(item.locationID);
  }

  return null;
}

module.exports = {
  resolveDirectWorldTransportDestination,
  resolveStoredTransportDestination,
};
