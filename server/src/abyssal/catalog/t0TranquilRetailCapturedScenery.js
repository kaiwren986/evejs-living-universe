"use strict";

const fixture = require("./fixtures/t0TranquilRetailCapturedSceneryFixture.json");
const {
  cloneValue,
  deepFreeze,
} = require("../domain/abyssalValueUtils");
const {
  getGeneratedAuthoredCatalogue,
  resolveGeneratedAuthoredCapture,
} = require("./content/authoredAbyssalContentRegistry");

const SCENERY_POLICY_AUTHORITATIVE = "authoritative";
const SUPPORTED_WEATHER_TYPES = Object.freeze([
  "electrical",
  "exotic",
  "firestorm",
  "gamma",
]);
const CAPTURED_LAYOUT_SOURCE_BY_WEATHER = Object.freeze({
  electrical: "electrical",
  exotic: "exotic",
  firestorm: "firestorm",
  gamma: "gamma",
});
const CAPTURED_LAYOUT_SOURCE_BY_VARIANT = Object.freeze({
  "tier0-electrical-captured-b": "electrical_b",
});
const LAYOUT_VARIANT_BY_WEATHER = Object.freeze({
  electrical: "tier0-electrical-captured-a",
  exotic: "authored:tq-tranquil-exotic-8",
  firestorm: "tier0-firestorm-captured-a",
  gamma: "tier0-gamma-captured-a",
});

const GENERATED_AUTHORED_CATALOGUE = getGeneratedAuthoredCatalogue();
const AUTHORED_TRANQUIL_EXOTIC_CAPTURE = resolveGeneratedAuthoredCapture(
  "tq-tranquil-exotic-8",
);
if (!AUTHORED_TRANQUIL_EXOTIC_CAPTURE) {
  throw new Error("AUTHORED_TRANQUIL_EXOTIC_SCENERY_NOT_REGISTERED");
}

const AUTHORED_TRANQUIL_EXOTIC_SCENERY_LAYOUT = deepFreeze({
  sourceArchive:
    GENERATED_AUTHORED_CATALOGUE.generatedBy.sourceArchiveName,
  sourceFile:
    AUTHORED_TRANQUIL_EXOTIC_CAPTURE.provenance.sourceArtifacts[0].fileName,
  rooms: Object.fromEntries(
    AUTHORED_TRANQUIL_EXOTIC_CAPTURE.rooms.map((room) => {
      const entities = room.entities.filter((entity) =>
        entity.classification === "layout" &&
        !/dungeon cloud/i.test(String(entity.typeName || ""))
      );
      return [String(room.roomNumber), {
        sourceLine: Math.min(
          ...entities
            .map((entity) => toInt(entity.provenance.sourceLine, 0))
            .filter((sourceLine) => sourceLine > 0),
        ),
        capturedBallCount: entities.length,
        rows: entities.map((entity) => [
          entity.sourceItemID || entity.sourceObjectID,
          entity.typeID,
          entity.ownerID,
          entity.dunObjectID,
          null,
          null,
          [entity.position.x, entity.position.y, entity.position.z],
          entity.rotation
            ? [entity.rotation.x, entity.rotation.y, entity.rotation.z]
            : null,
          entity.groupID,
          entity.categoryID,
        ]),
      }];
    }),
  ),
});

const GENERATED_AUTHORED_CAPTURE_BY_LAYOUT_VARIANT = new Map(
  GENERATED_AUTHORED_CATALOGUE.captures
    .filter((capture) =>
      !(capture.existingRegistration &&
        capture.existingRegistration.reused === true)
    )
    .map((capture) => [
      String(capture.layoutVariant || "").trim().toLowerCase(),
      capture,
    ]),
);

function toInt(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeWeatherType(value) {
  return String(value || "").trim().toLowerCase();
}

function resolveEntryRole(typeID) {
  if (typeID === 49691) {
    return "structure";
  }
  if (typeID >= 47936 && typeID <= 47948) {
    return "debris";
  }
  if ([47674, 47675, 47677, 47678, 47679].includes(typeID)) {
    return "debris";
  }
  return "structure";
}

function buildSceneryEntry(
  weatherType,
  sourceWeatherType,
  roomIndex,
  row,
  index,
  sourceLine,
  sourceArchive,
  sourceFile,
) {
  const [
    retailBallID,
    typeIDValue,
    ownerID,
    dunObjectID,
    dunObjectNameID,
    objectiveTargetGroup,
    position,
    rotation,
    groupID,
    categoryID,
  ] = row;
  const typeID = toInt(typeIDValue, 0);
  return deepFreeze({
    slot: index + 1,
    entryRole: resolveEntryRole(typeID),
    candidateTypeID: typeID,
    exactRelativePosition: {
      x: Number(position && position[0]) || 0,
      y: Number(position && position[1]) || 0,
      z: Number(position && position[2]) || 0,
    },
    exactRetailRotation: Array.isArray(rotation)
      ? rotation.map((entry) => Number(entry) || 0)
      : null,
    dunObjectID: toInt(dunObjectID, 0),
    dunObjectNameID,
    objectiveTargetGroup,
    retailBallID: String(retailBallID || ""),
    capturedRetailOwnerID: toInt(ownerID, 0),
    capturedRetailObject: true,
    identity: {
      identityPolicy: weatherType === sourceWeatherType
        ? "captured-retail"
        : "captured-retail-layout-base",
      namePolicy: "type-derived",
    },
    capturedGroupID: toInt(groupID, 0),
    capturedCategoryID: toInt(categoryID, 0),
    sourceEvidence: {
      archive: sourceArchive,
      capture: sourceFile,
      sourceLine,
      sourceWeatherType,
      requestedWeatherType: weatherType,
      positionEvidence: "slim_dunPosition",
      rotationEvidence: Array.isArray(rotation)
        ? "slim_dunRotation"
        : "not_exposed_in_slim_item",
    },
  });
}

function buildSceneryProfile(
  weatherType,
  roomIndex,
  requestedLayoutVariant = "",
) {
  const layoutVariant =
    requestedLayoutVariant || LAYOUT_VARIANT_BY_WEATHER[weatherType];

  const sourceLayoutKey =
    CAPTURED_LAYOUT_SOURCE_BY_VARIANT[layoutVariant] ||
    CAPTURED_LAYOUT_SOURCE_BY_WEATHER[weatherType];

  const sourceWeatherType =
    sourceLayoutKey === "electrical_b"
      ? "electrical"
      : sourceLayoutKey;

  const sourceLayout =
    sourceWeatherType === "exotic"
      ? AUTHORED_TRANQUIL_EXOTIC_SCENERY_LAYOUT
      : fixture.layouts[sourceLayoutKey];

    const sourceRoom =
    sourceLayout && sourceLayout.rooms[String(roomIndex)];

  if (!sourceRoom) {
    return null;
  }

  const evidenceStatus = weatherType === sourceWeatherType
    ? "CAPTURED_RETAIL_COMPLETE"
    : "CAPTURED_RETAIL_LAYOUT_BASE";
  const entries = sourceRoom.rows.map((row, index) =>
    buildSceneryEntry(
      weatherType,
      sourceWeatherType,
      roomIndex,
      row,
      index,
      sourceRoom.sourceLine,
      sourceLayout.sourceArchive || fixture.sourceArchive,
      sourceLayout.sourceFile,
    )
  );
  return deepFreeze({
    profileID: `abyssal:tier0:${weatherType}:retail-scenery-v1:room-${roomIndex}:props`,
    layoutID: `abyssal:t0:${weatherType}:room${roomIndex}:${layoutVariant}:v1`,
    layoutVariant,
    evidenceStatus,
    sceneryPolicy: SCENERY_POLICY_AUTHORITATIVE,
    capturedRetailProfile: true,
    capturedRetailBaseProfile: weatherType !== sourceWeatherType,
    sourceWeatherType,
    sourceFile: sourceLayout.sourceFile,
    sourceLine: sourceRoom.sourceLine,
    capturedBallCount: sourceRoom.capturedBallCount,
    maxEntries: entries.length,
    entries,
  });
}

function buildGeneratedAuthoredSceneryProfile(capture, roomIndex) {
  const room = capture && capture.rooms.find((entry) =>
    toInt(entry && entry.roomNumber, 0) === toInt(roomIndex, 0)
  );
  if (!room) return null;
  const entities = room.entities.filter((entity) =>
    entity.classification === "layout" &&
    entity.entityID !== room.environment.volumetricCloudEntityID
  );
  const sourceFile = capture.provenance.sourceArtifacts[0].fileName;
  const sourceLine = Math.min(
    ...entities
      .map((entity) => toInt(entity.provenance.sourceLine, 0))
      .filter((value) => value > 0),
  );
  const entries = entities.map((entity, index) =>
    buildSceneryEntry(
      capture.weatherType,
      capture.weatherType,
      room.roomNumber,
      [
        entity.sourceItemID || entity.sourceObjectID,
        entity.typeID,
        entity.ownerID,
        entity.dunObjectID,
        null,
        null,
        [entity.position.x, entity.position.y, entity.position.z],
        entity.rotation
          ? [entity.rotation.x, entity.rotation.y, entity.rotation.z]
          : null,
        entity.groupID,
        entity.categoryID,
      ],
      index,
      sourceLine,
      GENERATED_AUTHORED_CATALOGUE.generatedBy.sourceArchiveName,
      sourceFile,
    )
  );
  return deepFreeze({
    profileID: `${capture.captureID}:room-${room.roomNumber}:presentation`,
    layoutID: room.geometry.layoutID,
    layoutVariant: capture.layoutVariant,
    evidenceStatus: "CAPTURED_RETAIL_COMPLETE",
    sceneryPolicy: SCENERY_POLICY_AUTHORITATIVE,
    capturedRetailProfile: true,
    capturedRetailBaseProfile: false,
    sourceWeatherType: capture.weatherType,
    sourceFile,
    sourceLine,
    capturedBallCount: entries.length,
    maxEntries: entries.length,
    entries,
  });
}

const PROFILES_BY_WEATHER_AND_ROOM = deepFreeze(
  Object.fromEntries(SUPPORTED_WEATHER_TYPES.map((weatherType) => [
    weatherType,
    Object.fromEntries([1, 2, 3].map((roomIndex) => [
      roomIndex,
      buildSceneryProfile(weatherType, roomIndex),
    ])),
  ])),
);

const PROFILES_BY_LAYOUT_VARIANT_AND_ROOM = deepFreeze({
  "tier0-electrical-captured-b": Object.fromEntries([1, 2, 3].map((roomIndex) => [
    roomIndex,
    buildSceneryProfile("electrical", roomIndex, "tier0-electrical-captured-b"),
  ])),
});

function resolveT0TranquilRetailCapturedSceneryProfile(
  weatherType,
  roomIndex,
  layoutVariant = "",
) {
  const normalizedWeatherType = normalizeWeatherType(weatherType);
  const numericRoomIndex = toInt(roomIndex, 0);
  const normalizedLayoutVariant = normalizeWeatherType(layoutVariant);
  const variantProfile = PROFILES_BY_LAYOUT_VARIANT_AND_ROOM[normalizedLayoutVariant] &&
    PROFILES_BY_LAYOUT_VARIANT_AND_ROOM[normalizedLayoutVariant][numericRoomIndex];
  if (variantProfile) {
    return cloneValue(variantProfile);
  }
  const profile =
    PROFILES_BY_WEATHER_AND_ROOM[normalizedWeatherType] &&
    PROFILES_BY_WEATHER_AND_ROOM[normalizedWeatherType][numericRoomIndex];
  return profile ? cloneValue(profile) : null;
}

function resolveGeneratedAuthoredAbyssalSceneryProfile(layoutVariant, roomIndex) {
  const capture = GENERATED_AUTHORED_CAPTURE_BY_LAYOUT_VARIANT.get(
    String(layoutVariant || "").trim().toLowerCase(),
  );
  const profile = capture
    ? buildGeneratedAuthoredSceneryProfile(capture, roomIndex)
    : null;
  return profile ? cloneValue(profile) : null;
}

function isT0TranquilRetailCapturedSceneryProfile(options = {}) {
  return Number(options.tier) === 0 &&
    SUPPORTED_WEATHER_TYPES.includes(
      normalizeWeatherType(options.weatherType || options.weather),
    );
}

module.exports = {
  SCENERY_POLICY_AUTHORITATIVE,
  SUPPORTED_WEATHER_TYPES,
  CAPTURED_LAYOUT_SOURCE_BY_WEATHER,
  CAPTURED_LAYOUT_SOURCE_BY_VARIANT,
  LAYOUT_VARIANT_BY_WEATHER,
  PROFILES_BY_WEATHER_AND_ROOM,
  PROFILES_BY_LAYOUT_VARIANT_AND_ROOM,
  resolveGeneratedAuthoredAbyssalSceneryProfile,
  resolveT0TranquilRetailCapturedSceneryProfile,
  isT0TranquilRetailCapturedSceneryProfile,
};
