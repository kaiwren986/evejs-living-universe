"use strict";

const path = require("path");

const {
  INVALID_ENTITY_SCOPE_IDENTITY,
  buildChildEntityScopeMetadata,
  resolveEntityInteractionScope,
} = require(path.join(
  __dirname,
  "../../space/destiny/identity/interactionScope.js",
));
const {
  entityIDsEqual,
  normalizePersistentEntityID,
  toJSONSafeEntityID,
} = require(path.join(
  __dirname,
  "../../space/destiny/identity/entityID.js",
));

const ABYSSAL_RUN_ID_FIELDS = Object.freeze([
  "abyssalRunID",
  "evejsAbyssalInstanceID",
  "evejsAbyssalPocketInstanceID",
]);
const ABYSSAL_ROOM_INDEX_FIELDS = Object.freeze([
  "abyssalRoomIndex",
  "evejsAbyssalRoomIndex",
]);

function toPositiveInt(value) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0
    ? numeric
    : null;
}

function sourceClaimsAbyssalScene(source) {
  if (!source || typeof source !== "object") {
    return false;
  }
  return Boolean(
    String(source.sceneKind || "").trim().toLowerCase() === "abyssal" ||
    String(source.instanceScope || "").trim().toLowerCase() === "abyssal" ||
    String(source.sceneKey || "").trim().toLowerCase().startsWith("abyssal")
  );
}

function sessionClaimsAbyssalScene(session) {
  return Boolean(
    toPositiveInt(session && session.abyssalInstanceID) ||
    ABYSSAL_RUN_ID_FIELDS.some(
      (key) => toPositiveInt(session && session[key]),
    ) ||
    sourceClaimsAbyssalScene(session && session._space) ||
    sourceClaimsAbyssalScene(
      session && session._space && session._space.sceneDescriptor,
    ) ||
    sourceClaimsAbyssalScene(session && {
      sceneKey: session.spaceSceneKey,
      sceneKind: session.spaceSceneKind,
      instanceID: session.spaceInstanceID,
    })
  );
}

function getCharacterID(session, controllerEntity) {
  return toPositiveInt(
    session && (session.characterID ?? session.charID ?? session.charid),
  ) || toPositiveInt(
    controllerEntity && (
      controllerEntity.characterID ??
      controllerEntity.pilotCharacterID ??
      controllerEntity.ownerID
    ),
  );
}

function getControllerID(session, controllerEntity) {
  return toPositiveInt(controllerEntity && controllerEntity.itemID) ||
    toPositiveInt(
      session && session._space && session._space.shipID,
    ) ||
    toPositiveInt(
      session && (
        session.shipID ??
        session.shipid ??
        session.activeShipID ??
        session.activeShipId
      ),
    );
}

function inspectAbyssalSceneIdentity(source, addRunCandidate, errors, label) {
  if (!source || typeof source !== "object") {
    return false;
  }
  const sceneKey = String(source.sceneKey || "").trim();
  const claimsAbyss = sourceClaimsAbyssalScene(source);
  if (!claimsAbyss) {
    return false;
  }

  if (sceneKey) {
    const match = /^abyssal-run:([1-9]\d*)$/.exec(sceneKey);
    if (!match) {
      errors.push(`${label}.sceneKey`);
    } else {
      addRunCandidate(`${label}.sceneKey`, match[1]);
    }
  }
  let explicitIdentityPresent = false;
  for (const key of ["instanceID", "runID"]) {
    if (
      Object.hasOwn(source, key) &&
      source[key] !== null &&
      source[key] !== undefined
    ) {
      explicitIdentityPresent = true;
      addRunCandidate(`${label}.${key}`, source[key]);
    }
  }
  if (!sceneKey && !explicitIdentityPresent) {
    errors.push(`${label}.instanceID`);
  }
  return true;
}

function getProductionPocketCandidates(session, controllerEntity) {
  const service = require("../../abyssal").scenePolicy;
  const candidates = [];
  const add = (candidate) => {
    if (!candidate) {
      return;
    }
    candidates.push(candidate);
  };

  if (
    session &&
    typeof service.getActivePocketStateForSession === "function"
  ) {
    add(service.getActivePocketStateForSession(session));
  }
  const controllerID = getControllerID(session, controllerEntity);
  if (
    controllerID &&
    typeof service.getActiveAbyssalRunForShipID === "function"
  ) {
    add(service.getActiveAbyssalRunForShipID(controllerID));
  }
  const characterID = getCharacterID(session, controllerEntity);
  if (
    characterID &&
    typeof service.getActiveAbyssalRunForCharacterID === "function"
  ) {
    add(service.getActiveAbyssalRunForCharacterID(characterID));
  }
  return candidates;
}

function resolveAbyssalPlayerLaunchScope(
  session,
  controllerEntity,
  scene = null,
  options = {},
) {
  const baseMetadata = buildChildEntityScopeMetadata(controllerEntity);
  const errors = [];
  let runID = null;
  let roomIndex = null;
  let abyssalSignalPresent = false;

  const addRunCandidate = (label, rawValue) => {
    abyssalSignalPresent = true;
    const candidate = normalizePersistentEntityID(rawValue);
    if (
      candidate === null ||
      (runID !== null && !entityIDsEqual(runID, candidate))
    ) {
      errors.push(label);
      return;
    }
    runID = candidate;
  };
  const addRoomCandidate = (label, rawValue) => {
    abyssalSignalPresent = true;
    const candidate = toPositiveInt(rawValue);
    if (
      candidate === null ||
      (roomIndex !== null && roomIndex !== candidate)
    ) {
      errors.push(label);
      return;
    }
    roomIndex = candidate;
  };

  for (const [label, source] of [
    ["controller", controllerEntity],
    ["session", session],
  ]) {
    const runIDFields = label === "session"
      ? [...ABYSSAL_RUN_ID_FIELDS, "abyssalInstanceID"]
      : ABYSSAL_RUN_ID_FIELDS;
    for (const key of runIDFields) {
      if (
        source &&
        Object.hasOwn(source, key) &&
        source[key] !== null &&
        source[key] !== undefined
      ) {
        addRunCandidate(`${label}.${key}`, source[key]);
      }
    }
    for (const key of ABYSSAL_ROOM_INDEX_FIELDS) {
      if (
        source &&
        Object.hasOwn(source, key) &&
        source[key] !== null &&
        source[key] !== undefined
      ) {
        addRoomCandidate(`${label}.${key}`, source[key]);
      }
    }
  }

  inspectAbyssalSceneIdentity(
    controllerEntity,
    addRunCandidate,
    errors,
    "controller",
  );
  inspectAbyssalSceneIdentity(scene, addRunCandidate, errors, "scene");
  inspectAbyssalSceneIdentity(
    scene && scene.sceneDescriptor,
    addRunCandidate,
    errors,
    "scene.sceneDescriptor",
  );
  inspectAbyssalSceneIdentity(
    session && session._space,
    addRunCandidate,
    errors,
    "session._space",
  );
  inspectAbyssalSceneIdentity(
    session && session._space && session._space.sceneDescriptor,
    addRunCandidate,
    errors,
    "session._space.sceneDescriptor",
  );
  inspectAbyssalSceneIdentity(
    session && {
      sceneKey: session.spaceSceneKey,
      sceneKind: session.spaceSceneKind,
      instanceID: session.spaceInstanceID,
    },
    addRunCandidate,
    errors,
    "session",
  );

  const controllerScope = resolveEntityInteractionScope(controllerEntity);
  if (controllerScope.scoped && controllerScope.valid !== true) {
    errors.push("controller.scope");
  }
  if (controllerScope.hasAbyssalScope) {
    abyssalSignalPresent = true;
    addRunCandidate(
      "controller.interactionScope",
      controllerScope.abyssalInstanceID,
    );
  }

  let pocketCandidates = [];
  const hasInjectedPocketCandidates = Object.hasOwn(
    options,
    "pocketCandidates",
  );
  if (hasInjectedPocketCandidates) {
    pocketCandidates = Array.isArray(options.pocketCandidates)
      ? options.pocketCandidates
      : options.pocketCandidates
        ? [options.pocketCandidates]
        : [];
  } else if (Object.hasOwn(options, "activePocketState")) {
    pocketCandidates = options.activePocketState
      ? [options.activePocketState]
      : [];
  } else {
    try {
      pocketCandidates = getProductionPocketCandidates(
        session,
        controllerEntity,
      );
    } catch (_) {
      errors.push("activePocket.lookup");
    }
  }

  const expectedControllerID = getControllerID(session, controllerEntity);
  const expectedCharacterID = getCharacterID(session, controllerEntity);
  for (const pocketState of pocketCandidates) {
    if (!pocketState || typeof pocketState !== "object") {
      continue;
    }
    abyssalSignalPresent = true;
    addRunCandidate("activePocket.instanceID", pocketState.instanceID);
    addRoomCandidate(
      "activePocket.roomState.currentRoomIndex",
      pocketState.roomState && pocketState.roomState.currentRoomIndex,
    );

    const pocketShipID = toPositiveInt(pocketState.shipID);
    if (
      pocketShipID &&
      expectedControllerID &&
      pocketShipID !== expectedControllerID
    ) {
      errors.push("activePocket.shipID");
    }
    const pocketCharacterID = toPositiveInt(pocketState.characterID);
    if (
      pocketCharacterID &&
      expectedCharacterID &&
      pocketCharacterID !== expectedCharacterID
    ) {
      errors.push("activePocket.characterID");
    }
    const implementedRooms = toPositiveInt(
      pocketState.roomState && pocketState.roomState.implementedRooms,
    );
    if (
      implementedRooms &&
      roomIndex !== null &&
      roomIndex > implementedRooms
    ) {
      errors.push("activePocket.roomState.implementedRooms");
    }
  }

  if (abyssalSignalPresent) {
    if (!controllerEntity || typeof controllerEntity !== "object") {
      errors.push("controller");
    }
    if (!scene || typeof scene !== "object") {
      errors.push("scene");
    }
  }

  if (!abyssalSignalPresent) {
    return {
      scoped: false,
      valid: true,
      errorMsg: null,
      runID: null,
      roomIndex: null,
      metadata: baseMetadata,
    };
  }
  if (runID === null) {
    errors.push("abyssalRunID");
  }
  if (roomIndex === null) {
    errors.push("abyssalRoomIndex");
  }

  if (errors.length > 0) {
    return {
      scoped: true,
      valid: false,
      errorMsg: "ABYSSAL_LAUNCH_SCOPE_INVALID",
      errors: [...new Set(errors)],
      runID: null,
      roomIndex: null,
      metadata: {
        ...baseMetadata,
        abyssalRunID: INVALID_ENTITY_SCOPE_IDENTITY,
        evejsAbyssalInstanceID: INVALID_ENTITY_SCOPE_IDENTITY,
        evejsAbyssalPocketInstanceID: INVALID_ENTITY_SCOPE_IDENTITY,
        abyssalRoomIndex: INVALID_ENTITY_SCOPE_IDENTITY,
        evejsAbyssalRoomIndex: INVALID_ENTITY_SCOPE_IDENTITY,
        dungeonSiteInstanceID: INVALID_ENTITY_SCOPE_IDENTITY,
      },
    };
  }

  const normalizedRunID = toJSONSafeEntityID(runID);
  return {
    scoped: true,
    valid: true,
    errorMsg: null,
    runID: normalizedRunID,
    roomIndex,
    metadata: {
      ...baseMetadata,
      abyssalRunID: normalizedRunID,
      evejsAbyssalInstanceID: normalizedRunID,
      evejsAbyssalPocketInstanceID: normalizedRunID,
      abyssalRoomIndex: roomIndex,
      evejsAbyssalRoomIndex: roomIndex,
      dungeonSiteInstanceID: normalizedRunID,
    },
  };
}

module.exports = {
  ABYSSAL_ROOM_INDEX_FIELDS,
  ABYSSAL_RUN_ID_FIELDS,
  resolveAbyssalPlayerLaunchScope,
  sessionClaimsAbyssalScene,
  _testing: {
    inspectAbyssalSceneIdentity,
  },
};
