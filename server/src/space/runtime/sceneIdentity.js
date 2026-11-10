"use strict";

module.exports = {
  allocateAbyssalLocationID,
  buildAbyssalSceneKey,
  buildSolarSystemSceneKey,
  decorateEntitySceneOwnership,
  getAbyssalRuntimeSceneAuthority,
  getAbyssalSessionSceneAuthority,
  getSceneKeyForSession,
  normalizeSceneDescriptor,
  normalizeSceneText,
};

const {
  ABYSSAL_LOCATION_ID_MIN,
  ABYSSAL_LOCATION_ID_COUNT,
  isAbyssalHostLocationID,
} = require("../../abyssal").engineSupport.hostLocation;
const {
  resolveAbyssalSceneAuthority,
} = require("../../abyssal").engineSupport.sceneKey;
const {
  toInt,
} = require("../../common/numbers");

const SCENE_KIND_SOLAR_SYSTEM = "solarSystem";

const SCENE_KIND_ABYSSAL = "abyssal";

function getAbyssalSessionSceneAuthority(session) {
  return resolveAbyssalSceneAuthority({
    sceneKind: session && session._space && session._space.sceneKind,
    sceneKey:
      session && session._space && session._space.sceneKey ||
      session && session.spaceSceneKey ||
      "",
    // Order matters and so does "first defined" - an explicit 0 on _space wins
    // over spaceInstanceID rather than falling through to it.
    instanceIDCandidates: [
      session && session._space && session._space.instanceID,
      session && session.spaceInstanceID,
    ],
  });
}

function getAbyssalRuntimeSceneAuthority(scene) {
  return resolveAbyssalSceneAuthority({
    sceneKind: scene && scene.sceneKind,
    sceneKey: scene && scene.sceneKey,
    instanceIDCandidates: [scene && scene.instanceID],
  });
}

function buildSolarSystemSceneKey(solarSystemID) {
  const numericSystemID = toInt(solarSystemID, 0);
  return numericSystemID > 0 ? `solar-system:${numericSystemID}` : "";
}

function buildAbyssalSceneKey(instanceID) {
  const numericInstanceID = toInt(instanceID, 0);
  return numericInstanceID > 0 ? `abyssal-run:${numericInstanceID}` : "";
}

function allocateAbyssalLocationID(instanceID) {
  const numericInstanceID = Math.max(0, toInt(instanceID, 0));
  const slot = numericInstanceID > 0
    ? ((numericInstanceID - 1) % ABYSSAL_LOCATION_ID_COUNT)
    : 0;
  return ABYSSAL_LOCATION_ID_MIN + slot;
}

function normalizeSceneText(value, fallback = "") {
  const normalized = String(value === undefined || value === null ? "" : value).trim();
  return normalized || String(fallback === undefined || fallback === null ? "" : fallback).trim();
}

function normalizeSceneDescriptor(input, options = {}) {
  const source =
    input && typeof input === "object"
      ? input
      : {
          solarSystemID: input,
        };
  const sceneKind = source.sceneKind === SCENE_KIND_ABYSSAL
    ? SCENE_KIND_ABYSSAL
    : SCENE_KIND_SOLAR_SYSTEM;
  if (sceneKind === SCENE_KIND_ABYSSAL) {
    const instanceID = toInt(source.instanceID || source.runID, 0);
    const canonicalSceneKey = buildAbyssalSceneKey(instanceID);
    const explicitSceneKey = normalizeSceneText(source.sceneKey, "");
    const sceneKey = explicitSceneKey || canonicalSceneKey;
    // A scene key is an authority boundary, not a caller-selected alias. If a
    // descriptor claims one run ID while naming another run's key, accepting
    // it would allow exact-scene operations to route into the wrong pocket.
    if (explicitSceneKey && explicitSceneKey !== canonicalSceneKey) {
      return null;
    }
    if (!instanceID || !sceneKey) {
      return null;
    }
    const locationID = toInt(
      source.locationID || source.abyssalLocationID,
      allocateAbyssalLocationID(instanceID),
    );
    const sourceSolarSystemID = toInt(
      source.sourceSolarSystemID,
      toInt(source.solarSystemID, 0),
    );
    return {
      sceneKey,
      sceneKind,
      locationID,
      solarSystemID: locationID,
      instanceID,
      sourceSolarSystemID,
      hydrateStaticEntities: false,
    };
  }

  const solarSystemID = toInt(
    source.solarSystemID || source.systemID || source.locationID,
    0,
  );
  if (!solarSystemID) {
    return null;
  }
  const canonicalSceneKey = buildSolarSystemSceneKey(solarSystemID);
  const explicitSceneKey = normalizeSceneText(source.sceneKey, "");
  if (explicitSceneKey && explicitSceneKey !== canonicalSceneKey) {
    return null;
  }
  return {
    sceneKey: explicitSceneKey || canonicalSceneKey,
    sceneKind,
    locationID: toInt(source.locationID, solarSystemID),
    solarSystemID,
    instanceID: 0,
    sourceSolarSystemID: 0,
    hydrateStaticEntities: options.hydrateStaticEntities !== false,
  };
}

function getSceneKeyForSession(session) {
  if (!session || !session._space) {
    return "";
  }
  const explicitSceneKey = normalizeSceneText(
    session._space.sceneKey || session.spaceSceneKey,
    "",
  );
  if (explicitSceneKey) {
    return explicitSceneKey;
  }
  return buildSolarSystemSceneKey(session._space.systemID);
}

function decorateEntitySceneOwnership(entity, descriptor) {
  if (!entity || !descriptor) {
    return entity;
  }
  entity.sceneKey = descriptor.sceneKey;
  entity.sceneKind = descriptor.sceneKind;
  if (descriptor.instanceID > 0) {
    entity.instanceScope = SCENE_KIND_ABYSSAL;
    entity.abyssalRunID = descriptor.instanceID;
  } else {
    if (entity.instanceScope === SCENE_KIND_ABYSSAL) {
      delete entity.instanceScope;
    }
    if (entity.abyssalRunID !== undefined) {
      delete entity.abyssalRunID;
    }
  }
  return entity;
}

Object.assign(module.exports, {
  SCENE_KIND_ABYSSAL,
  SCENE_KIND_SOLAR_SYSTEM,
});
