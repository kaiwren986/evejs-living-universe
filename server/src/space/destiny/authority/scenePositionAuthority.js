"use strict";

const {
  setBallPosition,
  setBallVelocity,
} = require("../simulation/evolve");

function toFiniteNumber(value, fallback = Number.NaN) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeEntityID(entityOrID) {
  const raw = entityOrID && typeof entityOrID === "object"
    ? entityOrID.itemID
    : entityOrID;
  if (typeof raw === "bigint") {
    return raw > 0n ? raw.toString() : null;
  }
  const numeric = Number(raw);
  return Number.isSafeInteger(numeric) && numeric > 0
    ? String(numeric)
    : null;
}

function readFiniteVector(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const x = toFiniteNumber(value.x);
  const y = toFiniteNumber(value.y);
  const z = toFiniteNumber(value.z);
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)
    ? { x, y, z }
    : null;
}

function readVelocity(value) {
  return readFiniteVector(value) || { x: 0, y: 0, z: 0 };
}

function freezeVector(value) {
  return Object.freeze({ x: value.x, y: value.y, z: value.z });
}

function buildUnavailable(reason, entityID = null) {
  return Object.freeze({
    available: false,
    reason,
    entityID,
  });
}

function createScenePositionAuthority(options = {}) {
  const records = new Map();
  const getEntityByID = typeof options.getEntityByID === "function"
    ? options.getEntityByID
    : () => null;
  const getCurrentSimTimeMs = typeof options.getCurrentSimTimeMs === "function"
    ? options.getCurrentSimTimeMs
    : () => 0;

  function resolveObservedAtSimTimeMs(context = {}) {
    const explicit = toFiniteNumber(context.atSimTimeMs);
    return Math.max(
      0,
      Number.isFinite(explicit)
        ? explicit
        : toFiniteNumber(getCurrentSimTimeMs(), 0),
    );
  }

  function resolveEntity(entityOrID) {
    if (entityOrID && typeof entityOrID === "object") {
      return entityOrID;
    }
    const entityID = normalizeEntityID(entityOrID);
    if (!entityID) {
      return null;
    }
    const tracked = records.get(entityID);
    return tracked && tracked.entity
      ? tracked.entity
      : getEntityByID(entityOrID);
  }

  // Registers or reads a Ball: whether it has a finite position, and when
  // it was last read. Every read is the Ball's current slot; nothing
  // here versions a position.
  function observeEntity(entityOrID, context = {}) {
    const entity = resolveEntity(entityOrID);
    const entityID = normalizeEntityID(entity || entityOrID);
    if (!entity || !entityID) {
      return buildUnavailable("entity-not-found", entityID);
    }
    const position = readFiniteVector(entity.position);
    if (!position) {
      return buildUnavailable("invalid-position", entityID);
    }
    const observedAtSimTimeMs = resolveObservedAtSimTimeMs(context);
    let record = records.get(entityID);
    if (!record) {
      record = {
        entity,
        observedAtSimTimeMs,
        reason: String(context.reason || "register"),
      };
      records.set(entityID, record);
    } else {
      record.entity = entity;
      record.reason = String(context.reason || record.reason);
      record.observedAtSimTimeMs = Math.max(
        record.observedAtSimTimeMs,
        observedAtSimTimeMs,
      );
    }
    return Object.freeze({
      available: true,
      entityID,
      observedAtSimTimeMs: record.observedAtSimTimeMs,
      reason: record.reason,
    });
  }

  function readEntity(entityOrID, context = {}) {
    const entity = resolveEntity(entityOrID);
    const observation = observeEntity(entity || entityOrID, context);
    if (!observation.available) {
      return observation;
    }
    const position = readFiniteVector(entity.position);
    if (!position) {
      return buildUnavailable("invalid-position", observation.entityID);
    }
    const velocity = readVelocity(entity.velocity);
    return Object.freeze({
      ...observation,
      position: freezeVector(position),
      velocity: freezeVector(velocity),
      radius: Math.max(0, toFiniteNumber(entity.radius, 0)),
      mode: String(entity.mode || ""),
    });
  }

  function readPair(sourceEntityOrID, targetEntityOrID, context = {}) {
    const atSimTimeMs = resolveObservedAtSimTimeMs(context);
    const sharedContext = { ...context, atSimTimeMs };
    const source = readEntity(sourceEntityOrID, sharedContext);
    const target = readEntity(targetEntityOrID, sharedContext);
    if (!source.available || !target.available) {
      return Object.freeze({
        available: false,
        reason: !source.available ? source.reason : target.reason,
        atSimTimeMs,
        source,
        target,
      });
    }
    return Object.freeze({
      available: true,
      atSimTimeMs,
      source,
      target,
    });
  }

  function readMany(entities, context = {}) {
    const atSimTimeMs = resolveObservedAtSimTimeMs(context);
    const snapshots = [];
    const availableEntities = [];
    const unavailable = [];
    for (const entity of Array.isArray(entities) ? entities : []) {
      const snapshot = readEntity(entity, { ...context, atSimTimeMs });
      if (snapshot.available) {
        snapshots.push(snapshot);
        availableEntities.push(entity);
      } else {
        unavailable.push(snapshot);
      }
    }
    return Object.freeze({
      available: unavailable.length === 0,
      atSimTimeMs,
      entities: Object.freeze(availableEntities),
      snapshots: Object.freeze(snapshots),
      unavailable: Object.freeze(unavailable),
    });
  }

  function getSurfaceState(sourceEntityOrID, targetEntityOrID, context = {}) {
    const pair = readPair(sourceEntityOrID, targetEntityOrID, context);
    if (!pair.available) {
      return Object.freeze({
        ...pair,
        centerDistance: Infinity,
        surfaceDistance: Infinity,
      });
    }
    const dx = pair.target.position.x - pair.source.position.x;
    const dy = pair.target.position.y - pair.source.position.y;
    const dz = pair.target.position.z - pair.source.position.z;
    const centerDistance = Math.sqrt((dx * dx) + (dy * dy) + (dz * dz));
    return Object.freeze({
      ...pair,
      centerDistance,
      surfaceDistance: Math.max(
        0,
        centerDistance - pair.source.radius - pair.target.radius,
      ),
    });
  }

  function setEntityPosition(entityOrID, nextPosition, context = {}) {
    const entity = resolveEntity(entityOrID);
    const entityID = normalizeEntityID(entity || entityOrID);
    const position = readFiniteVector(nextPosition);
    const hasVelocity = Object.prototype.hasOwnProperty.call(context, "velocity");
    const velocity = hasVelocity ? readFiniteVector(context.velocity) : null;
    if (!entity || !entityID) {
      return buildUnavailable("entity-not-found", entityID);
    }
    if (!position) {
      return buildUnavailable("invalid-position", entityID);
    }
    if (hasVelocity && !velocity) {
      return buildUnavailable("invalid-velocity", entityID);
    }
    // SetBallPosition and SetBallVelocity write both slots.
    setBallPosition(entity, position);
    if (hasVelocity) {
      setBallVelocity(entity, velocity);
    }
    return observeEntity(entity, {
      ...context,
      reason: context.reason || "position-write",
    });
  }

  function unregisterEntity(entityOrID) {
    const entityID = normalizeEntityID(entityOrID);
    return entityID ? records.delete(entityID) : false;
  }

  return Object.freeze({
    commitEntity: observeEntity,
    getSurfaceState,
    readEntity,
    readMany,
    readPair,
    registerEntity: observeEntity,
    setEntityPosition,
    unregisterEntity,
  });
}

module.exports = {
  createScenePositionAuthority,
  readFiniteVector,
};
