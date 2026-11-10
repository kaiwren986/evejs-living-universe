"use strict";

const { createHash } = require("node:crypto");
const { cloneValue, deepFreeze } = require("../domain/abyssalValueUtils");
const { ABYSSAL_CONTENT_AUTHORITY } = require("./abyssalContentAuthority");
const { getAbyssalNebula, getAbyssalLensFlare,
  getT0DarkDungeonCloudByDungeonID: getDungeonCloud,
  ABYSSAL_NEBULAE, ABYSSAL_LENS_FLARES, T0_DARK_DUNGEON_CLOUDS } = require("./t0DarkDevMenuCatalog");
const facts = deepFreeze(require("./content/environmentFactsV1.json"));

const PROCEDURAL_ENVIRONMENT_MODEL = "abyssal:procedural-environment-v1";
const PROCEDURAL_ENVIRONMENT_INPUTS = deepFreeze({ facts, nebulae: ABYSSAL_NEBULAE,
  lenses: ABYSSAL_LENS_FLARES, clouds: T0_DARK_DUNGEON_CLOUDS });

function sampleIndex(seed, count) {
  return createHash("sha256").update(String(seed)).digest().readUInt32BE(0) % count;
}

function isProceduralEnvironment(layoutVariant) {
  return layoutVariant === PROCEDURAL_ENVIRONMENT_MODEL;
}

function describeAbyssalEnvironmentSource(profile) {
  return !profile ? "none" : isProceduralEnvironment(profile.layoutVariant)
    ? "procedural-factual-inputs" : profile.fallbackGenerated === true ? "fallback-generated" : "authored";
}

function buildProceduralEnvironmentRoom(options = {}) {
  const { tier, weatherType, roomIndex, baseRoomLayoutID } = options;
  const weather = facts.weather[weatherType];
  if (!Number.isInteger(tier) || tier < 0 || tier > 6 || !weather ||
      !Number.isInteger(roomIndex) || roomIndex < 1 || roomIndex > 3) {
    throw new Error(`ABYSSAL_PROCEDURAL_ENVIRONMENT_CONTEXT_UNAVAILABLE tier=${tier} weather=${weatherType} room=${roomIndex}`);
  }
  const seed = `${options.seed ?? 0}:${tier}:${weatherType}:${roomIndex}`;
  const nebula = getAbyssalNebula(weather.nebulaGraphicIDs[sampleIndex(`${seed}:nebula`, weather.nebulaGraphicIDs.length)]);
  const lens = getAbyssalLensFlare(weather.lensFlareTypeIDs[sampleIndex(`${seed}:lens`, weather.lensFlareTypeIDs.length)]);
  const cloudFact = baseRoomLayoutID ? facts.clouds.find((entry) => entry.layoutID === baseRoomLayoutID) : null;
  const cloud = cloudFact ? getDungeonCloud(cloudFact.dungeonID) : null;
  if (!nebula || !lens || (baseRoomLayoutID && (!cloudFact || !cloud || cloud.typeID !== cloudFact.typeID))) {
    throw new Error(`ABYSSAL_PROCEDURAL_ENVIRONMENT_FACT_UNAVAILABLE layout=${baseRoomLayoutID || "none"}`);
  }
  return {
    roomIndex,
    profileID: `${PROCEDURAL_ENVIRONMENT_MODEL}:t${tier}:${weatherType}`,
    tier, weatherType, layoutVariant: PROCEDURAL_ENVIRONMENT_MODEL,
    presentationEnabled: true, mechanicsEnabled: true,
    contentAuthority: ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
    transitionEffect: "effects.JumpOutAbyssal",
    environmentSource: "procedural-factual-inputs",
    roomLayoutProfileID: `${PROCEDURAL_ENVIRONMENT_MODEL}:r${roomIndex}`,
    nebulaGraphicID: nebula.graphicID,
    sceneCubeResource: nebula.sceneCubeResource,
    nearFieldResource: weather.nearFieldResource,
    lensFlareTypeID: lens.typeID,
    lensFlareResource: lens.resource,
    weatherObjectTypeID: weather.weatherObjectTypeID,
    gradientResource: null,
    // Definition validation has no run/layout yet. Runtime supplies the exact
    // persisted base layout, not the geometry of a captured tier/weather room.
    ...(cloudFact ? {
      baseRoomLayoutID,
      volumetricCloudDungeonID: cloudFact.dungeonID,
      dungeonRoomID: cloudFact.dungeonRoomID,
      volumetricCloudObjectTypeID: cloudFact.typeID,
      volumetricCloudDunObjectID: cloudFact.dunObjectID,
      volumetricCloudResource: cloud.resource,
    } : {}),
  };
}

function buildProceduralEnvironmentProfile(options = {}) {
  return {
    profileID: `${PROCEDURAL_ENVIRONMENT_MODEL}:t${options.tier}:${options.weatherType}`,
    tier: options.tier, weatherType: options.weatherType,
    layoutVariant: PROCEDURAL_ENVIRONMENT_MODEL,
    evidence: "FACTUAL_IDENTITIES_PROCEDURAL_COMPOSITION",
    contentAuthority: ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
    environmentSource: "procedural-factual-inputs",
    normalSelectionEligible: true, presentationEnabled: true, mechanicsEnabled: true,
    transitionEffect: "effects.JumpOutAbyssal",
    limitations: ["Geometry and object identities are captured facts; composition, selection probabilities and placement are EveJS policy, not retail-exact."],
    rooms: Object.fromEntries([1, 2, 3].map((roomIndex) => [roomIndex,
      buildProceduralEnvironmentRoom({ ...options, roomIndex })])),
  };
}

function buildProceduralEnvironmentalObjects(options, { getDefinition, getProfileID, weatherPresentation }) {
  if (!options.baseRoomLayoutID) throw new Error("ABYSSAL_PROCEDURAL_BASE_LAYOUT_REQUIRED");
  const room = buildProceduralEnvironmentRoom(options);
  const makeEntry = (profileID, sourceRole, offset = { x: 0, y: 0, z: 0 }, extra = {}) => {
    const definition = getDefinition(profileID);
    if (!definition) throw new Error(`ABYSSAL_PROCEDURAL_ENVIRONMENT_OBJECT_UNAVAILABLE profile=${profileID}`);
    return {
      profileID, definition, typeID: definition.typeID, sourceRole,
      effectKind: definition.effectKind, mechanicsEnabled: definition.mechanicsEnabled === true,
      presentationEnabled: definition.presentationEnabled === true,
      identity: definition.identity || null,
      perimeterRadius: Number(definition.perimeterRadius) || 0,
      perimeterRadiusSource: "definition-default", perimeterLook: Number(definition.perimeterLook) || 0,
      dunObjectID: 0, offset, rotation: [0, 0, 0], environmentRoomProfile: room,
      ...extra,
    };
  };
  const entries = [
    makeEntry("abyssal:environment:unstable-depths", "depth_boundary_object"),
    makeEntry("abyssal:environment:player-spawn-location", "player_insertion_locator"),
    makeEntry("abyssal:environment:perimeter-lights", "environmental_perimeter"),
  ];
  if (room.volumetricCloudObjectTypeID) entries.push(makeEntry(
    getProfileID(room.volumetricCloudObjectTypeID), "volumetric_cloud_ball",
    undefined, { dunObjectID: room.volumetricCloudDunObjectID },
  ));
  entries.push(makeEntry(getProfileID(room.lensFlareTypeID), "functional_environmental_structure"));
  const weatherTypeID = weatherPresentation?.typeID || room.weatherObjectTypeID;
  entries.push(makeEntry(weatherPresentation?.profileID || getProfileID(weatherTypeID), "weather_object",
    undefined, { environmentRoomProfile: { ...room, weatherObjectTypeID: weatherTypeID,
      weatherStage: weatherPresentation?.stage || 0,
      weatherPenaltyStrengthPercent: weatherPresentation?.penaltyPercent || 0,
      weatherBonusStrengthPercent: weatherPresentation?.bonusPercent || 0 } }));

  // The encounter already selected and persisted observed object identities for
  // its own context. Empty observations mean no optional objects, never a fallback
  // captured pylon/suppressor roster. This function does not sample NPCs or loot.
  let ordinal = 0;
  const phase = sampleIndex(`${options.seed ?? 0}:${options.roomIndex}:objects`, 360) * Math.PI / 180;
  for (const source of options.observedObjectEntries || []) {
    if (!["functional_environment", "presentation_only"].includes(source.runtimeDisposition)) continue;
    const quantity = source.quantity == null ? 1 : source.quantity;
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      throw new Error(`ABYSSAL_PROCEDURAL_ENVIRONMENT_QUANTITY_INVALID type=${source.typeID}`);
    }
    for (let index = 0; index < quantity; index += 1) {
      const angle = phase + ordinal * 2.399963229728653;
      const radius = 18000 + (ordinal % 4) * 2500;
      const entry = makeEntry(getProfileID(source.typeID), "abyssal_space_observed_environment", {
        x: Math.round(Math.cos(angle) * radius), y: Math.round(Math.sin(angle) * radius),
        z: ((ordinal % 3) - 1) * 1500,
      }, {
        rotation: [0, 0, angle], sourceItemName: source.itemName || "",
        sourceRuntimeDisposition: source.runtimeDisposition,
        sourceEvidence: { authority: "abyssal.space", scope: "room-object-presence",
          transform: PROCEDURAL_ENVIRONMENT_MODEL, retailExact: false },
      });
      entry.mechanicsEnabled = source.runtimeDisposition === "functional_environment" && entry.mechanicsEnabled;
      if (entry.definition.authorityFacets) entry.authorityFacets = {
        ...cloneValue(entry.definition.authorityFacets),
        placement: { contentAuthority: ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
          placementModel: PROCEDURAL_ENVIRONMENT_MODEL, retailExact: false },
      };
      entries.push(entry);
      ordinal += 1;
    }
  }
  return entries.map((entry, index) => deepFreeze({ ...entry, slot: index + 1 }));
}

module.exports = { PROCEDURAL_ENVIRONMENT_MODEL, PROCEDURAL_ENVIRONMENT_INPUTS, isProceduralEnvironment,
  describeAbyssalEnvironmentSource,
  buildProceduralEnvironmentProfile, buildProceduralEnvironmentRoom, buildProceduralEnvironmentalObjects };
