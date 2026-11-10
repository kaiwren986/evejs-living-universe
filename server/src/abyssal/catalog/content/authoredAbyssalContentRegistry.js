"use strict";

const {
  ABYSSAL_CONTENT_AUTHORITY,
} = require("../abyssalContentAuthority");

const generatedCatalogue = require("./retailAuthoredContent.generated.json");

const CONTENT_KIND = "evejs-abyssal-authored-content";
const SUPPORTED_SCHEMA_VERSION = 1;
const CONTROLLER_DEPENDANT_MECHANIC_ID = "controller_dependant_lifecycle";
const VALID_WEATHER_TYPES = new Set([
  "dark",
  "electrical",
  "exotic",
  "firestorm",
  "gamma",
]);

const ALLOWED_FIELDS = Object.freeze({
  catalogue: new Set([
    "schemaVersion",
    "contentKind",
    "generatedBy",
    "expectedCounts",
    "captures",
  ]),
  generatedBy: new Set([
    "importerVersion",
    "sourceArchiveName",
    "sourceArchiveSha256",
    "sourceAuthorityKind",
    "sourceSchemaVersion",
    "sourceToolVersion",
    "activeGenerationID",
    "authorityFingerprint",
    "clientBuild",
    "clientVersion",
    "generatorSchemaVersion",
  ]),
  expectedCounts: new Set(["captures", "rooms"]),
  capture: new Set([
    "captureID",
    "captureKey",
    "runDefinitionID",
    "aliases",
    "filamentTypeID",
    "tier",
    "weatherType",
    "weatherName",
    "weatherBallTypeID",
    "weatherEffectTypeID",
    "environmentTemplateID",
    "layoutVariant",
    "selectionWeight",
    "selectionWeightAuthority",
    "rooms",
    "dependencies",
    "provenance",
    "existingRegistration",
  ]),
  dependencies: new Set(["npcTypeIDs", "mechanicIDs"]),
  captureProvenance: new Set([
    "captureID",
    "sourceRunOrLogID",
    "evidenceRef",
    "sourceContentUUID",
    "sourceContentHash",
    "sourceArtifacts",
    "sourceLineRange",
    "directlyObserved",
    "evidenceClassification",
    "confidence",
    "sourceSchemaVersion",
    "generatorSchemaVersion",
    "generationID",
  ]),
  sourceArtifact: new Set([
    "fileName",
    "sha256",
    "relation",
    "clientBuild",
    "clientVersion",
  ]),
  existingRegistration: new Set([
    "reused",
    "existingProfileID",
    "comparison",
  ]),
  room: new Set([
    "roomID",
    "roomNumber",
    "roomName",
    "geometry",
    "playerSpawnEntityID",
    "mainCacheEntityID",
    "transferConduitEntityID",
    "originConduitEntityID",
    "environmentObjectEntityIDs",
    "extractionNodeEntityIDs",
    "extractionSubNodeEntityIDs",
    "npcGroups",
    "objective",
    "environment",
    "observedLootOutcomes",
    "entities",
    "provenance",
  ]),
  geometry: new Set([
    "dungeonID",
    "sourceRoomID",
    "locationID",
    "layoutID",
    "layoutFingerprint",
    "sourceOrigin",
    "boundary",
  ]),
  boundary: new Set(["profileID", "radiusMeters"]),
  environment: new Set([
    "layoutRef",
    "localizedOverlayRef",
    "weatherOverlayRef",
    "presentationVariantID",
    "sceneNebulaGraphicID",
    "sceneNebulaTypeID",
    "lensFlareTypeID",
    "weatherBallTypeID",
    "weatherEffectTypeID",
    "volumetricCloudEntityID",
  ]),
  npcGroup: new Set(["groupID", "npcTypeID", "memberEntityIDs"]),
  objective: new Set([
    "rule",
    "blockerEntityIDs",
    "nonBlockingEntityIDs",
    "blockerMembershipProvenance",
    "classificationMethod",
    "conduitUnlockTiming",
    "cacheIndependent",
    "controllerGroups",
  ]),
  controllerGroup: new Set([
    "relationshipID",
    "controllerEntityID",
    "dependantEntityIDs",
    "lossBehavior",
    "autoRemoveDependants",
    "provenance",
  ]),
  entity: new Set([
    "entityID",
    "sourceObjectID",
    "sourceItemID",
    "dunObjectID",
    "classification",
    "kind",
    "typeID",
    "typeName",
    "categoryID",
    "groupID",
    "ownerID",
    "graphicID",
    "position",
    "rotation",
    "direction",
    "radius",
    "destructible",
    "objectiveRole",
    "gateKind",
    "collision",
    "activeFieldEffect",
    "provenance",
    "npcProfileID",
    "behaviorProfileID",
    "loadoutID",
    "objectiveBlocker",
    "objectiveMembershipProvenance",
    "controllerEntityID",
    "deactivatesOnEntityID",
    "controllerLossBehavior",
    "controllerLinkProvenance",
    "autoRemoveWithController",
    "remainsPresentAndTargetableOnControllerLoss",
  ]),
  collision: new Set([
    "status",
    "exact",
    "fingerprint",
    "flagsByte",
    "geometry",
  ]),
  collisionGeometry: new Set([
    "kind",
    "boundingSphereRadius",
    "miniBalls",
    "miniBoxes",
    "miniCapsules",
  ]),
  miniBall: new Set(["x", "y", "z", "radius"]),
  miniBox: new Set([
    "x0", "y0", "z0",
    "x1", "y1", "z1",
    "x2", "y2", "z2",
    "c0", "c1", "c2",
  ]),
  miniCapsule: new Set(["ax", "ay", "az", "bx", "by", "bz", "radius"]),
  activeFieldEffect: new Set([
    "mechanicID",
    "guid",
    "active",
    "durationMs",
    "repeatMs",
    "moduleTypeID",
    "moduleBinding",
    "targetBinding",
    "startTimePolicy",
    "timeFromStartPolicy",
  ]),
  entityProvenance: new Set([
    "directlyObserved",
    "evidenceClassification",
    "sourceLine",
    "sourceTransformFallback",
  ]),
  roomProvenance: new Set([
    "directlyObserved",
    "evidenceClassification",
    "encounterRef",
    "insertionRef",
    "layoutRef",
    "localizedOverlayRef",
    "weatherOverlayRef",
    "encounterContentHash",
    "insertionContentHash",
    "layoutContentHash",
    "localizedContentHash",
    "weatherContentHash",
  ]),
  lootOutcome: new Set([
    "outcomeID",
    "observedOutcome",
    "exactRetailWeightsKnown",
    "sourceCaptureID",
    "evidenceClassification",
    "container",
    "items",
  ]),
  lootContainer: new Set([
    "launcherKind",
    "launcherTypeID",
    "launcherTypeName",
    "launcherSourceItemID",
    "launcherObserved",
    "wreckKind",
    "wreckTypeID",
    "wreckTypeName",
    "wreckSourceItemID",
  ]),
  lootItem: new Set([
    "itemTypeID",
    "quantity",
    "sourceItemID",
    "sourceLine",
  ]),
});

function cloneValue(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normalizeText(value) {
  return String(value == null ? "" : value).trim();
}

function normalizeLowerText(value) {
  return normalizeText(value).toLowerCase();
}

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function isPositiveInteger(value) {
  return Number.isInteger(Number(value)) && Number(value) > 0;
}

function isFiniteVector(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Number.isFinite(Number(value.x)) &&
    Number.isFinite(Number(value.y)) &&
    Number.isFinite(Number(value.z)),
  );
}

function validateAuthoredCollision(checks, captureID, roomNumber, entityID, entity) {
  const { addError, checkUnknownFields } = checks;
  if (entity && entity.collision) {
    checkUnknownFields(entity.collision, ALLOWED_FIELDS.collision, {
      captureID,
      roomNumber,
      entityID,
      field: "entities[].collision",
    });
    if (entity.collision.geometry) {
      checkUnknownFields(
        entity.collision.geometry,
        ALLOWED_FIELDS.collisionGeometry,
        {
          captureID,
          roomNumber,
          entityID,
          field: "entities[].collision.geometry",
        },
      );
      for (const [kind, allowed] of [
        ["miniBalls", ALLOWED_FIELDS.miniBall],
        ["miniBoxes", ALLOWED_FIELDS.miniBox],
        ["miniCapsules", ALLOWED_FIELDS.miniCapsule],
      ]) {
        for (const [index, primitive] of (
          Array.isArray(entity.collision.geometry[kind])
            ? entity.collision.geometry[kind]
            : []
        ).entries()) {
          checkUnknownFields(primitive, allowed, {
            captureID,
            roomNumber,
            entityID,
            field: `entities[].collision.geometry.${kind}[${index}]`,
          });
          if (!Object.values(primitive).every((value) => Number.isFinite(Number(value)))) {
            addError({
              captureID,
              roomNumber,
              entityID,
              field: `entities[].collision.geometry.${kind}[${index}]`,
              code: "INVALID_COLLISION_GEOMETRY",
              reason: "collision primitive values must be finite numbers",
            });
          }
        }
      }
    }
  }
}

function validateAuthoredEntity(checks, captureID, roomNumber, entityIDs, entity) {
  const { addError, checkUnknownFields, isKnownObjectTypeID } = checks;
  const entityID = normalizeText(entity && entity.entityID) || null;
  checkUnknownFields(entity, ALLOWED_FIELDS.entity, {
    captureID,
    roomNumber,
    entityID,
    field: "entities[]",
  });
  if (!entityID) {
    addError({
      captureID,
      roomNumber,
      entityID,
      field: "entities[].entityID",
      code: "MISSING_ENTITY_ID",
      reason: "stable entity ID is required",
    });
  } else if (entityIDs.has(entityID)) {
    addError({
      captureID,
      roomNumber,
      entityID,
      field: "entities[].entityID",
      code: "DUPLICATE_ENTITY_ID",
      reason: `duplicate entity ID ${entityID}`,
    });
  }
  entityIDs.add(entityID);
  if (!isPositiveInteger(entity && entity.typeID)) {
    addError({
      captureID,
      roomNumber,
      entityID,
      field: "entities[].typeID",
      code: "INVALID_OBJECT_TYPE_ID",
      reason: "object type ID must be a positive integer",
    });
  } else if (
    isKnownObjectTypeID &&
    normalizeText(entity && entity.kind) !== "npc" &&
    !isKnownObjectTypeID(toInt(entity.typeID, 0))
  ) {
    addError({
      captureID,
      roomNumber,
      entityID,
      field: "entities[].typeID",
      code: "UNKNOWN_OBJECT_TYPE_ID",
      reason: `object type ID ${entity.typeID} is absent from the active type catalogue`,
    });
  }
  if (!isFiniteVector(entity && entity.position)) {
    addError({
      captureID,
      roomNumber,
      entityID,
      field: "entities[].position",
      code: "INVALID_COORDINATE",
      reason: "entity position must contain finite x, y and z coordinates",
    });
  }
  if (entity && entity.rotation != null && !isFiniteVector(entity.rotation)) {
    addError({
      captureID,
      roomNumber,
      entityID,
      field: "entities[].rotation",
      code: "INVALID_ROTATION",
      reason: "entity rotation must contain finite x, y and z values",
    });
  }
  if (entity && entity.direction != null && !isFiniteVector(entity.direction)) {
    addError({
      captureID,
      roomNumber,
      entityID,
      field: "entities[].direction",
      code: "INVALID_DIRECTION",
      reason: "entity direction must contain finite x, y and z values",
    });
  }
  checkUnknownFields(entity && entity.provenance, ALLOWED_FIELDS.entityProvenance, {
    captureID,
    roomNumber,
    entityID,
    field: "entities[].provenance",
  });
  validateAuthoredCollision(checks, captureID, roomNumber, entityID, entity);
  if (entity && entity.activeFieldEffect) {
    checkUnknownFields(
      entity.activeFieldEffect,
      ALLOWED_FIELDS.activeFieldEffect,
      {
        captureID,
        roomNumber,
        entityID,
        field: "entities[].activeFieldEffect",
      },
    );
  }
}

function validateAuthoredRoomReferences(checks, captureID, roomNumber, entityIDs, room) {
  const { addError, checkUnknownFields } = checks;
  function validateReferences(values, field, code) {
    for (const entityID of Array.isArray(values) ? values : []) {
      if (!entityIDs.has(normalizeText(entityID))) {
        addError({
          captureID,
          roomNumber,
          entityID: normalizeText(entityID) || null,
          field,
          code,
          reason: `reference ${entityID} does not resolve to a room entity`,
        });
      }
    }
  }
  function validateOptionalReference(value, field, code) {
    if (value != null && normalizeText(value) && !entityIDs.has(normalizeText(value))) {
      addError({
        captureID,
        roomNumber,
        entityID: normalizeText(value),
        field,
        code,
        reason: `reference ${value} does not resolve to a room entity`,
      });
    }
  }

  validateReferences(
    room && room.objective && room.objective.blockerEntityIDs,
    "objective.blockerEntityIDs",
    "INVALID_BLOCKER_REFERENCE",
  );
  validateReferences(
    room && room.objective && room.objective.nonBlockingEntityIDs,
    "objective.nonBlockingEntityIDs",
    "INVALID_NON_BLOCKER_REFERENCE",
  );
  validateReferences(
    room && room.environmentObjectEntityIDs,
    "environmentObjectEntityIDs",
    "INVALID_ENVIRONMENT_REFERENCE",
  );
  validateReferences(
    room && room.extractionNodeEntityIDs,
    "extractionNodeEntityIDs",
    "INVALID_EXTRACTION_NODE_REFERENCE",
  );
  validateReferences(
    room && room.extractionSubNodeEntityIDs,
    "extractionSubNodeEntityIDs",
    "INVALID_EXTRACTION_SUBNODE_REFERENCE",
  );
  validateOptionalReference(
    room && room.playerSpawnEntityID,
    "playerSpawnEntityID",
    "INVALID_PLAYER_SPAWN_REFERENCE",
  );
  validateOptionalReference(
    room && room.mainCacheEntityID,
    "mainCacheEntityID",
    "INVALID_CACHE_REFERENCE",
  );
  validateOptionalReference(
    room && room.transferConduitEntityID,
    "transferConduitEntityID",
    "INVALID_CONDUIT_REFERENCE",
  );
  validateOptionalReference(
    room && room.originConduitEntityID,
    "originConduitEntityID",
    "INVALID_CONDUIT_REFERENCE",
  );
  validateOptionalReference(
    room && room.environment && room.environment.volumetricCloudEntityID,
    "environment.volumetricCloudEntityID",
    "INVALID_ENVIRONMENT_REFERENCE",
  );

  for (const [index, group] of (
    room && room.objective && Array.isArray(room.objective.controllerGroups)
      ? room.objective.controllerGroups
      : []
  ).entries()) {
    checkUnknownFields(group, ALLOWED_FIELDS.controllerGroup, {
      captureID,
      roomNumber,
      field: `objective.controllerGroups[${index}]`,
    });
    validateOptionalReference(
      group.controllerEntityID,
      `objective.controllerGroups[${index}].controllerEntityID`,
      "INVALID_CONTROLLER_REFERENCE",
    );
    validateReferences(
      group.dependantEntityIDs,
      `objective.controllerGroups[${index}].dependantEntityIDs`,
      "INVALID_DEPENDANT_REFERENCE",
    );
  }
  for (const [index, group] of (
    room && Array.isArray(room.npcGroups) ? room.npcGroups : []
  ).entries()) {
    checkUnknownFields(group, ALLOWED_FIELDS.npcGroup, {
      captureID,
      roomNumber,
      field: `npcGroups[${index}]`,
    });
    validateReferences(
      group.memberEntityIDs,
      `npcGroups[${index}].memberEntityIDs`,
      "INVALID_NPC_GROUP_REFERENCE",
    );
  }
}

function validateAuthoredLootOutcomes(checks, captureID, roomNumber, room) {
  const { addError, checkUnknownFields } = checks;
  for (const [index, outcome] of (
    room && Array.isArray(room.observedLootOutcomes)
      ? room.observedLootOutcomes
      : []
  ).entries()) {
    checkUnknownFields(outcome, ALLOWED_FIELDS.lootOutcome, {
      captureID,
      roomNumber,
      field: `observedLootOutcomes[${index}]`,
    });
    checkUnknownFields(outcome.container, ALLOWED_FIELDS.lootContainer, {
      captureID,
      roomNumber,
      field: `observedLootOutcomes[${index}].container`,
    });
    for (const [itemIndex, item] of (
      Array.isArray(outcome.items) ? outcome.items : []
    ).entries()) {
      checkUnknownFields(item, ALLOWED_FIELDS.lootItem, {
        captureID,
        roomNumber,
        field: `observedLootOutcomes[${index}].items[${itemIndex}]`,
      });
    }
    if (
      outcome.observedOutcome !== true ||
      outcome.exactRetailWeightsKnown !== false
    ) {
      addError({
        captureID,
        roomNumber,
        field: `observedLootOutcomes[${index}]`,
        code: "INVALID_OBSERVED_LOOT_AUTHORITY",
        reason: "observed loot must remain a non-authoritative observed outcome",
      });
    }
  }
}

function validateAuthoredRoom(checks, captureID, room) {
  const { addError, checkUnknownFields, roomIDs } = checks;
  const roomNumber = toInt(room && room.roomNumber, 0) || null;
  const roomID = normalizeText(room && room.roomID);
  checkUnknownFields(room, ALLOWED_FIELDS.room, {
    captureID,
    roomNumber,
    field: "room",
  });
  if (!roomID) {
    addError({
      captureID,
      roomNumber,
      field: "roomID",
      code: "MISSING_ROOM_ID",
      reason: "room ID is required",
    });
  } else if (roomIDs.has(roomID)) {
    addError({
      captureID,
      roomNumber,
      field: "roomID",
      code: "DUPLICATE_ROOM_ID",
      reason: `duplicate room ID ${roomID}`,
    });
  }
  roomIDs.add(roomID);
  checkUnknownFields(room && room.geometry, ALLOWED_FIELDS.geometry, {
    captureID,
    roomNumber,
    field: "geometry",
  });
  checkUnknownFields(
    room && room.geometry && room.geometry.boundary,
    ALLOWED_FIELDS.boundary,
    { captureID, roomNumber, field: "geometry.boundary" },
  );
  if (!isFiniteVector(room && room.geometry && room.geometry.sourceOrigin)) {
    addError({
      captureID,
      roomNumber,
      field: "geometry.sourceOrigin",
      code: "INVALID_COORDINATE",
      reason: "source origin must contain finite x, y and z coordinates",
    });
  }
  checkUnknownFields(room && room.environment, ALLOWED_FIELDS.environment, {
    captureID,
    roomNumber,
    field: "environment",
  });
  checkUnknownFields(room && room.objective, ALLOWED_FIELDS.objective, {
    captureID,
    roomNumber,
    field: "objective",
  });
  checkUnknownFields(room && room.provenance, ALLOWED_FIELDS.roomProvenance, {
    captureID,
    roomNumber,
    field: "provenance",
  });

  const entities = Array.isArray(room && room.entities) ? room.entities : [];
  const entityIDs = new Set();
  for (const entity of entities) {
    validateAuthoredEntity(checks, captureID, roomNumber, entityIDs, entity);
  }

  validateAuthoredRoomReferences(checks, captureID, roomNumber, entityIDs, room);
  validateAuthoredLootOutcomes(checks, captureID, roomNumber, room);
}

function validateAuthoredCapture(checks, capture) {
  const { addError, checkUnknownFields, captureIDs } = checks;
  const captureID = normalizeText(capture && capture.captureID) || null;
  checkUnknownFields(capture, ALLOWED_FIELDS.capture, {
    captureID,
    field: "capture",
  });
  if (!captureID) {
    addError({
      captureID,
      field: "captureID",
      code: "MISSING_CAPTURE_ID",
      reason: "capture ID is required",
    });
  } else if (captureIDs.has(captureID)) {
    addError({
      captureID,
      field: "captureID",
      code: "DUPLICATE_CAPTURE_ID",
      reason: `duplicate capture ID ${captureID}`,
    });
  }
  captureIDs.add(captureID);
  if (toInt(capture && capture.tier, -1) < 0 || toInt(capture && capture.tier, -1) > 6) {
    addError({
      captureID,
      field: "tier",
      code: "INVALID_TIER",
      reason: "tier must be an integer from 0 through 6",
    });
  }
  if (!VALID_WEATHER_TYPES.has(normalizeLowerText(capture && capture.weatherType))) {
    addError({
      captureID,
      field: "weatherType",
      code: "INVALID_WEATHER",
      reason: `unsupported weather ${normalizeText(capture && capture.weatherType)}`,
    });
  }
  if (!isPositiveInteger(capture && capture.filamentTypeID)) {
    addError({
      captureID,
      field: "filamentTypeID",
      code: "INVALID_FILAMENT_TYPE_ID",
      reason: "filament type ID must be a positive integer",
    });
  }
  checkUnknownFields(capture && capture.dependencies, ALLOWED_FIELDS.dependencies, {
    captureID,
    field: "dependencies",
  });
  checkUnknownFields(
    capture && capture.provenance,
    ALLOWED_FIELDS.captureProvenance,
    { captureID, field: "provenance" },
  );
  for (const [index, artifact] of (capture && capture.provenance &&
    Array.isArray(capture.provenance.sourceArtifacts)
    ? capture.provenance.sourceArtifacts
    : []).entries()) {
    checkUnknownFields(artifact, ALLOWED_FIELDS.sourceArtifact, {
      captureID,
      field: `provenance.sourceArtifacts[${index}]`,
    });
  }
  if (capture && capture.existingRegistration) {
    checkUnknownFields(
      capture.existingRegistration,
      ALLOWED_FIELDS.existingRegistration,
      { captureID, field: "existingRegistration" },
    );
  }

  const rooms = Array.isArray(capture && capture.rooms) ? capture.rooms : [];
  if (rooms.length !== 3) {
    addError({
      captureID,
      field: "rooms",
      code: "INVALID_COMPLETE_ROOM_COUNT",
      reason: `complete authored run must contain exactly three rooms; found ${rooms.length}`,
    });
  }
  const roomNumbers = rooms.map((room) => toInt(room && room.roomNumber, 0));
  if (JSON.stringify([...roomNumbers].sort()) !== JSON.stringify([1, 2, 3])) {
    addError({
      captureID,
      field: "rooms[].roomNumber",
      code: "INVALID_ROOM_NUMBERING",
      reason: `room numbers must be 1, 2 and 3; found ${roomNumbers.join(", ")}`,
    });
  }

  for (const room of rooms) {
    validateAuthoredRoom(checks, captureID, room);
  }
}

function validateAuthoredAbyssalCatalogue(catalogue, options = {}) {
  const errors = [];
  const captureIDs = new Set();
  const roomIDs = new Set();
  const isKnownObjectTypeID = typeof options.isKnownObjectTypeID === "function"
    ? options.isKnownObjectTypeID
    : null;

  function addError({
    captureID = null,
    roomNumber = null,
    field,
    entityID = null,
    code,
    reason,
  }) {
    errors.push({
      captureID,
      roomNumber,
      field,
      entityID,
      code,
      reason,
    });
  }

  function checkUnknownFields(record, allowed, context) {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      addError({
        ...context,
        code: "INVALID_OBJECT",
        reason: "expected an object",
      });
      return;
    }
    for (const field of Object.keys(record)) {
      if (!allowed.has(field)) {
        addError({
          ...context,
          field: context.field ? `${context.field}.${field}` : field,
          code: "UNKNOWN_FIELD",
          reason: `unknown field ${field}`,
        });
      }
    }
  }

  checkUnknownFields(catalogue, ALLOWED_FIELDS.catalogue, {
    field: "catalogue",
  });
  if (toInt(catalogue && catalogue.schemaVersion, 0) !== SUPPORTED_SCHEMA_VERSION) {
    addError({
      field: "schemaVersion",
      code: "UNSUPPORTED_SCHEMA_VERSION",
      reason: `expected schema version ${SUPPORTED_SCHEMA_VERSION}`,
    });
  }
  if (normalizeText(catalogue && catalogue.contentKind) !== CONTENT_KIND) {
    addError({
      field: "contentKind",
      code: "INVALID_CONTENT_KIND",
      reason: `expected ${CONTENT_KIND}`,
    });
  }
  checkUnknownFields(catalogue && catalogue.generatedBy, ALLOWED_FIELDS.generatedBy, {
    field: "generatedBy",
  });
  checkUnknownFields(
    catalogue && catalogue.expectedCounts,
    ALLOWED_FIELDS.expectedCounts,
    { field: "expectedCounts" },
  );

  const captures = Array.isArray(catalogue && catalogue.captures)
    ? catalogue.captures
    : [];
  if (!Array.isArray(catalogue && catalogue.captures)) {
    addError({
      field: "captures",
      code: "INVALID_CAPTURE_LIST",
      reason: "captures must be an array",
    });
  }

  const checks = { addError, checkUnknownFields, captureIDs, roomIDs, isKnownObjectTypeID };
  for (const capture of captures) {
    validateAuthoredCapture(checks, capture);
  }

  const expectedCaptureCount = toInt(
    catalogue && catalogue.expectedCounts && catalogue.expectedCounts.captures,
    captures.length,
  );
  const actualRoomCount = captures.reduce(
    (total, capture) => total + (Array.isArray(capture && capture.rooms)
      ? capture.rooms.length
      : 0),
    0,
  );
  const expectedRoomCount = toInt(
    catalogue && catalogue.expectedCounts && catalogue.expectedCounts.rooms,
    actualRoomCount,
  );
  if (captures.length !== expectedCaptureCount) {
    addError({
      field: "expectedCounts.captures",
      code: "CAPTURE_COUNT_MISMATCH",
      reason: `expected ${expectedCaptureCount} captures; found ${captures.length}`,
    });
  }
  if (actualRoomCount !== expectedRoomCount) {
    addError({
      field: "expectedCounts.rooms",
      code: "ROOM_COUNT_MISMATCH",
      reason: `expected ${expectedRoomCount} rooms; found ${actualRoomCount}`,
    });
  }

  return {
    success: errors.length === 0,
    errors,
    captureCount: captures.length,
    roomCount: actualRoomCount,
  };
}

function fnv1a32(value) {
  let hash = 0x811c9dc5;
  for (const character of String(value == null ? "" : value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function listCaptures(scope, query = {}) {
  const { captures } = scope;
  const tierSpecified = query.tier !== undefined && query.tier !== null;
  const weatherType = normalizeLowerText(query.weatherType || query.weather);
  const filamentTypeID = toInt(query.filamentTypeID, 0);
  return captures
    .filter((capture) => !tierSpecified || capture.tier === toInt(query.tier, -1))
    .filter((capture) => !weatherType || capture.weatherType === weatherType)
    .filter((capture) => filamentTypeID <= 0 || capture.filamentTypeID === filamentTypeID)
    .filter((capture) =>
      query.runtimeReady === undefined ||
      capture.runtimeReadiness.runtimeReady === (query.runtimeReady === true)
    )
    .map(cloneValue);
}

function resolveCaptureByID(scope, captureID) {
  const { captureByID } = scope;
  const capture = captureByID.get(normalizeText(captureID));
  return capture ? cloneValue(capture) : null;
}

function selectCapture(scope, query = {}) {
  const { captureByID } = scope;
  const requestedCaptureID = normalizeText(query.captureID || query.authoredCaptureID);
  if (requestedCaptureID) {
    const capture = captureByID.get(requestedCaptureID);
    if (!capture) {
      return {
        success: false,
        errorCode: "AUTHORED_CAPTURE_NOT_FOUND",
        errorMsg: `AUTHORED_CAPTURE_NOT_FOUND captureID=${requestedCaptureID}`,
        requestedCaptureID,
        fallbackAllowed: false,
        capture: null,
      };
    }
    if (capture.runtimeReadiness.runtimeReady !== true) {
      return {
        success: false,
        errorCode: "AUTHORED_CAPTURE_DEPENDENCY_INCOMPLETE",
        errorMsg:
          `AUTHORED_CAPTURE_DEPENDENCY_INCOMPLETE captureID=${capture.captureID} ` +
          `npcTypeIDs=${capture.runtimeReadiness.unsupportedNpcTypeIDs.join(",") || "none"} ` +
          `mechanics=${capture.runtimeReadiness.unsupportedMechanicIDs.join(",") || "none"}`,
        requestedCaptureID,
        fallbackAllowed: false,
        capture: cloneValue(capture),
      };
    }
    return {
      success: true,
      capture: cloneValue(capture),
      requestedCaptureID,
      selectionPolicy: "explicit-capture-id",
      eligibleCaptureIDs: [capture.captureID],
    };
  }

  const matching = listCaptures(scope, query);
  const eligible = matching
    .filter((capture) => capture.runtimeReadiness.runtimeReady === true)
    .sort((left, right) => left.captureID.localeCompare(right.captureID));
  if (eligible.length === 0) {
    return {
      success: false,
      errorCode: "NO_ELIGIBLE_AUTHORED_CAPTURE",
      errorMsg:
        `NO_ELIGIBLE_AUTHORED_CAPTURE tier=${toInt(query.tier, -1)} ` +
        `weather=${normalizeLowerText(query.weatherType || query.weather) || "unknown"} ` +
        `filamentTypeID=${toInt(query.filamentTypeID, 0)}`,
      fallbackAllowed: true,
      unavailableCaptures: matching.map((capture) => ({
        captureID: capture.captureID,
        unsupportedNpcTypeIDs:
          cloneValue(capture.runtimeReadiness.unsupportedNpcTypeIDs),
        unsupportedMechanicIDs:
          cloneValue(capture.runtimeReadiness.unsupportedMechanicIDs),
        validationErrorCount: capture.runtimeReadiness.validationErrorCount,
      })),
    };
  }
  const selectionSeed = normalizeText(
    query.selectionSeed ??
    query.traceItemID ??
    query.filamentItemID ??
    query.filamentTypeID,
  );
  const selected = eligible[fnv1a32(selectionSeed) % eligible.length];
  return {
    success: true,
    capture: cloneValue(selected),
    requestedCaptureID: "",
    selectionPolicy: "provisional-equal-deterministic",
    selectionSeed,
    eligibleCaptureIDs: eligible.map((capture) => capture.captureID),
  };
}

function getAudit(scope) {
  const { captures, catalogue, validation } = scope;
  const grouped = {};
  for (const capture of captures) {
    const key = `tier-${capture.tier}:${capture.weatherType}`;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(capture.captureID);
  }
  for (const captureIDs of Object.values(grouped)) captureIDs.sort();
  const sourceUUIDs = new Map();
  for (const capture of captures) {
    const sourceUUID = normalizeText(
      capture.provenance && capture.provenance.sourceContentUUID,
    );
    if (!sourceUUID) continue;
    if (!sourceUUIDs.has(sourceUUID)) sourceUUIDs.set(sourceUUID, []);
    sourceUUIDs.get(sourceUUID).push(capture.captureID);
  }
  const duplicateCaptures = [...sourceUUIDs.entries()]
    .filter(([, captureIDs]) => captureIDs.length > 1)
    .map(([sourceContentUUID, captureIDs]) => ({
      sourceContentUUID,
      captureIDs: [...captureIDs].sort(),
    }));
  return {
    schemaVersion: toInt(catalogue && catalogue.schemaVersion, 0),
    activeGenerationID: normalizeText(
      catalogue && catalogue.generatedBy && catalogue.generatedBy.activeGenerationID,
    ),
    captureCount: captures.length,
    roomCount: captures.reduce(
      (total, capture) => total + (capture.rooms || []).length,
      0,
    ),
    capturesByTierAndWeather: grouped,
    runtimeReadyCaptureIDs: captures
      .filter((capture) => capture.runtimeReadiness.runtimeReady)
      .map((capture) => capture.captureID)
      .sort(),
    dependencyIncompleteCaptures: captures
      .filter((capture) => !capture.runtimeReadiness.runtimeReady)
      .map((capture) => ({
        captureID: capture.captureID,
        unsupportedNpcTypeIDs:
          cloneValue(capture.runtimeReadiness.unsupportedNpcTypeIDs),
        unsupportedMechanicIDs:
          cloneValue(capture.runtimeReadiness.unsupportedMechanicIDs),
        validationErrorCount: capture.runtimeReadiness.validationErrorCount,
      })),
    unsupportedNpcTypeIDs: [...new Set(
      captures.flatMap((capture) =>
        capture.runtimeReadiness.unsupportedNpcTypeIDs
      ),
    )].sort((left, right) => left - right),
    unsupportedMechanicIDs: [...new Set(
      captures.flatMap((capture) =>
        capture.runtimeReadiness.unsupportedMechanicIDs
      ),
    )].sort(),
    duplicateCaptures,
    reusedExistingCaptures: captures
      .filter((capture) =>
        capture.existingRegistration &&
        capture.existingRegistration.reused === true
      )
      .map((capture) => ({
        captureID: capture.captureID,
        existingProfileID: capture.existingRegistration.existingProfileID,
        comparison: capture.existingRegistration.comparison,
      })),
    validationErrors: cloneValue(validation.errors),
  };
}

function createAuthoredAbyssalContentRegistry(catalogue = generatedCatalogue, options = {}) {
  const validation = validateAuthoredAbyssalCatalogue(catalogue, options);
  const supportedNpcProfilesByTypeID = Object.fromEntries(
    Object.entries(options.supportedNpcProfilesByTypeID || {})
      .map(([typeID, profile]) => [String(toInt(typeID, 0)), cloneValue(profile)])
      .filter(([typeID, profile]) => toInt(typeID, 0) > 0 && profile),
  );
  const supportedMechanicIDs = new Set(
    (Array.isArray(options.supportedMechanicIDs)
      ? options.supportedMechanicIDs
      : []).map(normalizeText).filter(Boolean),
  );
  const errorsByCaptureID = new Map();
  for (const error of validation.errors) {
    const captureID = normalizeText(error && error.captureID);
    if (!captureID) continue;
    if (!errorsByCaptureID.has(captureID)) errorsByCaptureID.set(captureID, []);
    errorsByCaptureID.get(captureID).push(error);
  }

  const captures = (Array.isArray(catalogue && catalogue.captures)
    ? catalogue.captures
    : []).map((sourceCapture) => {
    const capture = cloneValue(sourceCapture);
    capture.contentAuthority = ABYSSAL_CONTENT_AUTHORITY.CAPTURED_RETAIL;
    const npcTypeIDs = Array.isArray(capture.dependencies && capture.dependencies.npcTypeIDs)
      ? capture.dependencies.npcTypeIDs.map((entry) => toInt(entry, 0)).filter((entry) => entry > 0)
      : [];
    const mechanicIDs = Array.isArray(capture.dependencies && capture.dependencies.mechanicIDs)
      ? capture.dependencies.mechanicIDs.map(normalizeText).filter(Boolean)
      : [];
    const unsupportedNpcTypeIDs = npcTypeIDs
      .filter((typeID) => !supportedNpcProfilesByTypeID[String(typeID)])
      .sort((left, right) => left - right);
    const unsupportedMechanicIDs = mechanicIDs
      .filter((mechanicID) => !supportedMechanicIDs.has(mechanicID))
      .sort();
    const captureValidationErrors = errorsByCaptureID.get(capture.captureID) || [];
    capture.runtimeReadiness = {
      runtimeReady:
        unsupportedNpcTypeIDs.length === 0 &&
        unsupportedMechanicIDs.length === 0 &&
        captureValidationErrors.length === 0,
      unsupportedNpcTypeIDs,
      unsupportedMechanicIDs,
      validationErrorCount: captureValidationErrors.length,
      npcProfilesByTypeID: Object.fromEntries(
        npcTypeIDs
          .filter((typeID) => supportedNpcProfilesByTypeID[String(typeID)])
          .map((typeID) => [
            String(typeID),
            cloneValue(supportedNpcProfilesByTypeID[String(typeID)]),
          ]),
      ),
    };
    return capture;
  });
  const captureByID = new Map();
  for (const capture of captures) {
    const identifiers = [
      capture.captureID,
      capture.captureKey,
      capture.runDefinitionID,
      ...(Array.isArray(capture.aliases) ? capture.aliases : []),
    ].map(normalizeText).filter(Boolean);
    for (const identifier of identifiers) {
      if (!captureByID.has(identifier)) captureByID.set(identifier, capture);
    }
  }

  const scope = Object.freeze({ catalogue, validation, captures, captureByID });
  return Object.freeze({
    listCaptures: listCaptures.bind(null, scope),
    resolveCaptureByID: resolveCaptureByID.bind(null, scope),
    selectCapture: selectCapture.bind(null, scope),
    getAudit: getAudit.bind(null, scope),
  });
}

function getGeneratedAuthoredCatalogue() {
  return cloneValue(generatedCatalogue);
}

function listGeneratedAuthoredCaptures(query = {}) {
  const tierSpecified = query.tier !== undefined && query.tier !== null;
  const weatherType = normalizeLowerText(query.weatherType || query.weather);
  const layoutVariant = normalizeText(query.layoutVariant);
  return generatedCatalogue.captures
    .filter((capture) => !tierSpecified || capture.tier === toInt(query.tier, -1))
    .filter((capture) => !weatherType || capture.weatherType === weatherType)
    .filter((capture) => !layoutVariant || capture.layoutVariant === layoutVariant)
    .map(cloneValue);
}

function resolveGeneratedAuthoredCapture(captureID) {
  const normalizedID = normalizeText(captureID);
  const capture = generatedCatalogue.captures.find((entry) =>
    [
      entry.captureID,
      entry.captureKey,
      entry.runDefinitionID,
      ...(Array.isArray(entry.aliases) ? entry.aliases : []),
    ].map(normalizeText).includes(normalizedID)
  );
  return capture ? cloneValue(capture) : null;
}

module.exports = {
  CONTENT_KIND,
  CONTROLLER_DEPENDANT_MECHANIC_ID,
  SUPPORTED_SCHEMA_VERSION,
  createAuthoredAbyssalContentRegistry,
  getGeneratedAuthoredCatalogue,
  listGeneratedAuthoredCaptures,
  resolveGeneratedAuthoredCapture,
  validateAuthoredAbyssalCatalogue,
};
