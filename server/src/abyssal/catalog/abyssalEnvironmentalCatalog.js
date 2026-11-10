"use strict";

const {
  resolveAbyssalEnvironmentRoomProfile,
} = require("./abyssalEnvironmentProfiles");
const {
  isT0DarkRetailCapturedProfile,
} = require("./t0DarkRetailCapturedLayout");
const {
  resolveSelectedT0DarkRoom,
} = require("./t0DarkLayoutCatalog");
const {
  T0_DARK_DUNGEON_CLOUDS,
  T0_DARK_WEATHER_PRESENTATIONS,
  ABYSSAL_LENS_FLARES,
} = require("./t0DarkDevMenuCatalog");
const {
  getDarkWeatherStage,
  getDarkWeatherStageByTypeID,
} = require("./abyssalDarkWeatherCatalog");
const {
  MEDIUM_RANGE_SUPPRESSOR_MECHANICS_PROFILE,
  SHORT_RANGE_SUPPRESSOR_MECHANICS_PROFILE,
} = require("./abyssalSuppressorMechanicsProfile");
const {
  MEDIUM_RANGE_SUPPRESSOR_FX_PROFILE_ID,
  SHORT_RANGE_SUPPRESSOR_FX_PROFILE_ID,
} = require("./abyssalSuppressorPresentationProfile");
const {
  UNSTABLE_ABYSSAL_DEPTHS_BOUNDARY_PROFILE,
} = require("../domain/abyssalBoundaryProfile");
const {
  ABYSSAL_CONTENT_AUTHORITY,
} = require("./abyssalContentAuthority");
const { isProceduralEnvironment, buildProceduralEnvironmentalObjects } = require("./abyssalProceduralEnvironment");

const ENVIRONMENTAL_EFFECT_KIND = Object.freeze({
  DECORATIVE: "decorative",
  BOUNDARY_PRESENTATION: "boundary_presentation",
  BOUNDARY_DAMAGE: "boundary_damage",
  WEATHER_PRESENTATION: "weather_presentation",
  LOCALIZED_MODIFIER: "localized_modifier",
  POINT_DEFENSE: "point_defense",
  UNKNOWN_DISABLED: "unknown_disabled",
});

const ENVIRONMENTAL_EVIDENCE = Object.freeze({
  RETAIL_CONFIRMED: "RETAIL_CONFIRMED",
  ENGINE_AND_RETAIL: "ENGINE_AND_RETAIL",
  ENGINE_ONLY: "ENGINE_ONLY",
  INFERRED: "INFERRED",
  UNKNOWN: "UNKNOWN",
});

const TYPE_PLAYER_SPAWN_LOCATION = 52567;
const TYPE_ABYSSAL_PERIMETER_LIGHTS = 54196;
const TYPE_SMALL_CRYSTAL_ENVIRONMENT_4 = 47940;
const TYPE_TRIGLAVIAN_TRIPLEX_EXTRACTION_CLUSTER = 49691;
const TYPE_CAPTURED_ABYSSAL_LENS_FLARE = 47435;
const TYPE_SHORT_RANGE_DEVIANT_AUTOMATA_SUPPRESSOR = 47437;
const TYPE_MEDIUM_RANGE_DEVIANT_AUTOMATA_SUPPRESSOR = 47438;
const TYPE_SHORT_RANGE_MULTIBODY_TRACKING_PYLON = 47469;
const TYPE_MEDIUM_RANGE_MULTIBODY_TRACKING_PYLON = 47470;
const TYPE_UNSTABLE_ABYSSAL_DEPTHS = 47465;
const TYPE_LARGE_FILAMENT_CLOUD = 47473;
const TYPE_DARK_WEATHER_PRESENTATION = 47378;
const TYPE_CRYSTAL_DUNGEON_CLOUD_6204 = 47667;
const TYPE_CRYSTAL_DUNGEON_CLOUD_6205 = 47668;
const TYPE_CRYSTAL_DUNGEON_CLOUD_6207 = 47670;
const PERIMETER_LOOK_GOLD = 4;

const TRACKING_PYLON_AUTHORITY_FACETS = Object.freeze({
  objectIdentity: Object.freeze({
    contentAuthority: ABYSSAL_CONTENT_AUTHORITY.OBSERVED_EMPIRICAL,
    evidenceModel: "retail-observation-and-static-type-identity",
  }),
  mechanics: Object.freeze({
    contentAuthority: ABYSSAL_CONTENT_AUTHORITY.CAPTURED_RETAIL,
    evidenceModel: "static-dogma-and-captured-active-field-effect",
  }),
  placement: Object.freeze({
    contentAuthority: ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
    placementModel: "resolved-room-record",
    retailExact: false,
  }),
  spawnSelection: Object.freeze({
    contentAuthority: ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
    probabilityModel: "current-runtime-selection-policy",
    retailProbabilityKnown: false,
  }),
});

const CAPTURED_LOCALIZED_PRESENTATION_OBJECTS = Object.freeze([
  Object.freeze({
    profileID: "abyssal:environment:medium-bioluminescence-cloud",
    typeID: 47440,
    name: "Medium Bioluminescence Cloud",
  }),
  Object.freeze({
    profileID: "abyssal:environment:large-bioluminescence-cloud",
    typeID: 47441,
    name: "Large Bioluminescence Cloud",
  }),
  Object.freeze({
    profileID: "abyssal:environment:background-planet-sandstorm",
    typeID: 47452,
    name: "Background planet Sandstorm",
  }),
  Object.freeze({
    profileID: "abyssal:environment:medium-caustic-cloud",
    typeID: 47467,
    name: "Medium Caustic Cloud",
  }),
  Object.freeze({
    profileID: "abyssal:environment:large-caustic-cloud",
    typeID: 47468,
    name: "Large Caustic Cloud",
  }),
  Object.freeze({
    profileID: "abyssal:environment:medium-filament-cloud",
    typeID: 47472,
    name: "Medium Filament Cloud",
  }),
]);

const T0_TRANQUIL_NON_DARK_WEATHER_PRESENTATIONS = Object.freeze([
  Object.freeze({
    weatherType: "electrical",
    stage: 1,
    typeID: 47381,
    name: "Electrical Storm Weather 1",
    evidence: ENVIRONMENTAL_EVIDENCE.RETAIL_CONFIRMED,
  }),
  Object.freeze({
    weatherType: "electrical",
    stage: 2,
    typeID: 47382,
    name: "Electrical Storm Weather 2",
    evidence: ENVIRONMENTAL_EVIDENCE.ENGINE_ONLY,
  }),
  Object.freeze({
    weatherType: "electrical",
    stage: 3,
    typeID: 47383,
    name: "Electrical Storm Weather 3",
    evidence: ENVIRONMENTAL_EVIDENCE.ENGINE_ONLY,
  }),
  Object.freeze({
    weatherType: "exotic",
    stage: 1,
    typeID: 47384,
    name: "Caustic Toxin Weather 1",
    evidence: ENVIRONMENTAL_EVIDENCE.ENGINE_ONLY,
  }),
  Object.freeze({
    weatherType: "exotic",
    stage: 2,
    typeID: 47385,
    name: "Caustic Toxin Weather 2",
    evidence: ENVIRONMENTAL_EVIDENCE.ENGINE_ONLY,
  }),
  Object.freeze({
    weatherType: "exotic",
    stage: 3,
    typeID: 47386,
    name: "Caustic Toxin Weather 3",
    evidence: ENVIRONMENTAL_EVIDENCE.ENGINE_ONLY,
  }),
  Object.freeze({
    weatherType: "gamma",
    stage: 1,
    typeID: 47387,
    name: "Xenon Gas Weather 1",
    evidence: ENVIRONMENTAL_EVIDENCE.RETAIL_CONFIRMED,
  }),
  Object.freeze({
    weatherType: "gamma",
    stage: 2,
    typeID: 47388,
    name: "Xenon Gas Weather 2",
    evidence: ENVIRONMENTAL_EVIDENCE.ENGINE_ONLY,
  }),
  Object.freeze({
    weatherType: "gamma",
    stage: 3,
    typeID: 47389,
    name: "Xenon Gas Weather 3",
    evidence: ENVIRONMENTAL_EVIDENCE.ENGINE_ONLY,
  }),
  Object.freeze({
    weatherType: "firestorm",
    stage: 1,
    typeID: 47390,
    name: "Infernal Weather 1",
    evidence: ENVIRONMENTAL_EVIDENCE.RETAIL_CONFIRMED,
  }),
  Object.freeze({
    weatherType: "firestorm",
    stage: 2,
    typeID: 47391,
    name: "Infernal Weather 2",
    evidence: ENVIRONMENTAL_EVIDENCE.ENGINE_ONLY,
  }),
  Object.freeze({
    weatherType: "firestorm",
    stage: 3,
    typeID: 47392,
    name: "Infernal Weather 3",
    evidence: ENVIRONMENTAL_EVIDENCE.ENGINE_ONLY,
  }),
]);

const ABYSSAL_ENVIRONMENTAL_DEFINITIONS = Object.freeze({
  "abyssal:environment:captured-lens-flare": Object.freeze({
    profileID: "abyssal:environment:captured-lens-flare",
    typeID: TYPE_CAPTURED_ABYSSAL_LENS_FLARE,
    effectKind: ENVIRONMENTAL_EFFECT_KIND.DECORATIVE,
    presentationEnabled: true,
    mechanicsEnabled: false,
    evidence: ENVIRONMENTAL_EVIDENCE.RETAIL_CONFIRMED,
    notes: "Captured A_35 Abyssal lens-flare presentation; no server mechanics.",
  }),
  "abyssal:environment:player-spawn-location": Object.freeze({
    profileID: "abyssal:environment:player-spawn-location",
    typeID: TYPE_PLAYER_SPAWN_LOCATION,
    effectKind: ENVIRONMENTAL_EFFECT_KIND.DECORATIVE,
    presentationEnabled: true,
    mechanicsEnabled: false,
    evidence: ENVIRONMENTAL_EVIDENCE.RETAIL_CONFIRMED,
  }),
  "abyssal:environment:perimeter-lights": Object.freeze({
    profileID: "abyssal:environment:perimeter-lights",
    typeID: TYPE_ABYSSAL_PERIMETER_LIGHTS,
    effectKind: ENVIRONMENTAL_EFFECT_KIND.BOUNDARY_PRESENTATION,
    presentationEnabled: true,
    mechanicsEnabled: false,
    identity: Object.freeze({
      identityPolicy: "captured-retail",
      presentationOwnerID: 1,
      namePolicy: "type-derived",
      retailFieldPresence: Object.freeze({
        corporationID: "missing",
        allianceID: "missing",
        warFactionID: "missing",
        charID: "missing",
      }),
    }),
    perimeterRadius: 7_500,
    perimeterLook: PERIMETER_LOOK_GOLD,
    evidence: ENVIRONMENTAL_EVIDENCE.ENGINE_AND_RETAIL,
    notes:
      "Retail-captured 7.5 km conduit activation indicator with the supported gold look selected for visibility; it does not define the room damage boundary.",
  }),
  "abyssal:environment:small-crystal-environment-4": Object.freeze({
    profileID: "abyssal:environment:small-crystal-environment-4",
    typeID: TYPE_SMALL_CRYSTAL_ENVIRONMENT_4,
    effectKind: ENVIRONMENTAL_EFFECT_KIND.DECORATIVE,
    mechanicsEnabled: false,
    evidence: ENVIRONMENTAL_EVIDENCE.RETAIL_CONFIRMED,
  }),
  "abyssal:environment:triplex-extraction-cluster": Object.freeze({
    profileID: "abyssal:environment:triplex-extraction-cluster",
    typeID: TYPE_TRIGLAVIAN_TRIPLEX_EXTRACTION_CLUSTER,
    effectKind: ENVIRONMENTAL_EFFECT_KIND.DECORATIVE,
    mechanicsEnabled: false,
    evidence: ENVIRONMENTAL_EVIDENCE.RETAIL_CONFIRMED,
  }),
  ...Object.fromEntries(CAPTURED_LOCALIZED_PRESENTATION_OBJECTS.map((entry) => [
    entry.profileID,
    Object.freeze({
      profileID: entry.profileID,
      typeID: entry.typeID,
      effectKind: ENVIRONMENTAL_EFFECT_KIND.DECORATIVE,
      presentationEnabled: true,
      mechanicsEnabled: false,
      evidence: ENVIRONMENTAL_EVIDENCE.RETAIL_CONFIRMED,
      notes:
        `${entry.name} uses its selected captured room-local transform; ` +
        "localized cloud mechanics are not implemented.",
    }),
  ])),
  "abyssal:environment:automata-suppressor": Object.freeze({
    profileID: "abyssal:environment:automata-suppressor",
    typeID: TYPE_MEDIUM_RANGE_DEVIANT_AUTOMATA_SUPPRESSOR,
    effectKind: ENVIRONMENTAL_EFFECT_KIND.POINT_DEFENSE,
    presentationEnabled: true,
    mechanicsEnabled: true,
    destructible: true,
    mechanicsProfileID: MEDIUM_RANGE_SUPPRESSOR_MECHANICS_PROFILE.profileID,
    presentationProfileID: MEDIUM_RANGE_SUPPRESSOR_FX_PROFILE_ID,
    presentationRadiusMeters:
      MEDIUM_RANGE_SUPPRESSOR_MECHANICS_PROFILE.presentationRadiusMeters,
    mechanicsRangeMeters:
      MEDIUM_RANGE_SUPPRESSOR_MECHANICS_PROFILE.mechanicsRangeMeters,
    radiusMeters: MEDIUM_RANGE_SUPPRESSOR_MECHANICS_PROFILE.mechanicsRangeMeters,
    activationDurationMs:
      MEDIUM_RANGE_SUPPRESSOR_MECHANICS_PROFILE.activationDurationMs,
    dogmaEffectID: MEDIUM_RANGE_SUPPRESSOR_MECHANICS_PROFILE.dogmaEffectID,
    targetTypeListID: MEDIUM_RANGE_SUPPRESSOR_MECHANICS_PROFILE.targetTypeListID,
    damage: MEDIUM_RANGE_SUPPRESSOR_MECHANICS_PROFILE.damage,
    resolvedTargetClasses:
      MEDIUM_RANGE_SUPPRESSOR_MECHANICS_PROFILE.resolvedTargetClasses,
    evidence: ENVIRONMENTAL_EVIDENCE.ENGINE_AND_RETAIL,
    notes: "Retail-captured presentation with independently resolved run-scoped effect-7057 mechanics for type 47438.",
  }),
  "abyssal:environment:short-range-automata-suppressor": Object.freeze({
    profileID: "abyssal:environment:short-range-automata-suppressor",
    typeID: TYPE_SHORT_RANGE_DEVIANT_AUTOMATA_SUPPRESSOR,
    effectKind: ENVIRONMENTAL_EFFECT_KIND.POINT_DEFENSE,
    presentationEnabled: true,
    mechanicsEnabled: true,
    destructible: true,
    mechanicsProfileID: SHORT_RANGE_SUPPRESSOR_MECHANICS_PROFILE.profileID,
    presentationProfileID: SHORT_RANGE_SUPPRESSOR_FX_PROFILE_ID,
    presentationRadiusMeters:
      SHORT_RANGE_SUPPRESSOR_MECHANICS_PROFILE.presentationRadiusMeters,
    mechanicsRangeMeters:
      SHORT_RANGE_SUPPRESSOR_MECHANICS_PROFILE.mechanicsRangeMeters,
    radiusMeters: SHORT_RANGE_SUPPRESSOR_MECHANICS_PROFILE.mechanicsRangeMeters,
    activationDurationMs:
      SHORT_RANGE_SUPPRESSOR_MECHANICS_PROFILE.activationDurationMs,
    dogmaEffectID: SHORT_RANGE_SUPPRESSOR_MECHANICS_PROFILE.dogmaEffectID,
    targetTypeListID: SHORT_RANGE_SUPPRESSOR_MECHANICS_PROFILE.targetTypeListID,
    damage: SHORT_RANGE_SUPPRESSOR_MECHANICS_PROFILE.damage,
    resolvedTargetClasses:
      SHORT_RANGE_SUPPRESSOR_MECHANICS_PROFILE.resolvedTargetClasses,
    evidence: ENVIRONMENTAL_EVIDENCE.ENGINE_AND_RETAIL,
    notes: "Retail-captured presentation with run-scoped effect-7057 mechanics for type 47437.",
  }),
  "abyssal:environment:unstable-depths": Object.freeze({
    profileID: "abyssal:environment:unstable-depths",
    typeID: TYPE_UNSTABLE_ABYSSAL_DEPTHS,
    effectKind: ENVIRONMENTAL_EFFECT_KIND.BOUNDARY_DAMAGE,
    presentationEnabled: true,
    mechanicsEnabled: true,
    mechanicsProfileID: UNSTABLE_ABYSSAL_DEPTHS_BOUNDARY_PROFILE.profileID,
    sourceName: UNSTABLE_ABYSSAL_DEPTHS_BOUNDARY_PROFILE.sourceName,
    tickIntervalMs: UNSTABLE_ABYSSAL_DEPTHS_BOUNDARY_PROFILE.tickIntervalMs,
    presentationRadiusMeters:
      UNSTABLE_ABYSSAL_DEPTHS_BOUNDARY_PROFILE.perimeterRadiusMeters,
    evidence: ENVIRONMENTAL_EVIDENCE.ENGINE_AND_RETAIL,
    notes:
      "The client boundary-bubble resource is scaled to the 75 km room radius. One-second source attribution is retail-captured; the linear applied-damage curve is derived from the capture. Raw damage type and fixed lethal distance remain unknown.",
  }),
  "abyssal:environment:large-filament-cloud": Object.freeze({
    profileID: "abyssal:environment:large-filament-cloud",
    typeID: TYPE_LARGE_FILAMENT_CLOUD,
    effectKind: ENVIRONMENTAL_EFFECT_KIND.LOCALIZED_MODIFIER,
    presentationEnabled: true,
    mechanicsEnabled: true,
    radiusMeters: 40_000,
    affectedEntityKinds: Object.freeze(["ship"]),
    dbuffCollectionValues: Object.freeze([
      Object.freeze({ collectionID: 88, value: -30 }),
      Object.freeze({ collectionID: 89, value: -30 }),
    ]),
    evidence: ENVIRONMENTAL_EVIDENCE.ENGINE_AND_RETAIL,
    notes: "Type-47473 static dogma: 40 km continuous dbuff collections 88/89 at -30; applied to ships while inside the cloud.",
  }),
  "abyssal:environment:short-range-multibody-tracking-pylon": Object.freeze({
    profileID: "abyssal:environment:short-range-multibody-tracking-pylon",
    typeID: TYPE_SHORT_RANGE_MULTIBODY_TRACKING_PYLON,
    effectKind: ENVIRONMENTAL_EFFECT_KIND.LOCALIZED_MODIFIER,
    presentationEnabled: true,
    mechanicsEnabled: true,
    destructible: true,
    radiusMeters: 15_000,
    dogmaEffectID: 7053,
    affectedEntityKinds: Object.freeze(["ship", "drone", "fighter"]),
    dbuffCollectionValues: Object.freeze([
      Object.freeze({ collectionID: 84, value: 80 }),
    ]),
    authorityFacets: TRACKING_PYLON_AUTHORITY_FACETS,
    evidence: ENVIRONMENTAL_EVIDENCE.ENGINE_AND_RETAIL,
    notes:
      "Type-47469 static dogma: effect 7053 applies dbuff collection 84 at +80 inside 15 km. Mechanics authority is independent from room-placement and spawn-selection authority.",
  }),
  "abyssal:environment:medium-range-multibody-tracking-pylon": Object.freeze({
    profileID: "abyssal:environment:medium-range-multibody-tracking-pylon",
    typeID: TYPE_MEDIUM_RANGE_MULTIBODY_TRACKING_PYLON,
    effectKind: ENVIRONMENTAL_EFFECT_KIND.LOCALIZED_MODIFIER,
    presentationEnabled: true,
    mechanicsEnabled: true,
    destructible: true,
    radiusMeters: 40_000,
    dogmaEffectID: 7053,
    affectedEntityKinds: Object.freeze(["ship", "drone", "fighter"]),
    dbuffCollectionValues: Object.freeze([
      Object.freeze({ collectionID: 84, value: 60 }),
    ]),
    authorityFacets: TRACKING_PYLON_AUTHORITY_FACETS,
    evidence: ENVIRONMENTAL_EVIDENCE.ENGINE_AND_RETAIL,
    notes:
      "Type-47470 static dogma: effect 7053 applies dbuff collection 84 at +60 inside 40 km. Mechanics authority is independent from room-placement and spawn-selection authority.",
  }),
  "abyssal:environment:dark-weather-presentation": Object.freeze({
    profileID: "abyssal:environment:dark-weather-presentation",
    typeID: TYPE_DARK_WEATHER_PRESENTATION,
    effectKind: ENVIRONMENTAL_EFFECT_KIND.WEATHER_PRESENTATION,
    presentationEnabled: true,
    mechanicsEnabled: false,
    evidence: ENVIRONMENTAL_EVIDENCE.RETAIL_CONFIRMED,
    notes: "Retail-captured Dark weather room object; dogma and hazard mechanics remain disabled.",
  }),
  "abyssal:environment:crystal-dungeon-cloud-6204": Object.freeze({
    profileID: "abyssal:environment:crystal-dungeon-cloud-6204",
    typeID: TYPE_CRYSTAL_DUNGEON_CLOUD_6204,
    effectKind: ENVIRONMENTAL_EFFECT_KIND.DECORATIVE,
    presentationEnabled: true,
    mechanicsEnabled: false,
    evidence: ENVIRONMENTAL_EVIDENCE.RETAIL_CONFIRMED,
    notes: "Retail room-local non-scalable cloud object that resolves clouds_6204.red.",
  }),
  "abyssal:environment:crystal-dungeon-cloud-6205": Object.freeze({
    profileID: "abyssal:environment:crystal-dungeon-cloud-6205",
    typeID: TYPE_CRYSTAL_DUNGEON_CLOUD_6205,
    effectKind: ENVIRONMENTAL_EFFECT_KIND.DECORATIVE,
    presentationEnabled: true,
    mechanicsEnabled: false,
    evidence: ENVIRONMENTAL_EVIDENCE.RETAIL_CONFIRMED,
    notes: "Retail room-local non-scalable cloud object that resolves clouds_6205.red.",
  }),
  "abyssal:environment:crystal-dungeon-cloud-6207": Object.freeze({
    profileID: "abyssal:environment:crystal-dungeon-cloud-6207",
    typeID: TYPE_CRYSTAL_DUNGEON_CLOUD_6207,
    effectKind: ENVIRONMENTAL_EFFECT_KIND.DECORATIVE,
    presentationEnabled: true,
    mechanicsEnabled: false,
    evidence: ENVIRONMENTAL_EVIDENCE.RETAIL_CONFIRMED,
    notes: "Retail room-local non-scalable cloud object that resolves clouds_6207.red.",
  }),
  ...Object.fromEntries(T0_DARK_DUNGEON_CLOUDS.map((cloud) => {
    const profileID = `abyssal:environment:${cloud.family}-dungeon-cloud-${cloud.dungeonID}`;
    return [profileID, Object.freeze({
      profileID,
      typeID: cloud.typeID,
      effectKind: ENVIRONMENTAL_EFFECT_KIND.DECORATIVE,
      presentationEnabled: true,
      mechanicsEnabled: false,
      evidence: [6204, 6205, 6207].includes(cloud.dungeonID)
        ? ENVIRONMENTAL_EVIDENCE.RETAIL_CONFIRMED
        : cloud.evidence.includes("CONTIGUOUS_SDE_INFERENCE")
          ? ENVIRONMENTAL_EVIDENCE.INFERRED
          : ENVIRONMENTAL_EVIDENCE.ENGINE_ONLY,
      notes: `Tier 0 dev-menu dungeon cloud ${cloud.dungeonID} (${cloud.name}); presentation only.`,
    })];
  })),
  ...Object.fromEntries(T0_DARK_WEATHER_PRESENTATIONS.map((weather) => {
    const profileID = `abyssal:environment:dark-weather-presentation-${weather.stage}`;
    return [profileID, Object.freeze({
      profileID,
      typeID: weather.typeID,
      effectKind: ENVIRONMENTAL_EFFECT_KIND.WEATHER_PRESENTATION,
      presentationEnabled: true,
      mechanicsEnabled: false,
      evidence: weather.stage === 1
        ? ENVIRONMENTAL_EVIDENCE.RETAIL_CONFIRMED
        : ENVIRONMENTAL_EVIDENCE.ENGINE_ONLY,
      notes: `${weather.name}; the Dark weather mechanics continue to come from the filament profile.`,
    })];
  })),
  ...Object.fromEntries(T0_TRANQUIL_NON_DARK_WEATHER_PRESENTATIONS.map((weather) => {
    const profileID =
      `abyssal:environment:${weather.weatherType}-weather-presentation-${weather.stage}`;
    return [profileID, Object.freeze({
      profileID,
      typeID: weather.typeID,
      effectKind: ENVIRONMENTAL_EFFECT_KIND.WEATHER_PRESENTATION,
      presentationEnabled: true,
      mechanicsEnabled: false,
      evidence: weather.evidence,
      notes: `${weather.name}; weather mechanics come from the filament profile.`,
    })];
  })),
  ...Object.fromEntries(ABYSSAL_LENS_FLARES.map((lens) => {
    const profileID = `abyssal:environment:lens-flare-${lens.code.toLowerCase()}`;
    return [profileID, Object.freeze({
      profileID,
      typeID: lens.typeID,
      effectKind: ENVIRONMENTAL_EFFECT_KIND.DECORATIVE,
      presentationEnabled: true,
      mechanicsEnabled: false,
      evidence: lens.code === "A35"
        ? ENVIRONMENTAL_EVIDENCE.RETAIL_CONFIRMED
        : ENVIRONMENTAL_EVIDENCE.ENGINE_ONLY,
      notes: `Abyssal Content Tool lens flare ${lens.code} (${lens.colour}); presentation only.`,
    })];
  })),
});

const ROOM_ENVIRONMENTAL_LAYOUTS = Object.freeze({
  1: Object.freeze([
    Object.freeze({
      slot: 1,
      profileID: "abyssal:environment:unstable-depths",
      sourceRole: "depth_boundary_object",
      offset: Object.freeze({ x: 0, y: 0, z: 0 }),
      rotation: Object.freeze([0, 0, 0]),
    }),
    Object.freeze({
      slot: 2,
      profileID: "abyssal:environment:player-spawn-location",
      sourceRole: "player_insertion_locator",
      offset: Object.freeze({ x: 0, y: 0, z: 0 }),
      rotation: Object.freeze([0, 0, 0]),
    }),
    Object.freeze({
      slot: 3,
      profileID: "abyssal:environment:perimeter-lights",
      sourceRole: "environmental_perimeter",
      offset: Object.freeze({ x: 0, y: 0, z: 0 }),
      rotation: Object.freeze([0, 0, 0]),
    }),
  ]),
  2: Object.freeze([
    Object.freeze({
      slot: 1,
      profileID: "abyssal:environment:unstable-depths",
      sourceRole: "depth_boundary_object",
      offset: Object.freeze({ x: 0, y: 0, z: 0 }),
      rotation: Object.freeze([0, 0, 0]),
    }),
    Object.freeze({
      slot: 2,
      profileID: "abyssal:environment:player-spawn-location",
      sourceRole: "player_insertion_locator",
      offset: Object.freeze({ x: 0, y: 0, z: 0 }),
      rotation: Object.freeze([0, 0, 0]),
    }),
    Object.freeze({
      slot: 3,
      profileID: "abyssal:environment:perimeter-lights",
      sourceRole: "environmental_perimeter",
      offset: Object.freeze({ x: 0, y: 0, z: 0 }),
      rotation: Object.freeze([0, 0, 0]),
    }),
  ]),
  3: Object.freeze([
    Object.freeze({
      slot: 1,
      profileID: "abyssal:environment:unstable-depths",
      sourceRole: "depth_boundary_object",
      offset: Object.freeze({ x: 0, y: 0, z: 0 }),
      rotation: Object.freeze([0, 0, 0]),
    }),
    Object.freeze({
      slot: 2,
      profileID: "abyssal:environment:player-spawn-location",
      sourceRole: "player_insertion_locator",
      offset: Object.freeze({ x: 0, y: 0, z: 0 }),
      rotation: Object.freeze([0, 0, 0]),
    }),
    Object.freeze({
      slot: 3,
      profileID: "abyssal:environment:perimeter-lights",
      sourceRole: "environmental_perimeter",
      offset: Object.freeze({ x: 0, y: 0, z: 0 }),
      rotation: Object.freeze([0, 0, 0]),
    }),
  ]),
});

function toInt(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function cloneVector(value) {
  return {
    x: Number(value && value.x) || 0,
    y: Number(value && value.y) || 0,
    z: Number(value && value.z) || 0,
  };
}

function cloneRotation(value) {
  return Array.isArray(value) && value.length === 3
    ? value.map((entry) => Number(entry) || 0)
    : [0, 0, 0];
}

function getAbyssalEnvironmentalDefinition(profileID) {
  return ABYSSAL_ENVIRONMENTAL_DEFINITIONS[String(profileID || "")] || null;
}

function listAbyssalEnvironmentalDefinitions() {
  return Object.values(ABYSSAL_ENVIRONMENTAL_DEFINITIONS);
}

function listT0TranquilWeatherPresentationStages(weatherType) {
  const normalizedWeatherType = String(weatherType || "").trim().toLowerCase();
  if (normalizedWeatherType === "dark") {
    return T0_DARK_WEATHER_PRESENTATIONS.map((weather) => ({
      ...weather,
      weatherType: "dark",
      evidence: weather.stage === 1
        ? ENVIRONMENTAL_EVIDENCE.RETAIL_CONFIRMED
        : ENVIRONMENTAL_EVIDENCE.ENGINE_ONLY,
    }));
  }
  return T0_TRANQUIL_NON_DARK_WEATHER_PRESENTATIONS
    .filter((weather) => weather.weatherType === normalizedWeatherType)
    .map((weather) => ({ ...weather }));
}

function canonicalEnvironmentProfileMapping(typeID, profileID) {
  return Object.freeze({ typeID: toInt(typeID, 0), profileID: String(profileID || "") });
}

const CANONICAL_ENVIRONMENT_PROFILE_MAPPINGS = Object.freeze([
  ...CAPTURED_LOCALIZED_PRESENTATION_OBJECTS.map((entry) =>
    canonicalEnvironmentProfileMapping(entry.typeID, entry.profileID)
  ),
  canonicalEnvironmentProfileMapping(
    TYPE_SHORT_RANGE_DEVIANT_AUTOMATA_SUPPRESSOR,
    "abyssal:environment:short-range-automata-suppressor",
  ),
  canonicalEnvironmentProfileMapping(
    TYPE_MEDIUM_RANGE_DEVIANT_AUTOMATA_SUPPRESSOR,
    "abyssal:environment:automata-suppressor",
  ),
  canonicalEnvironmentProfileMapping(
    TYPE_SHORT_RANGE_MULTIBODY_TRACKING_PYLON,
    "abyssal:environment:short-range-multibody-tracking-pylon",
  ),
  canonicalEnvironmentProfileMapping(
    TYPE_MEDIUM_RANGE_MULTIBODY_TRACKING_PYLON,
    "abyssal:environment:medium-range-multibody-tracking-pylon",
  ),
  canonicalEnvironmentProfileMapping(
    TYPE_UNSTABLE_ABYSSAL_DEPTHS,
    "abyssal:environment:unstable-depths",
  ),
  canonicalEnvironmentProfileMapping(
    TYPE_LARGE_FILAMENT_CLOUD,
    "abyssal:environment:large-filament-cloud",
  ),
  canonicalEnvironmentProfileMapping(
    TYPE_PLAYER_SPAWN_LOCATION,
    "abyssal:environment:player-spawn-location",
  ),
  canonicalEnvironmentProfileMapping(
    TYPE_ABYSSAL_PERIMETER_LIGHTS,
    "abyssal:environment:perimeter-lights",
  ),
  ...T0_DARK_DUNGEON_CLOUDS.map((cloud) => canonicalEnvironmentProfileMapping(
    cloud.typeID,
    `abyssal:environment:${cloud.family}-dungeon-cloud-${cloud.dungeonID}`,
  )),
  ...T0_DARK_WEATHER_PRESENTATIONS.map((weather) => canonicalEnvironmentProfileMapping(
    weather.typeID,
    `abyssal:environment:dark-weather-presentation-${weather.stage}`,
  )),
  ...T0_TRANQUIL_NON_DARK_WEATHER_PRESENTATIONS.map((weather) =>
    canonicalEnvironmentProfileMapping(
      weather.typeID,
      `abyssal:environment:${weather.weatherType}-weather-presentation-${weather.stage}`,
    )
  ),
  ...ABYSSAL_LENS_FLARES.map((lens) => canonicalEnvironmentProfileMapping(
    lens.typeID,
    `abyssal:environment:lens-flare-${lens.code.toLowerCase()}`,
  )),
]);

function buildCanonicalEnvironmentProfileIDByTypeID(mappings) {
  const profileIDByTypeID = {};
  for (const mapping of mappings) {
    if (mapping.typeID <= 0 || !mapping.profileID) {
      throw new Error("ABYSSAL_ENVIRONMENT_CANONICAL_MAPPING_INVALID");
    }
    if (Object.hasOwn(profileIDByTypeID, mapping.typeID)) {
      throw new Error(
        `ABYSSAL_ENVIRONMENT_CANONICAL_MAPPING_DUPLICATE_TYPE:${mapping.typeID}`,
      );
    }
    profileIDByTypeID[mapping.typeID] = mapping.profileID;
  }
  return Object.freeze(profileIDByTypeID);
}

const CANONICAL_ENVIRONMENT_PROFILE_ID_BY_TYPE_ID =
  buildCanonicalEnvironmentProfileIDByTypeID(
    CANONICAL_ENVIRONMENT_PROFILE_MAPPINGS,
  );

function listCanonicalAbyssalEnvironmentalProfileMappings() {
  return CANONICAL_ENVIRONMENT_PROFILE_MAPPINGS.map((mapping) => ({ ...mapping }));
}

function getCanonicalAbyssalEnvironmentalProfileIDByTypeID(typeID) {
  return CANONICAL_ENVIRONMENT_PROFILE_ID_BY_TYPE_ID[toInt(typeID, 0)] || null;
}

function resolveDarkWeatherPresentation(options = {}) {
  const weatherState = options && options.weatherState &&
    typeof options.weatherState === "object"
    ? options.weatherState
    : null;
  if (String(weatherState && weatherState.weatherType || "").trim().toLowerCase() !== "dark") {
    return null;
  }
  return getDarkWeatherStageByTypeID(toInt(weatherState.weatherTypeID, 0)) ||
    getDarkWeatherStage(toInt(weatherState.weatherStage, 0));
}

function resolveWeatherPresentation(options = {}, fallbackTypeID = 0) {
  const darkWeatherPresentation = resolveDarkWeatherPresentation(options);
  if (darkWeatherPresentation) {
    return {
      ...darkWeatherPresentation,
      weatherType: "dark",
      profileID:
        `abyssal:environment:dark-weather-presentation-${darkWeatherPresentation.stage}`,
    };
  }
  const weatherState = options && options.weatherState &&
    typeof options.weatherState === "object"
    ? options.weatherState
    : null;
  const weatherObjectTypeID = toInt(
    weatherState && weatherState.weatherTypeID,
    toInt(fallbackTypeID, 0),
  );
  const weather = T0_TRANQUIL_NON_DARK_WEATHER_PRESENTATIONS.find(
    (entry) => entry.typeID === weatherObjectTypeID,
  );
  return weather
    ? {
      ...weather,
      penaltyPercent: toInt(
        weatherState && weatherState.penaltyStrengthPercent,
        30,
      ),
      bonusPercent: toInt(
        weatherState && weatherState.bonusStrengthPercent,
        50,
      ),
      profileID:
        `abyssal:environment:${weather.weatherType}-weather-presentation-${weather.stage}`,
    }
    : null;
}

function buildEnvironmentalAuthorityFacets(definition, options = {}) {
  const sourceFacets = definition && definition.authorityFacets;
  if (!sourceFacets || typeof sourceFacets !== "object") {
    return null;
  }
  const capturedTransform = options.capturedTransform === true;
  const placementModel = String(
    options.placementModel || sourceFacets.placement && sourceFacets.placement.placementModel || "",
  );
  return Object.freeze({
    objectIdentity: Object.freeze({ ...sourceFacets.objectIdentity }),
    mechanics: Object.freeze({ ...sourceFacets.mechanics }),
    placement: Object.freeze({
      ...sourceFacets.placement,
      contentAuthority: capturedTransform
        ? ABYSSAL_CONTENT_AUTHORITY.CAPTURED_RETAIL
        : ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
      placementModel,
      retailExact: capturedTransform,
    }),
    spawnSelection: Object.freeze({
      ...sourceFacets.spawnSelection,
      contentAuthority: ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
      retailProbabilityKnown: false,
    }),
  });
}

function listCapturedT0DarkEnvironmentalObjects(
  roomIndex,
  environmentRoomProfile,
  options = {},
) {
  const room = resolveSelectedT0DarkRoom(options, roomIndex);
  if (!room) return [];
  const darkWeatherPresentation = resolveDarkWeatherPresentation(options);
  const weatherObject = room.weatherObject && darkWeatherPresentation
    ? {
      ...room.weatherObject,
      typeID: darkWeatherPresentation.typeID,
      name: darkWeatherPresentation.name,
      displayName: darkWeatherPresentation.name,
      weatherStage: darkWeatherPresentation.stage,
      weatherPenaltyStrengthPercent: darkWeatherPresentation.penaltyPercent,
      weatherBonusStrengthPercent: darkWeatherPresentation.bonusPercent,
    }
    : room.weatherObject;
  const sourceObjects = [
    ...room.functionalObjects,
    room.cloudObject,
    weatherObject,
  ].filter(Boolean);
  return sourceObjects.map((sourceObject, index) => {
    const profileID = CANONICAL_ENVIRONMENT_PROFILE_ID_BY_TYPE_ID[sourceObject.typeID];
    const definition = getAbyssalEnvironmentalDefinition(profileID);
    if (!definition) {
      return null;
    }
    return Object.freeze({
      slot: index + 1,
      profileID,
      definition,
      typeID: sourceObject.typeID,
      sourceRole: sourceObject.role,
      effectKind: definition.effectKind,
      mechanicsEnabled: definition.mechanicsEnabled === true,
      presentationEnabled: true,
      dunObjectID: toInt(sourceObject.dunObjectID, 0),
      dunObjectNameID: sourceObject.dunObjectNameID,
      objectiveTargetGroup: sourceObject.objectiveTargetGroup,
      offset: Object.freeze(cloneVector(sourceObject.position)),
      rotation: Object.freeze(cloneRotation(sourceObject.rotation)),
      radius: Number(sourceObject.radius) || 1,
      mass: Number(sourceObject.mass) || 0,
      perimeterRadius: Number(sourceObject.perimeterRadius) || 0,
      perimeterRadiusSource: Number(sourceObject.perimeterRadius) > 0
        ? "presentation-authored"
        : "",
      perimeterLook: toInt(definition.perimeterLook, toInt(sourceObject.perimeterLook, 0)),
      retailBallID: String(sourceObject.retailBallID || ""),
      capturedRetailOwnerID: toInt(sourceObject.presentationOwnerID, toInt(sourceObject.ownerID, 0)),
      identity: sourceObject.identity ? Object.freeze({ ...sourceObject.identity }) : null,
      identityPolicy: String(sourceObject.identity && sourceObject.identity.identityPolicy || ""),
      namePolicy: String(sourceObject.namePolicy || sourceObject.identity && sourceObject.identity.namePolicy || ""),
      displayName: sourceObject.displayName || sourceObject.identity && sourceObject.identity.displayName || null,
      capturedRetailObject: true,
      sourceEvidence: Object.freeze({ ...sourceObject.sourceEvidence }),
      authorityFacets: buildEnvironmentalAuthorityFacets(definition, {
        capturedTransform: true,
        placementModel: "captured-room-local-transform",
      }),
      environmentRoomProfile: environmentRoomProfile
        ? Object.freeze({ ...environmentRoomProfile })
        : null,
    });
  }).filter(Boolean);
}

function buildObservedTelemetryEnvironmentalObjects(
  options = {},
  startSlot = 0,
  environmentRoomProfile = null,
  placementAnchors = [],
) {
  const observedEntries = [];
  let observedOrdinal = 0;
  const unusedPlacementAnchors = Array.isArray(placementAnchors)
    ? [...placementAnchors]
    : [];
  for (const sourceEntry of (
    Array.isArray(options && options.observedObjectEntries)
      ? options.observedObjectEntries
      : []
  )) {
    if (
      !["functional_environment", "presentation_only"].includes(
        String(sourceEntry && sourceEntry.runtimeDisposition || ""),
      )
    ) {
      continue;
    }
    const profileID =
      CANONICAL_ENVIRONMENT_PROFILE_ID_BY_TYPE_ID[toInt(sourceEntry.typeID, 0)];
    const definition = getAbyssalEnvironmentalDefinition(profileID);
    if (!definition) continue;
    const quantity = Math.max(1, toInt(sourceEntry.quantity, 1));
    for (let quantityIndex = 0; quantityIndex < quantity; quantityIndex += 1) {
      const exactAnchorIndex = unusedPlacementAnchors.findIndex(
        (anchor) => toInt(anchor && anchor.typeID, 0) === toInt(sourceEntry.typeID, 0),
      );
      const anchorIndex = exactAnchorIndex >= 0
        ? exactAnchorIndex
        : unusedPlacementAnchors.length > 0 ? 0 : -1;
      const placementAnchor = anchorIndex >= 0
        ? unusedPlacementAnchors.splice(anchorIndex, 1)[0]
        : null;
      const exactCapturedPlacement = exactAnchorIndex >= 0;
      const angle = observedOrdinal * 2.399963229728653;
      const radiusMeters = 18_000 + ((observedOrdinal % 4) * 2_500);
      const offset = placementAnchor
        ? Object.freeze(cloneVector(placementAnchor.offset))
        : Object.freeze({
          x: Math.round(Math.cos(angle) * radiusMeters),
          y: Math.round(Math.sin(angle) * radiusMeters),
          z: ((observedOrdinal % 3) - 1) * 1_500,
        });
      observedEntries.push(Object.freeze({
        slot: startSlot + observedEntries.length + 1,
        profileID,
        definition,
        typeID: definition.typeID,
        sourceRole: "abyssal_space_observed_environment",
        effectKind: definition.effectKind,
        mechanicsEnabled:
          sourceEntry.runtimeDisposition === "functional_environment" &&
          definition.mechanicsEnabled === true,
        presentationEnabled: definition.presentationEnabled === true,
        identity: definition.identity || null,
        perimeterRadius: Number(definition.perimeterRadius) || 0,
        perimeterRadiusSource: "definition-default",
        perimeterLook: toInt(definition.perimeterLook, 0),
        dunObjectID: 0,
        offset,
        rotation: placementAnchor
          ? Object.freeze(cloneRotation(placementAnchor.rotation))
          : Object.freeze([0, 0, angle]),
        sourceItemName: String(sourceEntry.itemName || ""),
        sourceRuntimeDisposition: String(sourceEntry.runtimeDisposition || ""),
        sourceEvidence: Object.freeze({
          authority: "abyssal.space",
          scope: "room-object-presence",
          transform: definition.authorityFacets
            ? exactCapturedPlacement
              ? "captured-room-local-transform"
              : placementAnchor
                ? "project-authored-captured-anchor-substitution"
                : "deterministic-project-authored"
            : placementAnchor
              ? "captured-layout-anchor"
              : "deterministic-inferred",
          capturedLayoutAnchorTypeID: toInt(
            placementAnchor && placementAnchor.typeID,
            0,
          ),
          mechanics: definition.authorityFacets
            ? definition.mechanicsEnabled === true
              ? "canonical-supported-profile"
              : "canonical-profile-disabled"
            : sourceEntry.runtimeDisposition === "functional_environment"
              ? "local-supported-profile"
              : "presentation-only",
          ...(definition.authorityFacets
            ? {
                runtimeDisposition: String(sourceEntry.runtimeDisposition || ""),
                spawnSelection: "project-authored-runtime-policy",
              }
            : {}),
        }),
        authorityFacets: buildEnvironmentalAuthorityFacets(definition, {
          capturedTransform: exactCapturedPlacement,
          placementModel: exactCapturedPlacement
            ? "captured-room-local-transform"
            : placementAnchor
              ? "project-authored-captured-anchor-substitution"
              : "deterministic-inferred-per-selected-room-observation",
        }),
        environmentRoomProfile: environmentRoomProfile
          ? Object.freeze({ ...environmentRoomProfile })
          : null,
      }));
      observedOrdinal += 1;
    }
  }
  return observedEntries;
}

function listAbyssalEnvironmentalObjectsForRoom(roomIndex, options = {}) {

  if (isProceduralEnvironment(options.layoutVariant)) {
    return buildProceduralEnvironmentalObjects({ ...options, roomIndex }, {
      getDefinition: getAbyssalEnvironmentalDefinition,
      getProfileID: getCanonicalAbyssalEnvironmentalProfileIDByTypeID,
      weatherPresentation: resolveWeatherPresentation(options),
    });
  }
  const numericRoomIndex = toInt(roomIndex, 1);
  const selectedRoom = isT0DarkRetailCapturedProfile(options)
    ? resolveSelectedT0DarkRoom(options, numericRoomIndex)
    : null;
  const environmentRoomProfile = selectedRoom && selectedRoom.environmentProfile
    ? { ...selectedRoom.environmentProfile }
    : resolveAbyssalEnvironmentRoomProfile({
      tier: options && options.tier,
      weatherType: options && options.weatherType,
      layoutVariant: options && options.layoutVariant,
      roomIndex: numericRoomIndex,
      seed: options && options.seed,
    });
  if (isT0DarkRetailCapturedProfile(options)) {
    const capturedEntries = listCapturedT0DarkEnvironmentalObjects(
      numericRoomIndex,
      environmentRoomProfile,
      options,
    );
    const hasObservedEncounterObjects =
      Array.isArray(options && options.observedObjectEntries) &&
      options.observedObjectEntries.length > 0;
    const capturedDynamicAnchors = hasObservedEncounterObjects
      ? capturedEntries.filter((entry) => entry.sourceRole === "suppressor")
      : [];
    const capturedStaticEntries = hasObservedEncounterObjects
      ? capturedEntries.filter((entry) => entry.sourceRole !== "suppressor")
      : capturedEntries;
    return [
      ...capturedStaticEntries,
      ...buildObservedTelemetryEnvironmentalObjects(
        options,
        capturedStaticEntries.length,
        environmentRoomProfile,
        capturedDynamicAnchors,
      ),
    ].map((entry, index) => Object.freeze({
      ...entry,
      slot: index + 1,
    }));
  }
    return resolveEnvironmentalLayoutAndWeather({
      roomIndex,
      options,
      numericRoomIndex,
      selectedRoom,
      environmentRoomProfile,
    });
  }

  function resolveEnvironmentalLayoutAndWeather(attempt) {
    const { numericRoomIndex, environmentRoomProfile, options } = attempt;
const baseLayoutEntries = ROOM_ENVIRONMENTAL_LAYOUTS[numericRoomIndex] || [];
  const capturedLocalTransforms = Array.isArray(
    environmentRoomProfile && environmentRoomProfile.capturedLocalTransforms,
  )
    ? environmentRoomProfile.capturedLocalTransforms.filter((transform) =>
      transform && transform.positionKnown !== false
    )
    : [];
  const capturedLocalTransformByTypeID = new Map(
    capturedLocalTransforms.map((transform) => [
      toInt(transform.typeID, 0),
      transform,
    ]),
  );
  const baseEntries = baseLayoutEntries.map((entry) => {
    const definition = getAbyssalEnvironmentalDefinition(entry.profileID);
    const capturedTransform = definition
      ? capturedLocalTransformByTypeID.get(toInt(definition.typeID, 0))
      : null;
    return capturedTransform
      ? {
        ...entry,
        offset: Object.freeze(cloneVector(capturedTransform.offset)),
        rotation: Object.freeze(cloneRotation(capturedTransform.rotation)),
        dunObjectID: toInt(capturedTransform.dunObjectID, 0),
        authoredEntityID: String(capturedTransform.entityID || "") || null,
        capturedRetailObject: true,
      }
      : entry;
  });
  const selectedWeather = resolveWeatherPresentation(
    options,
    environmentRoomProfile && environmentRoomProfile.weatherObjectTypeID,
  );
  const weatherObjectTypeID = toInt(
    selectedWeather && selectedWeather.typeID,
    toInt(environmentRoomProfile && environmentRoomProfile.weatherObjectTypeID, 0),
  );
  const weatherProfileID = selectedWeather && selectedWeather.profileID ||
    CANONICAL_ENVIRONMENT_PROFILE_ID_BY_TYPE_ID[weatherObjectTypeID];
  const resolvedEnvironmentRoomProfile = (environmentRoomProfile || selectedWeather)
    ? {
      ...(environmentRoomProfile || {}),
      weatherObjectTypeID,
      weatherStage: toInt(selectedWeather && selectedWeather.stage, 0),
      weatherPenaltyStrengthPercent: toInt(
        selectedWeather && selectedWeather.penaltyPercent,
        0,
      ),
      weatherBonusStrengthPercent: toInt(
        selectedWeather && selectedWeather.bonusPercent,
        0,
      ),
    }
    : null;
  const weatherPresentationEntry = weatherObjectTypeID > 0 && weatherProfileID
    ? [{
      slot: baseEntries.length + 1,
      profileID: weatherProfileID,
      sourceRole: "weather_object",
      offset: Object.freeze({ x: 0, y: 0, z: 0 }),
      rotation: Object.freeze([0, 0, 0]),
      environmentRoomProfile: resolvedEnvironmentRoomProfile,
    }]
    : [];
    return resolveEnvironmentalPresentationOverlays({
      ...attempt,
      baseLayoutEntries,
      capturedLocalTransforms,
      capturedLocalTransformByTypeID,
      baseEntries,
      selectedWeather,
      weatherObjectTypeID,
      weatherProfileID,
      resolvedEnvironmentRoomProfile,
      weatherPresentationEntry,
    });
  }

  function resolveEnvironmentalPresentationOverlays(attempt) {
    const { environmentRoomProfile, baseEntries, weatherPresentationEntry } = attempt;
const cloudObjectTypeID = toInt(
    environmentRoomProfile && environmentRoomProfile.volumetricCloudObjectTypeID,
    0,
  );
  const cloudDungeonID = toInt(
    environmentRoomProfile && environmentRoomProfile.volumetricCloudDungeonID,
    0,
  );
  const cloudDunObjectID = toInt(
    environmentRoomProfile && environmentRoomProfile.volumetricCloudDunObjectID,
    0,
  );
  const cloudPresentationEntry =
    environmentRoomProfile && cloudObjectTypeID > 0 && cloudDungeonID > 0 && cloudDunObjectID > 0
      ? [{
        slot: baseEntries.length + 1,
        profileID: CANONICAL_ENVIRONMENT_PROFILE_ID_BY_TYPE_ID[cloudObjectTypeID],
        sourceRole: "volumetric_cloud_ball",
        offset: Object.freeze({ x: 0, y: 0, z: 0 }),
        rotation: Object.freeze([0, 0, 0]),
        dunObjectID: cloudDunObjectID,
        environmentRoomProfile,
      }]
      : [];
  const lensFlareTypeID = toInt(
    environmentRoomProfile && environmentRoomProfile.lensFlareTypeID,
    0,
  );
  const lensFlareProfileID =
    CANONICAL_ENVIRONMENT_PROFILE_ID_BY_TYPE_ID[lensFlareTypeID];
  const lensFlarePresentationEntry = lensFlareTypeID > 0 && lensFlareProfileID
    ? [{
      slot: baseEntries.length + cloudPresentationEntry.length + 1,
      profileID: lensFlareProfileID,
      sourceRole: "functional_environmental_structure",
      offset: Object.freeze({ x: 0, y: 0, z: 0 }),
      rotation: Object.freeze([0, 0, 0]),
      environmentRoomProfile,
    }]
    : [];
  const capturedFunctionalOverlayEntries = Array.isArray(
    environmentRoomProfile && environmentRoomProfile.functionalOverlays,
  )
    ? environmentRoomProfile.functionalOverlays
      .filter((overlay) => overlay && overlay.positionKnown !== false)
      .map((overlay, index) => ({
        slot:
          baseEntries.length +
          cloudPresentationEntry.length +
          lensFlarePresentationEntry.length +
          weatherPresentationEntry.length +
          index + 1,
        profileID: CANONICAL_ENVIRONMENT_PROFILE_ID_BY_TYPE_ID[toInt(overlay.typeID, 0)],
        sourceRole: "functional_environmental_structure",
        offset: Object.freeze(cloneVector(overlay.offset)),
        rotation: Object.freeze(cloneRotation(overlay.rotation)),
        dunObjectID: toInt(overlay.dunObjectID, 0),
        authoredEntityID: String(overlay.entityID || "") || null,
        capturedRetailObject: true,
        environmentRoomProfile,
      }))
      .filter((entry) => entry.profileID)
    : [];
    return materializeEnvironmentalCatalogueEntries({
      ...attempt,
      cloudObjectTypeID,
      cloudDungeonID,
      cloudDunObjectID,
      cloudPresentationEntry,
      lensFlareTypeID,
      lensFlareProfileID,
      lensFlarePresentationEntry,
      capturedFunctionalOverlayEntries,
    });
  }

  function materializeEnvironmentalCatalogueEntries(attempt) {
    const {
      baseEntries,
      cloudPresentationEntry,
      lensFlarePresentationEntry,
      weatherPresentationEntry,
      capturedFunctionalOverlayEntries,
      options,
      resolvedEnvironmentRoomProfile,
    } = attempt;
const entries = [
    ...baseEntries,
    ...cloudPresentationEntry,
    ...lensFlarePresentationEntry,
    ...weatherPresentationEntry.map((entry) => ({
      ...entry,
      slot:
        baseEntries.length +
        cloudPresentationEntry.length +
        lensFlarePresentationEntry.length +
        1,
    })),
    ...capturedFunctionalOverlayEntries,
  ];
  const resolvedEntries = entries
    .map((entry) => {
      const definition = getAbyssalEnvironmentalDefinition(entry.profileID);
      if (!definition) {
        return null;
      }
      return Object.freeze({
        ...entry,
        definition,
        typeID: definition.typeID,
        sourceRole: entry.sourceRole || "",
        effectKind: definition.effectKind,
        mechanicsEnabled: definition.mechanicsEnabled === true,
        presentationEnabled: definition.presentationEnabled === true,
        identity: entry.identity || definition.identity || null,
        perimeterRadius: Number(entry.perimeterRadius) ||
        Number(definition.perimeterRadius) ||
        0,
        perimeterRadiusSource: Number(entry.perimeterRadius) > 0
          ? "presentation-authored"
          : "definition-default",
        perimeterLook: toInt(definition.perimeterLook, toInt(entry.perimeterLook, 0)),
        dunObjectID: toInt(entry.dunObjectID, 0),
        offset: Object.freeze(cloneVector(entry.offset)),
        rotation: Object.freeze(cloneRotation(entry.rotation)),
        authorityFacets: buildEnvironmentalAuthorityFacets(definition, {
          capturedTransform: entry.capturedRetailObject === true,
          placementModel: entry.capturedRetailObject === true
            ? "captured-room-local-transform"
            : "project-authored-room-layout",
        }),
        environmentRoomProfile: entry.environmentRoomProfile
          ? Object.freeze({ ...entry.environmentRoomProfile })
          : null,
      });
    })
    .filter(Boolean);
  return [
    ...resolvedEntries,
    ...buildObservedTelemetryEnvironmentalObjects(
      options,
      resolvedEntries.length,
      resolvedEnvironmentRoomProfile,
    ),
  ];
  }

module.exports = {
  ENVIRONMENTAL_EFFECT_KIND,
  ENVIRONMENTAL_EVIDENCE,
  TYPE_PLAYER_SPAWN_LOCATION,
  TYPE_ABYSSAL_PERIMETER_LIGHTS,
  TYPE_SMALL_CRYSTAL_ENVIRONMENT_4,
  TYPE_TRIGLAVIAN_TRIPLEX_EXTRACTION_CLUSTER,
  TYPE_CAPTURED_ABYSSAL_LENS_FLARE,
  TYPE_SHORT_RANGE_DEVIANT_AUTOMATA_SUPPRESSOR,
  TYPE_MEDIUM_RANGE_DEVIANT_AUTOMATA_SUPPRESSOR,
  TYPE_SHORT_RANGE_MULTIBODY_TRACKING_PYLON,
  TYPE_MEDIUM_RANGE_MULTIBODY_TRACKING_PYLON,
  TYPE_UNSTABLE_ABYSSAL_DEPTHS,
  TYPE_LARGE_FILAMENT_CLOUD,
  TYPE_DARK_WEATHER_PRESENTATION,
  TYPE_CRYSTAL_DUNGEON_CLOUD_6204,
  TYPE_CRYSTAL_DUNGEON_CLOUD_6205,
  TYPE_CRYSTAL_DUNGEON_CLOUD_6207,
  getAbyssalEnvironmentalDefinition,
  listAbyssalEnvironmentalDefinitions,
  getCanonicalAbyssalEnvironmentalProfileIDByTypeID,
  listCanonicalAbyssalEnvironmentalProfileMappings,
  listAbyssalEnvironmentalObjectsForRoom,
  listT0TranquilWeatherPresentationStages,
};
