"use strict";

const {
  cloneValue,
  deepFreeze,
} = require("../domain/abyssalValueUtils");
const geometryFacts = require("./content/baseRoomGeometryFactsV1.json");

const BASE_ROOM_LAYOUT_SELECTION_SCHEMA_VERSION = 1;
const BASE_ROOM_LAYOUT_CATALOG_VERSION = "abyssal-base-room-layouts-v1";
const BASE_ROOM_LAYOUT_SELECTION_MODEL =
  "deterministic-equal-without-replacement-v1";
const BASE_ROOM_LAYOUT_COUNT_PER_RUN = 3;
const SCENERY_POLICY_AUTHORITATIVE = "authoritative";

const SUPPORTED_BASE_ROOM_LAYOUT_REFS = Object.freeze([
  "layout:6048:99b0eff84c3a9512",
  "layout:6049:fcbd0d674305f8fd",
  "layout:6050:c7174de9ece254bc",
  "layout:6051:90eb75d4af6fc2fb",
  "layout:6052:b6bd809838c7ae22",
  "layout:6203:9a2d3ec7ea3041f3",
  "layout:6204:038675d6b5036e48",
  "layout:6205:1a9f5f1c8e3e5db2",
  "layout:6207:1fd9fef11e3c0a3a",
]);

function toInt(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeText(value, fallback = "") {
  const normalized = String(value == null ? "" : value).trim();
  return normalized || fallback;
}

function normalizeWeatherType(value) {
  return normalizeText(value).toLowerCase();
}

function fnv1a32(value) {
  let hash = 2_166_136_261;
  for (const character of String(value == null ? "" : value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  return hash >>> 0;
}

// Immutable geometry-only capture facts. No tier/weather encounter catalogue is
// consulted when selecting scenery for a new run. Keep v1 bytes stable for recovery.
const BASE_ROOM_LAYOUT_CATALOGUE = deepFreeze(geometryFacts);
const BASE_ROOM_LAYOUT_BY_ID = new Map(
  BASE_ROOM_LAYOUT_CATALOGUE.map((layout) => [layout.layoutID, layout]),
);

function deriveBaseRoomLayoutSelectionSeed(options = {}) {
  return fnv1a32([
    toInt(options.runID, 0),
    toInt(options.filamentTypeID, 0),
    toInt(options.tier, -1),
    normalizeWeatherType(options.weatherType || options.weather),
  ].join(":"));
}

function shuffleLayoutIDs(selectionSeed) {
  const layoutIDs = BASE_ROOM_LAYOUT_CATALOGUE.map((layout) => layout.layoutID);
  let state = selectionSeed >>> 0;
  for (let index = layoutIDs.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const selectedIndex = state % (index + 1);
    [layoutIDs[index], layoutIDs[selectedIndex]] = [
      layoutIDs[selectedIndex],
      layoutIDs[index],
    ];
  }
  return layoutIDs;
}

function selectAbyssalBaseRoomLayouts(options = {}) {
  const selectionSeed = deriveBaseRoomLayoutSelectionSeed(options);
  const selectedLayoutIDs = shuffleLayoutIDs(selectionSeed)
    .slice(0, BASE_ROOM_LAYOUT_COUNT_PER_RUN);
  return {
    success: true,
    data: {
      selectionState: {
        baseRoomLayoutSelectionSchemaVersion:
          BASE_ROOM_LAYOUT_SELECTION_SCHEMA_VERSION,
        baseRoomLayoutCatalogVersion: BASE_ROOM_LAYOUT_CATALOG_VERSION,
        baseRoomLayoutSelectionModel: BASE_ROOM_LAYOUT_SELECTION_MODEL,
        baseRoomLayoutSelectionSeed: selectionSeed,
        selectedBaseRoomLayoutIDs: Object.fromEntries(
          selectedLayoutIDs.map((layoutID, index) => [String(index + 1), layoutID]),
        ),
        baseRoomLayoutSelectionSource: "equal-random-without-replacement",
      },
    },
  };
}

function hasValidSelectedLayoutIDs(source = {}) {
  const selected = source.selectedBaseRoomLayoutIDs;
  if (!selected || typeof selected !== "object") return false;
  const layoutIDs = [1, 2, 3].map((roomIndex) =>
    normalizeText(selected[String(roomIndex)] || selected[roomIndex])
  );
  return layoutIDs.every((layoutID) => BASE_ROOM_LAYOUT_BY_ID.has(layoutID)) &&
    new Set(layoutIDs).size === BASE_ROOM_LAYOUT_COUNT_PER_RUN;
}

function normalizeAbyssalBaseRoomLayoutSelectionState(source = {}, options = {}) {
  if (!hasValidSelectedLayoutIDs(source)) {
    const selection = selectAbyssalBaseRoomLayouts({
      runID: toInt(options.runID, toInt(source.instanceID, 0)),
      filamentTypeID: toInt(
        options.filamentTypeID,
        toInt(source.filamentTypeID, 0),
      ),
      tier: toInt(options.tier, toInt(source.tier, -1)),
      weatherType: normalizeWeatherType(
        options.weatherType || source.weatherType,
      ),
    });
    return selection.data.selectionState;
  }
  return {
    baseRoomLayoutSelectionSchemaVersion:
      BASE_ROOM_LAYOUT_SELECTION_SCHEMA_VERSION,
    baseRoomLayoutCatalogVersion: BASE_ROOM_LAYOUT_CATALOG_VERSION,
    baseRoomLayoutSelectionModel: normalizeText(
      source.baseRoomLayoutSelectionModel,
      BASE_ROOM_LAYOUT_SELECTION_MODEL,
    ),
    baseRoomLayoutSelectionSeed:
      toInt(source.baseRoomLayoutSelectionSeed, 0) >>> 0,
    selectedBaseRoomLayoutIDs: Object.fromEntries([1, 2, 3].map((roomIndex) => [
      String(roomIndex),
      normalizeText(
        source.selectedBaseRoomLayoutIDs[String(roomIndex)] ||
          source.selectedBaseRoomLayoutIDs[roomIndex],
      ),
    ])),
    baseRoomLayoutSelectionSource: normalizeText(
      source.baseRoomLayoutSelectionSource,
      "recovered",
    ),
  };
}

function resolveSelectedAbyssalBaseRoomLayoutID(source = {}, roomIndex = 1) {
  const selected = source.selectedBaseRoomLayoutIDs;
  return normalizeText(
    selected && (selected[String(roomIndex)] || selected[roomIndex]),
  );
}

function resolveAbyssalBaseRoomSceneryProfile(
  roomLayoutID,
  requestedWeatherType = "",
) {
  const layout = BASE_ROOM_LAYOUT_BY_ID.get(normalizeText(roomLayoutID));
  if (!layout) return null;
  const weatherType = normalizeWeatherType(requestedWeatherType);
  return cloneValue({
    profileID: `abyssal:base-room-layout:${layout.dungeonID}:props-v1`,
    layoutID: layout.layoutID,
    layoutVariant: BASE_ROOM_LAYOUT_CATALOG_VERSION,
    evidenceStatus: "CAPTURED_RETAIL_LAYOUT_BASE",
    sceneryPolicy: SCENERY_POLICY_AUTHORITATIVE,
    capturedRetailProfile: true,
    capturedRetailBaseProfile: true,
    sourceWeatherType: layout.sourceWeatherType,
    requestedWeatherType: weatherType,
    sourceFile: layout.sourceFile,
    sourceCaptureKeys: layout.sourceCaptureKeys,
    capturedBallCount: layout.capturedBallCount,
    maxEntries: layout.entries.length,
    entries: layout.entries.map((entry) => ({
      ...entry,
      identity: {
        identityPolicy: "captured-retail-layout-base",
        namePolicy: "type-derived",
      },
      sourceEvidence: {
        ...entry.sourceEvidence,
        requestedWeatherType: weatherType,
      },
    })),
  });
}

function listAbyssalBaseRoomLayouts() {
  return cloneValue(BASE_ROOM_LAYOUT_CATALOGUE);
}

module.exports = {
  BASE_ROOM_LAYOUT_SELECTION_SCHEMA_VERSION,
  BASE_ROOM_LAYOUT_CATALOG_VERSION,
  BASE_ROOM_LAYOUT_SELECTION_MODEL,
  BASE_ROOM_LAYOUT_COUNT_PER_RUN,
  SUPPORTED_BASE_ROOM_LAYOUT_REFS,
  deriveBaseRoomLayoutSelectionSeed,
  listAbyssalBaseRoomLayouts,
  normalizeAbyssalBaseRoomLayoutSelectionState,
  resolveAbyssalBaseRoomSceneryProfile,
  resolveSelectedAbyssalBaseRoomLayoutID,
  selectAbyssalBaseRoomLayouts,
};
