"use strict";

const {
  cloneValue,
  deepFreeze,
} = require("../domain/abyssalValueUtils");

const DEV_MENU_SOURCE_IMAGES = Object.freeze([
  "12137.jpg",
  "12138.jpg",
  "12139.jpg",
  "12140.jpg",
  "12141.jpg",
  "12142.jpg",
  "12143.jpg",
]);

const TYPE_EVIDENCE = Object.freeze({
  EVE_REF: "EVE_REF",
  CCP_SDE_LISTING: "CCP_SDE_LISTING",
  DEV_MENU_SCREENSHOT: "DEV_MENU_SCREENSHOT",
  CONTIGUOUS_SDE_INFERENCE: "CONTIGUOUS_SDE_INFERENCE",
});

function buildDungeonCloud(family, dungeonID, name, typeID, graphicID, evidence) {
  return deepFreeze({
    family,
    dungeonID,
    name,
    typeID,
    graphicID,
    groupID: 1980,
    categoryID: 2,
    resource: `res:/dx9/model/celestial/environment/cloud/volumetric/dungeons/${dungeonID}/clouds_${dungeonID}.red`,
    evidence: [...evidence],
  });
}

// The dev menu supplies the dungeon IDs and display names. The asteroid and
// crystal type blocks are present in CCP reference data. The five pillar
// entries occupy the contiguous type/graphic block between those two verified
// families; retain the inference marker until an individual EVE Ref page is
// indexed for each unpublished type.
const T0_DARK_DUNGEON_CLOUDS = deepFreeze([
  buildDungeonCloud("asteroid", 5810, "Canyon", 47656, 22097, [TYPE_EVIDENCE.DEV_MENU_SCREENSHOT, TYPE_EVIDENCE.CCP_SDE_LISTING]),
  buildDungeonCloud("asteroid", 6047, "The Fall", 47657, 22098, [TYPE_EVIDENCE.DEV_MENU_SCREENSHOT, TYPE_EVIDENCE.CCP_SDE_LISTING]),
  buildDungeonCloud("asteroid", 6200, "Rise", 47658, 22099, [TYPE_EVIDENCE.DEV_MENU_SCREENSHOT, TYPE_EVIDENCE.EVE_REF]),
  buildDungeonCloud("asteroid", 6201, "Obelix", 47659, 22100, [TYPE_EVIDENCE.DEV_MENU_SCREENSHOT, TYPE_EVIDENCE.CCP_SDE_LISTING]),
  buildDungeonCloud("asteroid", 6202, "The Belt", 47660, 22101, [TYPE_EVIDENCE.DEV_MENU_SCREENSHOT, TYPE_EVIDENCE.CCP_SDE_LISTING]),
  buildDungeonCloud("pillar", 6048, "Forest Opening", 47661, 22102, [TYPE_EVIDENCE.DEV_MENU_SCREENSHOT, TYPE_EVIDENCE.CONTIGUOUS_SDE_INFERENCE]),
  buildDungeonCloud("pillar", 6049, "The Hill", 47662, 22103, [TYPE_EVIDENCE.DEV_MENU_SCREENSHOT, TYPE_EVIDENCE.CONTIGUOUS_SDE_INFERENCE]),
  buildDungeonCloud("pillar", 6050, "Strike Down", 47663, 22104, [TYPE_EVIDENCE.DEV_MENU_SCREENSHOT, TYPE_EVIDENCE.CONTIGUOUS_SDE_INFERENCE]),
  buildDungeonCloud("pillar", 6051, "Shattered Oak", 47664, 22105, [TYPE_EVIDENCE.DEV_MENU_SCREENSHOT, TYPE_EVIDENCE.CONTIGUOUS_SDE_INFERENCE]),
  buildDungeonCloud("pillar", 6052, "Fallen Forest", 47665, 22106, [TYPE_EVIDENCE.DEV_MENU_SCREENSHOT, TYPE_EVIDENCE.CONTIGUOUS_SDE_INFERENCE]),
  buildDungeonCloud("crystal", 6203, "Crystal 1", 47666, 22107, [TYPE_EVIDENCE.DEV_MENU_SCREENSHOT, TYPE_EVIDENCE.CCP_SDE_LISTING]),
  buildDungeonCloud("crystal", 6204, "Crystal 2", 47667, 22108, [TYPE_EVIDENCE.DEV_MENU_SCREENSHOT, TYPE_EVIDENCE.CCP_SDE_LISTING]),
  buildDungeonCloud("crystal", 6205, "Crystal 3", 47668, 22109, [TYPE_EVIDENCE.DEV_MENU_SCREENSHOT, TYPE_EVIDENCE.CCP_SDE_LISTING]),
  buildDungeonCloud("crystal", 6206, "Crystal 4", 47669, 22110, [TYPE_EVIDENCE.DEV_MENU_SCREENSHOT, TYPE_EVIDENCE.CCP_SDE_LISTING]),
  buildDungeonCloud("crystal", 6207, "Crystal 5", 47670, 22111, [TYPE_EVIDENCE.DEV_MENU_SCREENSHOT, TYPE_EVIDENCE.CCP_SDE_LISTING]),
]);

const T0_DARK_WEATHER_PRESENTATIONS = deepFreeze([
  { stage: 1, typeID: 47378, name: "Darkness Weather 1", evidence: [TYPE_EVIDENCE.DEV_MENU_SCREENSHOT, TYPE_EVIDENCE.CCP_SDE_LISTING] },
  { stage: 2, typeID: 47379, name: "Darkness Weather 2", evidence: [TYPE_EVIDENCE.DEV_MENU_SCREENSHOT, TYPE_EVIDENCE.CCP_SDE_LISTING] },
  { stage: 3, typeID: 47380, name: "Darkness Weather 3", evidence: [TYPE_EVIDENCE.DEV_MENU_SCREENSHOT, TYPE_EVIDENCE.CCP_SDE_LISTING] },
]);

const ABYSSAL_LENS_FLARES = deepFreeze([
  { code: "A30", colour: "black", typeID: 47430, graphicID: 22056, resource: "abyssal_black" },
  { code: "A31", colour: "blue", typeID: 47431, graphicID: 22057, resource: "abyssal_blue" },
  { code: "A32", colour: "orange", typeID: 47432, graphicID: 22058, resource: "abyssal_orange" },
  { code: "A33", colour: "pink", typeID: 47433, graphicID: 22059, resource: "abyssal_pink" },
  { code: "A34", colour: "purple", typeID: 47434, graphicID: 22060, resource: "abyssal_purple" },
  { code: "A35", colour: "white", typeID: 47435, graphicID: 22061, resource: "abyssal_white" },
  { code: "A36", colour: "yellow", typeID: 47760, graphicID: 0, resource: "abyssal_yellow" },
].map((entry) => ({
  ...entry,
  evidence: [TYPE_EVIDENCE.DEV_MENU_SCREENSHOT, TYPE_EVIDENCE.CCP_SDE_LISTING],
})));

function sceneCubeResource(code) {
  const normalizedCode = String(code).trim().toLowerCase();
  const resourceCode = normalizedCode.replace(/^(\d{2})([a-z])$/, "$1_$2");
  return `res:/dx9/scene/abyssal/ad${resourceCode}_cube.red`;
}

const ABYSSAL_NEBULAE = deepFreeze([
  { code: "01A", graphicID: 22041 },
  { code: "02A", graphicID: 22042 },
  { code: "02B", graphicID: 22043 },
  { code: "02C", graphicID: 22044 },
  { code: "03A", graphicID: 22045 },
  { code: "03B", graphicID: 22046 },
  { code: "03C", graphicID: 22047 },
  { code: "04A", graphicID: 22048 },
  { code: "04B", graphicID: 22207 },
  { code: "04C", graphicID: 22208 },
  { code: "05A", graphicID: 22209 },
  { code: "05B", graphicID: 22210 },
  { code: "05C", graphicID: 22211 },
  { code: "06A", graphicID: 22212 },
  { code: "06B", graphicID: 22213 },
  { code: "06C", graphicID: 22214 },
].map((entry) => ({
  ...entry,
  sceneCubeResource: sceneCubeResource(entry.code),
  evidence: [TYPE_EVIDENCE.DEV_MENU_SCREENSHOT],
})));

const T0_DARK_VARIANT_BLUEPRINTS = deepFreeze([
  {
    variantID: "crystal-prism",
    label: "Crystal Prism",
    selectionWeight: 1,
    rooms: [
      { dungeonID: 6203, nebulaCode: "02A", weatherStage: 1, lensCode: "A35", transform: { yawDegrees: 90 } },
      { dungeonID: 6206, nebulaCode: "02B", weatherStage: 2, lensCode: "A35", transform: { yawDegrees: -90, mirrorX: true } },
      { dungeonID: 6207, nebulaCode: "02C", weatherStage: 3, lensCode: "A35", transform: { yawDegrees: 180 } },
    ],
  },
  {
    variantID: "asteroid-ravine",
    label: "Asteroid Ravine",
    selectionWeight: 1,
    rooms: [
      { dungeonID: 5810, nebulaCode: "03A", weatherStage: 1, lensCode: "A30", transform: { mirrorX: true } },
      { dungeonID: 6200, nebulaCode: "03B", weatherStage: 2, lensCode: "A30", transform: { yawDegrees: 120 } },
      { dungeonID: 6202, nebulaCode: "03C", weatherStage: 3, lensCode: "A30", transform: { yawDegrees: 240, mirrorX: true } },
    ],
  },
  {
    variantID: "asteroid-fall",
    label: "Asteroid Fall",
    selectionWeight: 1,
    rooms: [
      { dungeonID: 6047, nebulaCode: "04A", weatherStage: 1, lensCode: "A35", transform: { yawDegrees: 45 } },
      { dungeonID: 6201, nebulaCode: "04B", weatherStage: 2, lensCode: "A35", transform: { yawDegrees: 165, mirrorY: true } },
      { dungeonID: 6200, nebulaCode: "04C", weatherStage: 3, lensCode: "A35", transform: { yawDegrees: 285 } },
    ],
  },
  {
    variantID: "pillar-forest",
    label: "Pillar Forest",
    selectionWeight: 1,
    rooms: [
      { dungeonID: 6048, nebulaCode: "06A", weatherStage: 1, lensCode: "A30", transform: { yawDegrees: 60, mirrorY: true } },
      { dungeonID: 6050, nebulaCode: "06B", weatherStage: 2, lensCode: "A30", transform: { yawDegrees: 180 } },
      { dungeonID: 6052, nebulaCode: "06C", weatherStage: 3, lensCode: "A30", transform: { yawDegrees: 300, mirrorX: true } },
    ],
  },
  {
    variantID: "pillar-heights",
    label: "Pillar Heights",
    selectionWeight: 1,
    rooms: [
      { dungeonID: 6049, nebulaCode: "01A", weatherStage: 1, lensCode: "A35", transform: { yawDegrees: 135 } },
      { dungeonID: 6051, nebulaCode: "05B", weatherStage: 2, lensCode: "A35", transform: { yawDegrees: 255, mirrorX: true } },
      { dungeonID: 6048, nebulaCode: "05C", weatherStage: 3, lensCode: "A35", transform: { yawDegrees: 15, mirrorY: true } },
    ],
  },
]);

function findByNumericField(entries, field, value) {
  const numericValue = Number.parseInt(value, 10);
  const entry = entries.find((candidate) => Number(candidate[field]) === numericValue);
  return entry ? cloneValue(entry) : null;
}

function findByTextField(entries, field, value) {
  const normalized = String(value || "").trim().toUpperCase();
  const entry = entries.find((candidate) => String(candidate[field] || "").toUpperCase() === normalized);
  return entry ? cloneValue(entry) : null;
}

function getT0DarkDungeonCloudByDungeonID(dungeonID) {
  return findByNumericField(T0_DARK_DUNGEON_CLOUDS, "dungeonID", dungeonID);
}

function getT0DarkDungeonCloudByTypeID(typeID) {
  return findByNumericField(T0_DARK_DUNGEON_CLOUDS, "typeID", typeID);
}

function getT0DarkWeatherPresentation(stageOrTypeID) {
  return findByNumericField(T0_DARK_WEATHER_PRESENTATIONS, "stage", stageOrTypeID) ||
    findByNumericField(T0_DARK_WEATHER_PRESENTATIONS, "typeID", stageOrTypeID);
}

function getAbyssalLensFlare(codeOrTypeID) {
  return findByTextField(ABYSSAL_LENS_FLARES, "code", codeOrTypeID) ||
    findByNumericField(ABYSSAL_LENS_FLARES, "typeID", codeOrTypeID);
}

function getAbyssalNebula(codeOrGraphicID) {
  return findByTextField(ABYSSAL_NEBULAE, "code", codeOrGraphicID) ||
    findByNumericField(ABYSSAL_NEBULAE, "graphicID", codeOrGraphicID);
}

function listT0DarkDevMenuCatalog() {
  return {
    sourceImages: [...DEV_MENU_SOURCE_IMAGES],
    dungeonClouds: cloneValue(T0_DARK_DUNGEON_CLOUDS),
    weatherPresentations: cloneValue(T0_DARK_WEATHER_PRESENTATIONS),
    lensFlares: cloneValue(ABYSSAL_LENS_FLARES),
    nebulae: cloneValue(ABYSSAL_NEBULAE),
    variantBlueprints: cloneValue(T0_DARK_VARIANT_BLUEPRINTS),
  };
}

module.exports = {
  DEV_MENU_SOURCE_IMAGES,
  TYPE_EVIDENCE,
  T0_DARK_DUNGEON_CLOUDS,
  T0_DARK_WEATHER_PRESENTATIONS,
  ABYSSAL_LENS_FLARES,
  ABYSSAL_NEBULAE,
  T0_DARK_VARIANT_BLUEPRINTS,
  getT0DarkDungeonCloudByDungeonID,
  getT0DarkDungeonCloudByTypeID,
  getT0DarkWeatherPresentation,
  getAbyssalLensFlare,
  getAbyssalNebula,
  listT0DarkDevMenuCatalog,
};
