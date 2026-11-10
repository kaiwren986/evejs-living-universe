"use strict";

const {
  ABYSSAL_LOCATION_ID_COUNT,
  ABYSSAL_LOCATION_ID_MIN,
  isAbyssalHostLocationID,
} = require("../domain/abyssalHostLocation");
const { buildAbyssalSceneKey } = require("../domain/abyssalSceneKey");

const ASTRONOMICAL_UNIT_METERS = 149_597_870_700;

// Supported run geometry is measured from the Room 1 origin. The widest
// current room profile puts Room 3 at 2 AU. Five million metres covers the
// 75 km gameplay boundary, the 250 km cleanup radius, the largest captured
// scenery offset (~1.68 Mm), NPC movement, probes/debug entities, and the
// existing relog recovery radius. Hidden destination prewarm uses the same
// three room origins and is therefore covered by this envelope too.
const MAX_ABYSSAL_ROOM_OFFSET_METERS = 2 * ASTRONOMICAL_UNIT_METERS;
const MAX_ABYSSAL_ROOM_LOCAL_EXTENT_METERS = 5_000_000;
const MAX_ABYSSAL_RUN_SPATIAL_EXTENT_METERS =
  MAX_ABYSSAL_ROOM_OFFSET_METERS + MAX_ABYSSAL_ROOM_LOCAL_EXTENT_METERS;

// Adjacent lattice origins are farther apart than two complete run envelopes.
// A further 1 Mm interaction/visibility guard and 150 Gm explicit margin keep
// the guarantee structural rather than dependent on current scene filtering.
const ABYSSAL_SLOT_INTERACTION_SAFETY_ENVELOPE_METERS = 1_000_000;
const ABYSSAL_SLOT_EXPLICIT_SAFETY_MARGIN_METERS = 150_000_000_000;
const ABYSSAL_SLOT_SEPARATION_METERS =
  (2 * MAX_ABYSSAL_RUN_SPATIAL_EXTENT_METERS) +
  ABYSSAL_SLOT_INTERACTION_SAFETY_ENVELOPE_METERS +
  ABYSSAL_SLOT_EXPLICIT_SAFETY_MARGIN_METERS;

// Destiny coordinates are JavaScript Numbers. Keeping each lattice component
// within +/-10,000 keeps every origin plus its complete run envelope below
// Number.MAX_SAFE_INTEGER while still providing over eight trillion slots per
// host. This is the real coordinate-space capacity, not a host-count ceiling.
const ABYSSAL_SLOT_MAX_LATTICE_RADIUS = 10_000;
const ABYSSAL_SLOT_LATTICE_SIDE_LENGTH =
  (2 * ABYSSAL_SLOT_MAX_LATTICE_RADIUS) + 1;
const ABYSSAL_SLOT_MAX_ID =
  (ABYSSAL_SLOT_LATTICE_SIDE_LENGTH ** 3) - 1;
const ABYSSAL_SLOT_MAX_ABSOLUTE_COORDINATE_METERS =
  ABYSSAL_SLOT_MAX_LATTICE_RADIUS * ABYSSAL_SLOT_SEPARATION_METERS;
const ABYSSAL_SPATIAL_RESERVATION_SCHEMA_VERSION = 1;

function toInteger(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function normalizeVector(value) {
  if (!value || typeof value !== "object") return null;
  const vector = {
    x: Number(value.x),
    y: Number(value.y),
    z: Number(value.z),
  };
  return Object.values(vector).every(Number.isFinite) ? vector : null;
}

function vectorsEqual(left, right) {
  const a = normalizeVector(left);
  const b = normalizeVector(right);
  return Boolean(a && b && a.x === b.x && a.y === b.y && a.z === b.z);
}

function buildHostSlotKey(hostSystemID, slotID) {
  return `${toInteger(hostSystemID, 0)}:${toInteger(slotID, -1)}`;
}

function resolveAbyssalSlotLatticeCoordinate(slotID) {
  const numericSlotID = toInteger(slotID, -1);
  if (numericSlotID < 0 || numericSlotID > ABYSSAL_SLOT_MAX_ID) {
    throw new RangeError("ABYSSAL_SPATIAL_SLOT_ID_OUT_OF_RANGE");
  }
  if (numericSlotID === 0) return { x: 0, y: 0, z: 0 };

  let radius = Math.max(
    1,
    Math.ceil((Math.cbrt(numericSlotID + 1) - 1) / 2),
  );
  while (((2 * radius) - 1) ** 3 > numericSlotID) radius -= 1;
  while (((2 * radius) + 1) ** 3 <= numericSlotID) radius += 1;

  let offset = numericSlotID - (((2 * radius) - 1) ** 3);
  const side = (2 * radius) + 1;
  const innerSide = side - 2;
  const faceArea = side * side;

  if (offset < faceArea) {
    return {
      x: -radius,
      y: -radius + Math.floor(offset / side),
      z: -radius + (offset % side),
    };
  }
  offset -= faceArea;
  if (offset < faceArea) {
    return {
      x: radius,
      y: -radius + Math.floor(offset / side),
      z: -radius + (offset % side),
    };
  }
  offset -= faceArea;

  const edgeFaceArea = innerSide * side;
  if (offset < edgeFaceArea) {
    return {
      x: (-radius + 1) + Math.floor(offset / side),
      y: -radius,
      z: -radius + (offset % side),
    };
  }
  offset -= edgeFaceArea;
  if (offset < edgeFaceArea) {
    return {
      x: (-radius + 1) + Math.floor(offset / side),
      y: radius,
      z: -radius + (offset % side),
    };
  }
  offset -= edgeFaceArea;

  const capArea = innerSide * innerSide;
  if (offset < capArea) {
    return {
      x: (-radius + 1) + Math.floor(offset / innerSide),
      y: (-radius + 1) + (offset % innerSide),
      z: -radius,
    };
  }
  offset -= capArea;
  return {
    x: (-radius + 1) + Math.floor(offset / innerSide),
    y: (-radius + 1) + (offset % innerSide),
    z: radius,
  };
}

function resolveAbyssalSpatialSlotOrigin(hostSystemID, slotID) {
  if (!isAbyssalHostLocationID(hostSystemID)) {
    throw new RangeError("ABYSSAL_SPATIAL_HOST_ID_INVALID");
  }
  const lattice = resolveAbyssalSlotLatticeCoordinate(slotID);
  return {
    x: lattice.x * ABYSSAL_SLOT_SEPARATION_METERS,
    y: lattice.y * ABYSSAL_SLOT_SEPARATION_METERS,
    z: lattice.z * ABYSSAL_SLOT_SEPARATION_METERS,
  };
}

function resolveAbyssalRunSpatialEnvelope(spatialOrigin) {
  const origin = normalizeVector(spatialOrigin);
  if (!origin) {
    throw new TypeError("ABYSSAL_SPATIAL_ORIGIN_INVALID");
  }
  return {
    origin,
    radiusMeters: MAX_ABYSSAL_RUN_SPATIAL_EXTENT_METERS,
  };
}

function distanceBetweenOrigins(left, right) {
  const a = normalizeVector(left);
  const b = normalizeVector(right);
  if (!a || !b) return Number.NaN;
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function doAbyssalRunSpatialEnvelopesOverlap(left, right) {
  const leftEnvelope = resolveAbyssalRunSpatialEnvelope(left);
  const rightEnvelope = resolveAbyssalRunSpatialEnvelope(right);
  return distanceBetweenOrigins(leftEnvelope.origin, rightEnvelope.origin) <=
    leftEnvelope.radiusMeters + rightEnvelope.radiusMeters;
}

function normalizeReservation(source = {}) {
  const runID = toInteger(source.runID || source.instanceID, 0);
  const hostSystemID = toInteger(
    source.hostSystemID || source.abyssalLocationID,
    0,
  );
  const slotID = toInteger(
    source.slotID === undefined ? source.abyssalSlotID : source.slotID,
    -1,
  );
  const spatialOrigin = normalizeVector(
    source.spatialOrigin || source.abyssalSpatialOrigin,
  );
  const sceneID = String(
    source.sceneID || source.sceneKey || buildAbyssalSceneKey(runID),
  ).trim();
  return {
    schemaVersion: ABYSSAL_SPATIAL_RESERVATION_SCHEMA_VERSION,
    runID,
    hostSystemID,
    slotID,
    spatialOrigin,
    sceneID,
    reservationState: "reserved",
    legacySpatialOriginPreserved:
      source.legacySpatialOriginPreserved === true,
  };
}

class AbyssalHostSlotAllocator {
  constructor() {
    this.reservationsByRunID = new Map();
    this.runIDByHostSlot = new Map();
    this.occupiedSlotsByHost = new Map();
    this.legacyBlockedHostSystemIDs = new Set();
  }

  getReservation(runID) {
    const reservation = this.reservationsByRunID.get(toInteger(runID, 0));
    return reservation ? structuredClone(reservation) : null;
  }

  listReservations() {
    return [...this.reservationsByRunID.values()].map((entry) =>
      structuredClone(entry)
    );
  }

  findLowestAvailableSlot(hostSystemID) {
    const numericHostSystemID = toInteger(hostSystemID, 0);
    if (this.legacyBlockedHostSystemIDs.has(numericHostSystemID)) return -1;
    const occupied = this.occupiedSlotsByHost.get(numericHostSystemID);
    if (!occupied || occupied.size === 0) return 0;
    let slotID = 0;
    while (occupied.has(slotID)) slotID += 1;
    return slotID <= ABYSSAL_SLOT_MAX_ID ? slotID : -1;
  }

  reserve(source = {}, options = {}) {
    const reservation = normalizeReservation(source);
    if (
      reservation.runID <= 0 ||
      !isAbyssalHostLocationID(reservation.hostSystemID) ||
      reservation.slotID < 0 ||
      reservation.slotID > ABYSSAL_SLOT_MAX_ID ||
      !reservation.spatialOrigin ||
      reservation.sceneID !== buildAbyssalSceneKey(reservation.runID)
    ) {
      return {
        success: false,
        errorMsg: "ABYSSAL_SPATIAL_RESERVATION_INVALID",
      };
    }

    const canonicalOrigin = resolveAbyssalSpatialSlotOrigin(
      reservation.hostSystemID,
      reservation.slotID,
    );
    if (
      !vectorsEqual(reservation.spatialOrigin, canonicalOrigin) &&
      !(options.allowLegacyOrigin === true && reservation.legacySpatialOriginPreserved)
    ) {
      return {
        success: false,
        errorMsg: "ABYSSAL_SPATIAL_RESERVATION_ORIGIN_MISMATCH",
      };
    }

    const existingForRun = this.reservationsByRunID.get(reservation.runID);
    if (existingForRun) {
      return vectorsEqual(existingForRun.spatialOrigin, reservation.spatialOrigin) &&
        existingForRun.hostSystemID === reservation.hostSystemID &&
        existingForRun.slotID === reservation.slotID &&
        existingForRun.sceneID === reservation.sceneID
        ? { success: true, idempotent: true, reservation: structuredClone(existingForRun) }
        : { success: false, errorMsg: "ABYSSAL_SPATIAL_RUN_RESERVATION_CONFLICT" };
    }

    const key = buildHostSlotKey(reservation.hostSystemID, reservation.slotID);
    const occupyingRunID = this.runIDByHostSlot.get(key);
    if (occupyingRunID && occupyingRunID !== reservation.runID) {
      return {
        success: false,
        errorMsg: "ABYSSAL_SPATIAL_RESERVATION_CONFLICT",
        occupyingRunID,
      };
    }
    if (
      this.legacyBlockedHostSystemIDs.has(reservation.hostSystemID) ||
      (
        reservation.legacySpatialOriginPreserved &&
        this.occupiedSlotsByHost.has(reservation.hostSystemID)
      )
    ) {
      return {
        success: false,
        errorMsg: "ABYSSAL_SPATIAL_LEGACY_HOST_RESERVED",
      };
    }

    this.reservationsByRunID.set(reservation.runID, reservation);
    this.runIDByHostSlot.set(key, reservation.runID);
    if (!this.occupiedSlotsByHost.has(reservation.hostSystemID)) {
      this.occupiedSlotsByHost.set(reservation.hostSystemID, new Set());
    }
    this.occupiedSlotsByHost.get(reservation.hostSystemID).add(reservation.slotID);
    if (reservation.legacySpatialOriginPreserved) {
      this.legacyBlockedHostSystemIDs.add(reservation.hostSystemID);
    }
    return { success: true, idempotent: false, reservation: structuredClone(reservation) };
  }

  allocate(runID, options = {}) {
    const numericRunID = toInteger(runID, 0);
    if (numericRunID <= 0) {
      return { success: false, errorMsg: "ABYSSAL_SPATIAL_RUN_ID_INVALID" };
    }
    const existing = this.getReservation(numericRunID);
    if (existing) return { success: true, idempotent: true, reservation: existing };

    const preferredHostSystemID = isAbyssalHostLocationID(
      options.preferredHostSystemID,
    )
      ? toInteger(options.preferredHostSystemID, 0)
      : ABYSSAL_LOCATION_ID_MIN + ((numericRunID - 1) % ABYSSAL_LOCATION_ID_COUNT);
    const preferredIndex = preferredHostSystemID - ABYSSAL_LOCATION_ID_MIN;
    let selected = null;
    for (let offset = 0; offset < ABYSSAL_LOCATION_ID_COUNT; offset += 1) {
      const hostSystemID = ABYSSAL_LOCATION_ID_MIN +
        ((preferredIndex + offset) % ABYSSAL_LOCATION_ID_COUNT);
      const slotID = this.findLowestAvailableSlot(hostSystemID);
      if (slotID < 0) continue;
      if (!selected || slotID < selected.slotID) {
        selected = { hostSystemID, slotID };
        if (slotID === 0) break;
      }
    }
    if (!selected) {
      return { success: false, errorMsg: "ABYSSAL_SPATIAL_SLOT_CAPACITY_EXHAUSTED" };
    }

    return this.reserve({
      runID: numericRunID,
      hostSystemID: selected.hostSystemID,
      slotID: selected.slotID,
      spatialOrigin: resolveAbyssalSpatialSlotOrigin(
        selected.hostSystemID,
        selected.slotID,
      ),
      sceneID: buildAbyssalSceneKey(numericRunID),
    });
  }

  release(runID, options = {}) {
    const numericRunID = toInteger(runID, 0);
    const reservation = this.reservationsByRunID.get(numericRunID);
    if (!reservation) {
      return { success: true, alreadyReleased: true, reservation: null };
    }
    if (
      (
        options.hostSystemID !== undefined &&
        toInteger(options.hostSystemID, 0) !== reservation.hostSystemID
      ) ||
      (
        options.slotID !== undefined &&
        toInteger(options.slotID, -1) !== reservation.slotID
      )
    ) {
      return { success: false, errorMsg: "ABYSSAL_SPATIAL_RELEASE_OWNERSHIP_MISMATCH" };
    }
    const key = buildHostSlotKey(reservation.hostSystemID, reservation.slotID);
    if (this.runIDByHostSlot.get(key) !== numericRunID) {
      return { success: false, errorMsg: "ABYSSAL_SPATIAL_RELEASE_OWNERSHIP_MISMATCH" };
    }
    this.reservationsByRunID.delete(numericRunID);
    this.runIDByHostSlot.delete(key);
    const occupied = this.occupiedSlotsByHost.get(reservation.hostSystemID);
    if (occupied) {
      occupied.delete(reservation.slotID);
      if (occupied.size === 0) this.occupiedSlotsByHost.delete(reservation.hostSystemID);
    }
    if (reservation.legacySpatialOriginPreserved) {
      this.legacyBlockedHostSystemIDs.delete(reservation.hostSystemID);
    }
    return { success: true, alreadyReleased: false, reservation: structuredClone(reservation) };
  }

  reset() {
    this.reservationsByRunID.clear();
    this.runIDByHostSlot.clear();
    this.occupiedSlotsByHost.clear();
    this.legacyBlockedHostSystemIDs.clear();
  }
}

module.exports = {
  ABYSSAL_SPATIAL_RESERVATION_SCHEMA_VERSION,
  ABYSSAL_SLOT_EXPLICIT_SAFETY_MARGIN_METERS,
  ABYSSAL_SLOT_INTERACTION_SAFETY_ENVELOPE_METERS,
  ABYSSAL_SLOT_MAX_ABSOLUTE_COORDINATE_METERS,
  ABYSSAL_SLOT_MAX_ID,
  ABYSSAL_SLOT_MAX_LATTICE_RADIUS,
  ABYSSAL_SLOT_SEPARATION_METERS,
  ASTRONOMICAL_UNIT_METERS,
  MAX_ABYSSAL_ROOM_LOCAL_EXTENT_METERS,
  MAX_ABYSSAL_ROOM_OFFSET_METERS,
  MAX_ABYSSAL_RUN_SPATIAL_EXTENT_METERS,
  AbyssalHostSlotAllocator,
  distanceBetweenOrigins,
  doAbyssalRunSpatialEnvelopesOverlap,
  resolveAbyssalRunSpatialEnvelope,
  resolveAbyssalSlotLatticeCoordinate,
  resolveAbyssalSpatialSlotOrigin,
};
