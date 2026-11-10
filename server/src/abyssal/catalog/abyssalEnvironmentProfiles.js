"use strict";

const {
  PROFILE_ID: T0_DARK_RETAIL_CAPTURED_CONTENT_PROFILE_ID,
} = require("./t0DarkRetailCapturedLayout");

const {
  cloneValue,
  deepFreeze,
} = require("../domain/abyssalValueUtils");
const {
  ABYSSAL_CONTENT_AUTHORITY,
} = require("./abyssalContentAuthority");
const {
  getAbyssalLensFlare,
  getAbyssalNebula,
} = require("./t0DarkDevMenuCatalog");
const {
  getGeneratedAuthoredCatalogue,
  resolveGeneratedAuthoredCapture,
} = require("./content/authoredAbyssalContentRegistry");
const { isProceduralEnvironment, buildProceduralEnvironmentProfile,
  buildProceduralEnvironmentRoom } = require("./abyssalProceduralEnvironment");

const ABYSSAL_ENVIRONMENT_PROFILE_EVIDENCE = Object.freeze({
  RETAIL_CAPTURED: "RETAIL_CAPTURED",
  STATIC_AUTHORITY: "STATIC_AUTHORITY",
  RETAIL_CAPTURED_BASE: "RETAIL_CAPTURED_BASE",
  EMPIRICAL_OBJECT_IDENTITIES: "EMPIRICAL_OBJECT_IDENTITIES",
});

const TIER0_DARK_CAPTURED_LAYOUT_VARIANT = "tier0-dark-captured-a";
const TIER0_ELECTRICAL_CAPTURED_LAYOUT_VARIANT = "tier0-electrical-captured-a";
const TIER0_ELECTRICAL_CAPTURED_LAYOUT_VARIANT_B = "tier0-electrical-captured-b";
const TIER0_EXOTIC_CAPTURED_LAYOUT_VARIANT = "authored:tq-tranquil-exotic-8";
const TIER0_EXOTIC_LEGACY_CAPTURED_LAYOUT_VARIANT = "tier0-exotic-captured-a";
// Retain the old export as a compatibility alias for callers outside this tree.
const TIER0_EXOTIC_STATIC_LAYOUT_VARIANT =
  TIER0_EXOTIC_LEGACY_CAPTURED_LAYOUT_VARIANT;
const TIER0_FIRESTORM_CAPTURED_LAYOUT_VARIANT = "tier0-firestorm-captured-a";
const TIER0_GAMMA_CAPTURED_LAYOUT_VARIANT = "tier0-gamma-captured-a";
const TIER1_ELECTRICAL_CAPTURED_LAYOUT_VARIANT = "tier1-electrical-captured-a";
const TIER1_ELECTRICAL_CAPTURED_LAYOUT_VARIANT_B = "tier1-electrical-captured-b";
const TIER1_EXOTIC_CAPTURED_LAYOUT_VARIANT = "tier1-exotic-captured-a";
const TIER1_GAMMA_CAPTURED_LAYOUT_VARIANT = "tier1-gamma-captured-a";
const TIER1_DARK_EMPIRICAL_LAYOUT_VARIANT = "tier1-dark-empirical-objects-a";
const TIER1_FIRESTORM_EMPIRICAL_LAYOUT_VARIANT =
  "tier1-firestorm-empirical-objects-a";

const CAPTURED_FUNCTIONAL_OVERLAY_TYPE_IDS = new Set([
  47437,
  47438,
  47440,
  47441,
  47452,
  47467,
  47468,
  47469,
  47470,
  47472,
  47473,
]);

const CAPTURED_ROOM_ANCHOR_TYPE_IDS = new Set([
  47465,
  52567,
  54196,
]);

function buildProfileKey(tier, weatherType, layoutVariant) {
  return [
    Number.isFinite(Number(tier)) ? Math.trunc(Number(tier)) : -1,
    String(weatherType || "").trim().toLowerCase(),
    String(layoutVariant || "").trim().toLowerCase(),
  ].join(":");
}

const TIER0_DARK_CAPTURED_PROFILE = deepFreeze({
  profileID: "abyssal:environment-profile:tier0-dark-captured-a-v1",
  tier: 0,
  weatherType: "dark",
  layoutVariant: TIER0_DARK_CAPTURED_LAYOUT_VARIANT,
  evidence: ABYSSAL_ENVIRONMENT_PROFILE_EVIDENCE.RETAIL_CAPTURED,
  contentAuthority: ABYSSAL_CONTENT_AUTHORITY.CAPTURED_RETAIL,
  normalSelectionEligible: true,
  presentationEnabled: true,
  mechanicsEnabled: false,
  transitionEffect: "effects.JumpOutAbyssal",
  limitations: [
    "The room layouts, presentation objects, NPC rosters, cache, wreck, and loot are derived from one captured Tranquil Dark run.",
    "Types 47437 and 47438 use suppressor mechanics, Room 2 type 47473 uses its static 40 km dbuff collections, and Unstable Abyssal Depths uses the separately profiled room-perimeter boundary controller.",
  ],
  rooms: {
    1: {
      roomIndex: 1,
      nebulaGraphicID: 22209,
      volumetricCloudDungeonID: 6204,
      dungeonRoomID: 24754,
      volumetricCloudObjectTypeID: 47667,
      volumetricCloudDunObjectID: 1059503,
      sceneCubeResource: "res:/dx9/scene/abyssal/ad05_a_cube.red",
      volumetricCloudResource: "res:/dx9/model/celestial/environment/cloud/volumetric/dungeons/6204/clouds_6204.red",
      nearFieldResource: "NF_Abyssal_Darkness_S1_01a.red",
      lensFlareResource: "abyssal_white",
      gradientResource: null,
      weatherObjectTypeID: 47378,
      roomLayoutProfileID: `${T0_DARK_RETAIL_CAPTURED_CONTENT_PROFILE_ID}:room-1:props`,
    },
    2: {
      roomIndex: 2,
      nebulaGraphicID: 22210,
      volumetricCloudDungeonID: 6207,
      dungeonRoomID: 24753,
      volumetricCloudObjectTypeID: 47670,
      volumetricCloudDunObjectID: 1059505,
      sceneCubeResource: "res:/dx9/scene/abyssal/ad05_b_cube.red",
      volumetricCloudResource: "res:/dx9/model/celestial/environment/cloud/volumetric/dungeons/6207/clouds_6207.red",
      nearFieldResource: "NF_Abyssal_Darkness_S1_01a.red",
      lensFlareResource: "abyssal_white",
      gradientResource: null,
      weatherObjectTypeID: 47378,
      roomLayoutProfileID: `${T0_DARK_RETAIL_CAPTURED_CONTENT_PROFILE_ID}:room-2:props`,
    },
    3: {
      roomIndex: 3,
      nebulaGraphicID: 22211,
      volumetricCloudDungeonID: 6205,
      dungeonRoomID: 24751,
      volumetricCloudObjectTypeID: 47668,
      volumetricCloudDunObjectID: 1059504,
      sceneCubeResource: "res:/dx9/scene/abyssal/ad05_c_cube.red",
      volumetricCloudResource: "res:/dx9/model/celestial/environment/cloud/volumetric/dungeons/6205/clouds_6205.red",
      nearFieldResource: "NF_Abyssal_Darkness_S1_01a.red",
      lensFlareResource: "abyssal_white",
      gradientResource: null,
      weatherObjectTypeID: 47378,
      roomLayoutProfileID: `${T0_DARK_RETAIL_CAPTURED_CONTENT_PROFILE_ID}:room-3:props`,
    },
  },
});

function buildCapturedEnvironmentProfile(options = {}) {
  const tier = Number.isFinite(Number(options.tier))
    ? Math.trunc(Number(options.tier))
    : 0;
  const weatherType = String(options.weatherType || "").trim().toLowerCase();
  const profileID = String(options.profileID || "").trim();
  const layoutVariant = String(options.layoutVariant || "").trim();
  const nearFieldResource = String(options.nearFieldResource || "").trim();
  const lensFlareResource = String(options.lensFlareResource || "").trim();
  const lensFlareTypeID = Number.parseInt(options.lensFlareTypeID, 10) || 0;
  const weatherObjectTypeID = Number.parseInt(options.weatherObjectTypeID, 10) || 0;
  const sourceRooms = Array.isArray(options.rooms) ? options.rooms : [];
  return deepFreeze({
    profileID,
    tier,
    weatherType,
    layoutVariant,
    evidence: options.evidence || ABYSSAL_ENVIRONMENT_PROFILE_EVIDENCE.RETAIL_CAPTURED,
    contentAuthority: ABYSSAL_CONTENT_AUTHORITY.CAPTURED_RETAIL,
    normalSelectionEligible: options.normalSelectionEligible !== false,
    presentationEnabled: true,
    mechanicsEnabled: false,
    transitionEffect: "effects.JumpOutAbyssal",
    limitations: Array.isArray(options.limitations) ? [...options.limitations] : [],
    rooms: Object.fromEntries(sourceRooms.map((sourceRoom, index) => {
      const roomIndex = index + 1;
      const dungeonID = Number.parseInt(sourceRoom.dungeonID, 10) || 0;
      return [roomIndex, {
        roomIndex,
        nebulaGraphicID: Number.parseInt(sourceRoom.nebulaGraphicID, 10) || 0,
        volumetricCloudDungeonID: dungeonID,
        dungeonRoomID: Number.parseInt(sourceRoom.dungeonRoomID, 10) || 0,
        volumetricCloudObjectTypeID:
          Number.parseInt(sourceRoom.volumetricCloudObjectTypeID, 10) || 0,
        volumetricCloudDunObjectID:
          Number.parseInt(sourceRoom.volumetricCloudDunObjectID, 10) || 0,
        sceneCubeResource: String(sourceRoom.sceneCubeResource || ""),
        volumetricCloudResource:
          `res:/dx9/model/celestial/environment/cloud/volumetric/dungeons/${dungeonID}/clouds_${dungeonID}.red`,
        nearFieldResource,
        lensFlareResource:
          String(sourceRoom.lensFlareResource || "").trim() || lensFlareResource,
        lensFlareTypeID:
          Number.parseInt(sourceRoom.lensFlareTypeID, 10) || lensFlareTypeID,
        gradientResource: null,
        weatherObjectTypeID,
        functionalOverlays: Array.isArray(sourceRoom.functionalOverlays)
          ? sourceRoom.functionalOverlays.map((overlay) => ({
            entityID: String(overlay.entityID || ""),
            typeID: Number.parseInt(overlay.typeID, 10) || 0,
            dunObjectID: Number.parseInt(overlay.dunObjectID, 10) || 0,
            positionKnown: overlay.positionKnown !== false,
            offset: {
              x: Number(overlay.offset && overlay.offset.x) || 0,
              y: Number(overlay.offset && overlay.offset.y) || 0,
              z: Number(overlay.offset && overlay.offset.z) || 0,
            },
            rotation: Array.isArray(overlay.rotation) ? [...overlay.rotation] : [0, 0, 0],
          }))
          : [],
        capturedLocalTransforms: Array.isArray(sourceRoom.capturedLocalTransforms)
          ? sourceRoom.capturedLocalTransforms.map((transform) => ({
            entityID: String(transform.entityID || ""),
            typeID: Number.parseInt(transform.typeID, 10) || 0,
            dunObjectID: Number.parseInt(transform.dunObjectID, 10) || 0,
            positionKnown: transform.positionKnown !== false,
            offset: {
              x: Number(transform.offset && transform.offset.x) || 0,
              y: Number(transform.offset && transform.offset.y) || 0,
              z: Number(transform.offset && transform.offset.z) || 0,
            },
            rotation: Array.isArray(transform.rotation)
              ? [...transform.rotation]
              : [0, 0, 0],
          }))
          : [],
        roomLayoutProfileID: `${profileID}:room-${roomIndex}:presentation`,
      }];
    })),
  });
}

const AUTHORED_NEAR_FIELD_RESOURCE_BY_WEATHER = Object.freeze({
  dark: "NF_Abyssal_Darkness_S1_01a.red",
  electrical: "NF_Abyssal_ElectricStorm_S1_01a.red",
  exotic: "NF_Abyssal_CausticToxin_S1_01a.red",
  firestorm: "NF_Abyssal_Infernal_S1_01a.red",
  gamma: "NF_Abyssal_XenonGas_S1_01a.red",
});

function buildCapturedLocalTransforms(room, allowedTypeIDs) {
  return (Array.isArray(room && room.entities) ? room.entities : [])
    .filter((entity) =>
      entity &&
      allowedTypeIDs.has(
        Number.parseInt(entity.typeID, 10),
      ) &&
      entity.position
    )
    .map((entity) => ({
      entityID: String(entity.entityID || ""),
      typeID: Number.parseInt(entity.typeID, 10),
      dunObjectID: Number.parseInt(entity.dunObjectID, 10),
      positionKnown: true,
      offset: {
        x: Number(entity.position.x),
        y: Number(entity.position.y),
        z: Number(entity.position.z),
      },
      rotation: entity.rotation
        ? [
          Number(entity.rotation.x) || 0,
          Number(entity.rotation.y) || 0,
          Number(entity.rotation.z) || 0,
        ]
        : [0, 0, 0],
    }));
}

function buildCapturedFunctionalOverlays(room) {
  return buildCapturedLocalTransforms(room, CAPTURED_FUNCTIONAL_OVERLAY_TYPE_IDS);
}

function buildCapturedRoomAnchorTransforms(room) {
  return buildCapturedLocalTransforms(room, CAPTURED_ROOM_ANCHOR_TYPE_IDS);
}

function buildGeneratedAuthoredEnvironmentProfile(capture) {
  return buildCapturedEnvironmentProfile({
    profileID: `${capture.captureID}:environment`,
    tier: capture.tier,
    weatherType: capture.weatherType,
    layoutVariant: capture.layoutVariant,
    evidence: ABYSSAL_ENVIRONMENT_PROFILE_EVIDENCE.RETAIL_CAPTURED,
    normalSelectionEligible: false,
    nearFieldResource:
      AUTHORED_NEAR_FIELD_RESOURCE_BY_WEATHER[capture.weatherType] || "",
    weatherObjectTypeID: capture.weatherBallTypeID,
    limitations: [
      `Room and presentation references are normalized from ${capture.captureKey}.`,
      "This profile does not claim retail-exact weather mechanics or presentation timing.",
    ],
    rooms: capture.rooms.map((room) => {
      const cloud = room.entities.find((entity) =>
        entity.entityID === room.environment.volumetricCloudEntityID
      );
      const nebula = getAbyssalNebula(room.environment.sceneNebulaGraphicID);
      const lensFlare = getAbyssalLensFlare(room.environment.lensFlareTypeID);
      if (!cloud || !nebula || !lensFlare) {
        throw new Error(
          `AUTHORED_ABYSSAL_PRESENTATION_INCOMPLETE:${capture.captureKey}:room-${room.roomNumber}`,
        );
      }
      return {
        dungeonID: room.geometry.dungeonID,
        dungeonRoomID: room.geometry.sourceRoomID,
        volumetricCloudObjectTypeID: cloud.typeID,
        volumetricCloudDunObjectID: cloud.dunObjectID,
        nebulaGraphicID: room.environment.sceneNebulaGraphicID,
        sceneCubeResource: nebula.sceneCubeResource,
        lensFlareTypeID: room.environment.lensFlareTypeID,
        lensFlareResource: lensFlare.resource,
        functionalOverlays: buildCapturedFunctionalOverlays(room),
        capturedLocalTransforms: buildCapturedRoomAnchorTransforms(room),
      };
    }),
  });
}

// TQTranquilAbyssal1.txt, 2026-07-15 16:25:17--16:34:25.
const TIER0_ELECTRICAL_CAPTURED_PROFILE = buildCapturedEnvironmentProfile({
  profileID: "abyssal:environment-profile:tier0-electrical-captured-a-v1",
  weatherType: "electrical",
  layoutVariant: TIER0_ELECTRICAL_CAPTURED_LAYOUT_VARIANT,
  nearFieldResource: "NF_Abyssal_ElectricStorm_S1_01a.red",
  lensFlareResource: "abyssal_blue",
  lensFlareTypeID: 47431,
  weatherObjectTypeID: 47381,
  rooms: [
    {
      dungeonID: 6203,
      dungeonRoomID: 24749,
      volumetricCloudObjectTypeID: 47666,
      volumetricCloudDunObjectID: 1059496,
      nebulaGraphicID: 22048,
      sceneCubeResource: "res:/dx9/scene/abyssal/ad04_a_cube.red",
    },
    {
      dungeonID: 6207,
      dungeonRoomID: 24753,
      volumetricCloudObjectTypeID: 47670,
      volumetricCloudDunObjectID: 1059505,
      nebulaGraphicID: 22207,
      sceneCubeResource: "res:/dx9/scene/abyssal/ad04_b_cube.red",
    },
    {
      dungeonID: 6205,
      dungeonRoomID: 24751,
      volumetricCloudObjectTypeID: 47668,
      volumetricCloudDunObjectID: 1059504,
      nebulaGraphicID: 22208,
      sceneCubeResource: "res:/dx9/scene/abyssal/ad04_c_cube.red",
    },
  ],
});
// TQTranquilAbyssal4.txt, 2026-07-15 18:09:07--18:18:52.
const TIER0_ELECTRICAL_CAPTURED_PROFILE_B = buildCapturedEnvironmentProfile({
  profileID: "abyssal:environment-profile:tier0-electrical-captured-b-v1",
  weatherType: "electrical",
  layoutVariant: TIER0_ELECTRICAL_CAPTURED_LAYOUT_VARIANT_B,
  nearFieldResource: "NF_Abyssal_ElectricStorm_S1_01a.red",
  lensFlareResource: "abyssal_white",
  lensFlareTypeID: 47435,
  weatherObjectTypeID: 47381,
  limitations: [
    "The type-47469 room-one pylon is retail-captured, but its position was omitted by the truncated SetState and is not materialized by this profile.",
  ],
  rooms: [
    { dungeonID: 6052, dungeonRoomID: 24585, volumetricCloudObjectTypeID: 47665, volumetricCloudDunObjectID: 1057970, nebulaGraphicID: 22048, sceneCubeResource: "res:/dx9/scene/abyssal/ad04_a_cube.red" },
    { dungeonID: 6049, dungeonRoomID: 24579, volumetricCloudObjectTypeID: 47662, volumetricCloudDunObjectID: 1057961, nebulaGraphicID: 22207, sceneCubeResource: "res:/dx9/scene/abyssal/ad04_b_cube.red" },
    { dungeonID: 6048, dungeonRoomID: 24574, volumetricCloudObjectTypeID: 47661, volumetricCloudDunObjectID: 1057964, nebulaGraphicID: 22208, sceneCubeResource: "res:/dx9/scene/abyssal/ad04_c_cube.red" },
  ],
});

// TQTranquilExotic1.txt, 2026-07-17 01:38:18--01:47:26.
// Kept under its legacy layout identity so existing callers can still request it.
const TIER0_EXOTIC_LEGACY_CAPTURED_PROFILE = buildCapturedEnvironmentProfile({
  profileID: "abyssal:environment-profile:tier0-exotic-legacy-captured-a-v1",
  weatherType: "exotic",
  layoutVariant: TIER0_EXOTIC_LEGACY_CAPTURED_LAYOUT_VARIANT,
  evidence: ABYSSAL_ENVIRONMENT_PROFILE_EVIDENCE.RETAIL_CAPTURED,
  nearFieldResource: "NF_Abyssal_CausticToxin_S1_01a.red",
  lensFlareResource: "abyssal_white",
  lensFlareTypeID: 47435,
  weatherObjectTypeID: 47384,
  limitations: [
    "Room identities, cloud balls, nebulae, Caustic Toxin presentation, and suppressor overlays come from TQTranquilExotic1.txt.",
  ],
  rooms: [
    {
      dungeonID: 6204,
      dungeonRoomID: 24754,
      volumetricCloudObjectTypeID: 47667,
      volumetricCloudDunObjectID: 1059503,
      nebulaGraphicID: 22209,
      sceneCubeResource: "res:/dx9/scene/abyssal/ad05_a_cube.red",
      functionalOverlays: [{
        typeID: 47438,
        dunObjectID: 1059703,
        offset: { x: 11569.4375, y: 26287.869140625, z: -40177.265625 },
      }],
    },
    {
      dungeonID: 6205,
      dungeonRoomID: 24751,
      volumetricCloudObjectTypeID: 47668,
      volumetricCloudDunObjectID: 1059504,
      nebulaGraphicID: 22210,
      sceneCubeResource: "res:/dx9/scene/abyssal/ad05_b_cube.red",
      functionalOverlays: [{
        typeID: 47437,
        dunObjectID: 1059704,
        offset: { x: 1632.845703125, y: 22718.048828125, z: 1079.244140625 },
      }],
    },
    {
      dungeonID: 6203,
      dungeonRoomID: 24749,
      volumetricCloudObjectTypeID: 47666,
      volumetricCloudDunObjectID: 1059496,
      nebulaGraphicID: 22211,
      sceneCubeResource: "res:/dx9/scene/abyssal/ad05_c_cube.red",
    },
  ],
});

const TIER0_EXOTIC_AUTHORED_CAPTURE = resolveGeneratedAuthoredCapture(
  "tq-tranquil-exotic-8",
);
if (!TIER0_EXOTIC_AUTHORED_CAPTURE) {
  throw new Error("AUTHORED_TRANQUIL_EXOTIC_CAPTURE_NOT_REGISTERED");
}
const TIER0_EXOTIC_CAPTURED_PROFILE = buildCapturedEnvironmentProfile({
  profileID: "abyssal:environment-profile:tier0-exotic-captured-a-v1",
  tier: TIER0_EXOTIC_AUTHORED_CAPTURE.tier,
  weatherType: "exotic",
  layoutVariant: TIER0_EXOTIC_CAPTURED_LAYOUT_VARIANT,
  evidence: ABYSSAL_ENVIRONMENT_PROFILE_EVIDENCE.RETAIL_CAPTURED,
  nearFieldResource: "NF_Abyssal_CausticToxin_S1_01a.red",
  lensFlareResource: getAbyssalLensFlare(
    TIER0_EXOTIC_AUTHORED_CAPTURE.rooms[0].environment.lensFlareTypeID,
  ).resource,
  lensFlareTypeID:
    TIER0_EXOTIC_AUTHORED_CAPTURE.rooms[0].environment.lensFlareTypeID,
  weatherObjectTypeID: TIER0_EXOTIC_AUTHORED_CAPTURE.weatherBallTypeID,
  limitations: [
    "Room and presentation references are normalized from tq-tranquil-exotic-8.",
    "This profile does not claim retail-exact weather mechanics or presentation timing.",
  ],
  rooms: TIER0_EXOTIC_AUTHORED_CAPTURE.rooms.map((room) => {
    const cloud = room.entities.find((entity) =>
      entity.entityID === room.environment.volumetricCloudEntityID
    );
    const nebula = getAbyssalNebula(room.environment.sceneNebulaGraphicID);
    if (!cloud || !nebula) {
      throw new Error(
        `AUTHORED_TRANQUIL_EXOTIC_PRESENTATION_INCOMPLETE:room-${room.roomNumber}`,
      );
    }
    return {
      dungeonID: room.geometry.dungeonID,
      dungeonRoomID: room.geometry.sourceRoomID,
      volumetricCloudObjectTypeID: cloud.typeID,
      volumetricCloudDunObjectID: cloud.dunObjectID,
      nebulaGraphicID: room.environment.sceneNebulaGraphicID,
      sceneCubeResource: nebula.sceneCubeResource,
      functionalOverlays: buildCapturedFunctionalOverlays(room),
      capturedLocalTransforms: buildCapturedRoomAnchorTransforms(room),
    };
  }),
});
// TQTranquilAbyssal2.txt, 2026-07-15 16:46:08--16:56:26.
const TIER0_FIRESTORM_CAPTURED_PROFILE = buildCapturedEnvironmentProfile({
  profileID: "abyssal:environment-profile:tier0-firestorm-captured-a-v1",
  weatherType: "firestorm",
  layoutVariant: TIER0_FIRESTORM_CAPTURED_LAYOUT_VARIANT,
  nearFieldResource: "NF_Abyssal_Infernal_S1_01a.red",
  lensFlareResource: "abyssal_yellow",
  lensFlareTypeID: 47760,
  weatherObjectTypeID: 47390,
  rooms: [
    {
      dungeonID: 6048,
      dungeonRoomID: 24574,
      volumetricCloudObjectTypeID: 47661,
      volumetricCloudDunObjectID: 1057964,
      nebulaGraphicID: 22209,
      sceneCubeResource: "res:/dx9/scene/abyssal/ad05_a_cube.red",
    },
    {
      dungeonID: 6049,
      dungeonRoomID: 24579,
      volumetricCloudObjectTypeID: 47662,
      volumetricCloudDunObjectID: 1057961,
      nebulaGraphicID: 22210,
      sceneCubeResource: "res:/dx9/scene/abyssal/ad05_b_cube.red",
    },
    {
      dungeonID: 6050,
      dungeonRoomID: 24580,
      volumetricCloudObjectTypeID: 47663,
      volumetricCloudDunObjectID: 1057966,
      nebulaGraphicID: 22211,
      sceneCubeResource: "res:/dx9/scene/abyssal/ad05_c_cube.red",
    },
  ],
});

// TQTranquilAbyssal3.txt, 2026-07-15 16:59:02--17:08:10.
const TIER0_GAMMA_CAPTURED_PROFILE = buildCapturedEnvironmentProfile({
  profileID: "abyssal:environment-profile:tier0-gamma-captured-a-v1",
  weatherType: "gamma",
  layoutVariant: TIER0_GAMMA_CAPTURED_LAYOUT_VARIANT,
  nearFieldResource: "NF_Abyssal_XenonGas_S1_01a.red",
  lensFlareResource: "abyssal_white",
  lensFlareTypeID: 47435,
  weatherObjectTypeID: 47387,
  rooms: [
    {
      dungeonID: 6204,
      dungeonRoomID: 24754,
      volumetricCloudObjectTypeID: 47667,
      volumetricCloudDunObjectID: 1059503,
      nebulaGraphicID: 22041,
      sceneCubeResource: "res:/dx9/scene/abyssal/ad01_a_cube.red",
    },
    {
      dungeonID: 6207,
      dungeonRoomID: 24753,
      volumetricCloudObjectTypeID: 47670,
      volumetricCloudDunObjectID: 1059505,
      nebulaGraphicID: 22041,
      sceneCubeResource: "res:/dx9/scene/abyssal/ad01_a_cube.red",
      functionalOverlays: [{
        typeID: 47437,
        dunObjectID: 1059725,
        offset: { x: 43805, y: 23102.859375, z: -22475.68359375 },
      }],
    },
    {
      dungeonID: 6205,
      dungeonRoomID: 24751,
      volumetricCloudObjectTypeID: 47668,
      volumetricCloudDunObjectID: 1059504,
      nebulaGraphicID: 22041,
      sceneCubeResource: "res:/dx9/scene/abyssal/ad01_a_cube.red",
      functionalOverlays: [{
        typeID: 47469,
        dunObjectID: 1059705,
        offset: { x: 28168.275390625, y: -1773.341796875, z: -41891.27734375 },
      }],
    },
  ],
});

const TIER1_ELECTRICAL_CAPTURED_PROFILE = buildCapturedEnvironmentProfile({
  profileID: "abyssal:environment-profile:tier1-electrical-captured-a-v1",
  tier: 1,
  weatherType: "electrical",
  layoutVariant: TIER1_ELECTRICAL_CAPTURED_LAYOUT_VARIANT,
  nearFieldResource: "NF_Abyssal_ElectricStorm_S1_01a.red",
  lensFlareResource: "abyssal_pink",
  lensFlareTypeID: 47433,
  weatherObjectTypeID: 47381,
  limitations: ["Captured from TQCalmAbysaal1.txt."],
  rooms: [
    { dungeonID: 6050, dungeonRoomID: 24580, volumetricCloudObjectTypeID: 47663, volumetricCloudDunObjectID: 1057966, nebulaGraphicID: 22048, sceneCubeResource: "res:/dx9/scene/abyssal/ad04_a_cube.red" },
    { dungeonID: 6052, dungeonRoomID: 24585, volumetricCloudObjectTypeID: 47665, volumetricCloudDunObjectID: 1057970, nebulaGraphicID: 22207, sceneCubeResource: "res:/dx9/scene/abyssal/ad04_b_cube.red" },
    { dungeonID: 6051, dungeonRoomID: 24584, volumetricCloudObjectTypeID: 47664, volumetricCloudDunObjectID: 1057967, nebulaGraphicID: 22208, sceneCubeResource: "res:/dx9/scene/abyssal/ad04_c_cube.red" },
  ],
});

const TIER1_ELECTRICAL_CAPTURED_PROFILE_B = buildCapturedEnvironmentProfile({
  profileID: "abyssal:environment-profile:tier1-electrical-captured-b-v1",
  tier: 1,
  weatherType: "electrical",
  layoutVariant: TIER1_ELECTRICAL_CAPTURED_LAYOUT_VARIANT_B,
  nearFieldResource: "NF_Abyssal_ElectricStorm_S1_01a.red",
  lensFlareResource: "abyssal_pink",
  lensFlareTypeID: 47433,
  weatherObjectTypeID: 47381,
  limitations: [
    "Captured from TQCalmAbysaal2.txt.",
    "Functional-overlay positions were omitted by the truncated SetState, so those overlays are not materialized.",
  ],
  rooms: [
    { dungeonID: 6051, dungeonRoomID: 24584, volumetricCloudObjectTypeID: 47664, volumetricCloudDunObjectID: 1057967, nebulaGraphicID: 22045, sceneCubeResource: "res:/dx9/scene/abyssal/ad03_a_cube.red" },
    { dungeonID: 6049, dungeonRoomID: 24579, volumetricCloudObjectTypeID: 47662, volumetricCloudDunObjectID: 1057961, nebulaGraphicID: 22046, sceneCubeResource: "res:/dx9/scene/abyssal/ad03_b_cube.red" },
    { dungeonID: 6048, dungeonRoomID: 24574, volumetricCloudObjectTypeID: 47661, volumetricCloudDunObjectID: 1057964, nebulaGraphicID: 22047, sceneCubeResource: "res:/dx9/scene/abyssal/ad03_c_cube.red" },
  ],
});

const TIER1_EXOTIC_CAPTURED_PROFILE = buildCapturedEnvironmentProfile({
  profileID: "abyssal:environment-profile:tier1-exotic-captured-a-v1",
  tier: 1,
  weatherType: "exotic",
  layoutVariant: TIER1_EXOTIC_CAPTURED_LAYOUT_VARIANT,
  nearFieldResource: "NF_Abyssal_CausticToxin_S1_01a.red",
  lensFlareResource: "abyssal_yellow",
  lensFlareTypeID: 47760,
  weatherObjectTypeID: 47385,
  limitations: ["Captured from TQCalmAbysaal3.txt."],
  rooms: [
    { dungeonID: 6050, dungeonRoomID: 24580, volumetricCloudObjectTypeID: 47663, volumetricCloudDunObjectID: 1057966, nebulaGraphicID: 22212, sceneCubeResource: "res:/dx9/scene/abyssal/ad06_a_cube.red" },
    { dungeonID: 6049, dungeonRoomID: 24579, volumetricCloudObjectTypeID: 47662, volumetricCloudDunObjectID: 1057961, nebulaGraphicID: 22213, sceneCubeResource: "res:/dx9/scene/abyssal/ad06_b_cube.red" },
    { dungeonID: 6051, dungeonRoomID: 24584, volumetricCloudObjectTypeID: 47664, volumetricCloudDunObjectID: 1057967, nebulaGraphicID: 22214, sceneCubeResource: "res:/dx9/scene/abyssal/ad06_c_cube.red" },
  ],
});

const TIER1_GAMMA_CAPTURED_PROFILE = buildCapturedEnvironmentProfile({
  profileID: "abyssal:environment-profile:tier1-gamma-captured-a-v1",
  tier: 1,
  weatherType: "gamma",
  layoutVariant: TIER1_GAMMA_CAPTURED_LAYOUT_VARIANT,
  nearFieldResource: "NF_Abyssal_XenonGas_S1_01a.red",
  lensFlareResource: "abyssal_purple",
  lensFlareTypeID: 47434,
  weatherObjectTypeID: 47387,
  limitations: [
    "Captured from TQCalmGamma1.txt.",
    "Functional-overlay positions were omitted by the truncated SetState, so those overlays are not materialized.",
  ],
  rooms: [
    { dungeonID: 6049, dungeonRoomID: 24579, volumetricCloudObjectTypeID: 47662, volumetricCloudDunObjectID: 1057961, nebulaGraphicID: 22042, sceneCubeResource: "res:/dx9/scene/abyssal/ad02_a_cube.red" },
    { dungeonID: 6050, dungeonRoomID: 24580, volumetricCloudObjectTypeID: 47663, volumetricCloudDunObjectID: 1057966, nebulaGraphicID: 22043, sceneCubeResource: "res:/dx9/scene/abyssal/ad02_b_cube.red" },
    { dungeonID: 6052, dungeonRoomID: 24585, volumetricCloudObjectTypeID: 47665, volumetricCloudDunObjectID: 1057970, nebulaGraphicID: 22044, sceneCubeResource: "res:/dx9/scene/abyssal/ad02_c_cube.red" },
  ],
});

const WEATHER_MATCHED_PRESENTATION_BASE_PROFILES = Object.freeze({
  dark: TIER0_DARK_CAPTURED_PROFILE,
  electrical: TIER0_ELECTRICAL_CAPTURED_PROFILE,
  exotic: TIER0_EXOTIC_CAPTURED_PROFILE,
  firestorm: TIER0_FIRESTORM_CAPTURED_PROFILE,
  gamma: TIER0_GAMMA_CAPTURED_PROFILE,
});

function buildEmpiricalObjectEnvironmentProfile(
  tier,
  weatherType,
  layoutVariant,
  sourceModelID,
) {
  return deepFreeze({
    profileID:
      `abyssal:environment-profile:tier${tier}-${weatherType}-empirical-objects-v1`,
    tier,
    weatherType,
    layoutVariant,
    evidence: ABYSSAL_ENVIRONMENT_PROFILE_EVIDENCE.EMPIRICAL_OBJECT_IDENTITIES,
    contentAuthority: ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
    normalSelectionEligible: true,
    environmentSource: "abyssal-space-observed-objects-with-authored-placement",
    presentationEnabled: true,
    mechanicsEnabled: true,
    transitionEffect: "effects.JumpOutAbyssal",
    authorityFacets: {
      objectIdentity: {
        contentAuthority: ABYSSAL_CONTENT_AUTHORITY.OBSERVED_EMPIRICAL,
        sourceModelID,
      },
      placement: {
        contentAuthority: ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
        placementModel: "deterministic-inferred-per-selected-room-observation",
      },
      exactRetailGeometry: {
        contentAuthority: ABYSSAL_CONTENT_AUTHORITY.PROVISIONAL,
        verified: false,
      },
    },
    limitations: [
      `Room-object identities come from the selected Tier ${tier} abyssal.space observation.`,
      "The source does not contain transforms; placement is deterministic and project-authored.",
      "Telemetry-only tracking-pylon records remain presentation-only, while canonical pylon mechanics remain available to captured or explicitly functional reconstructed placements.",
      `No lower-tier weather-specific room layout, cloud geometry, or scenery objects are reused for Tier ${tier}.`,
      "A weather-matched captured nebula identifier is shared only for client Abyssal location and HUD bootstrap.",
    ],
    rooms: Object.fromEntries([1, 2, 3].map((roomIndex) => {
      const clientLocationSourceProfile =
        WEATHER_MATCHED_PRESENTATION_BASE_PROFILES[weatherType];
      const clientLocationSourceRoom = clientLocationSourceProfile &&
        clientLocationSourceProfile.rooms[String(roomIndex)];
      return [
        roomIndex,
        {
          roomIndex,
          nebulaGraphicID:
            Number.parseInt(clientLocationSourceRoom &&
              clientLocationSourceRoom.nebulaGraphicID, 10) || 0,
          nebulaGraphicIDSourceProfileID: String(
            (clientLocationSourceProfile && clientLocationSourceProfile.profileID) || "",
          ),
          nebulaGraphicIDUsage: "client-abyssal-location-hud-bootstrap-only",
          roomLayoutProfileID:
            `abyssal:environment:tier${tier}-${weatherType}:room-${roomIndex}:empirical-objects-authored-placement-v1`,
          functionalOverlays: [],
        },
      ];
    })),
  });
}

const TIER1_DARK_EMPIRICAL_PROFILE = buildEmpiricalObjectEnvironmentProfile(
  1,
  "dark",
  TIER1_DARK_EMPIRICAL_LAYOUT_VARIANT,
  "abyssal-space:tier1-observed-2026-08-v1",
);
const TIER1_FIRESTORM_EMPIRICAL_PROFILE =
  buildEmpiricalObjectEnvironmentProfile(
    1,
    "firestorm",
    TIER1_FIRESTORM_EMPIRICAL_LAYOUT_VARIANT,
    "abyssal-space:tier1-observed-2026-08-v1",
  );
const TIER2_EMPIRICAL_ENVIRONMENT_PROFILES = [
  "dark",
  "electrical",
  "exotic",
  "firestorm",
  "gamma",
].map((weatherType) => buildEmpiricalObjectEnvironmentProfile(
  2,
  weatherType,
  `tier2-${weatherType}-empirical-objects-a`,
  "abyssal-space:tier2-observed-2026-08-v1",
));
const TIER3_EMPIRICAL_ENVIRONMENT_PROFILES = [
  "dark",
  "electrical",
  "exotic",
  "firestorm",
  "gamma",
].map((weatherType) => buildEmpiricalObjectEnvironmentProfile(
  3,
  weatherType,
  `tier3-${weatherType}-empirical-objects-a`,
  "abyssal-space:tier3-observed-2026-08-v1",
));
const TIER4_EMPIRICAL_ENVIRONMENT_PROFILES = [
  "dark",
  "electrical",
  "exotic",
  "firestorm",
  "gamma",
].map((weatherType) => buildEmpiricalObjectEnvironmentProfile(
  4,
  weatherType,
  `tier4-${weatherType}-empirical-objects-a`,
  "abyssal-space:tier4-observed-2026-08-v1",
));
const TIER5_EMPIRICAL_ENVIRONMENT_PROFILES = [
  "dark",
  "electrical",
  "exotic",
  "firestorm",
  "gamma",
].map((weatherType) => buildEmpiricalObjectEnvironmentProfile(
  5,
  weatherType,
  `tier5-${weatherType}-empirical-objects-a`,
  "abyssal-space:tier5-observed-2026-08-v1",
));
const TIER6_EMPIRICAL_ENVIRONMENT_PROFILES = [
  "dark",
  "electrical",
  "exotic",
  "firestorm",
  "gamma",
].map((weatherType) => buildEmpiricalObjectEnvironmentProfile(
  6,
  weatherType,
  `tier6-${weatherType}-empirical-objects-a`,
  "abyssal-space:tier6-observed-2026-08-v1",
));

const GENERATED_AUTHORED_ENVIRONMENT_PROFILES = getGeneratedAuthoredCatalogue()
  .captures
  .filter((capture) =>
    capture.captureKey !== "tq-tranquil-exotic-8" &&
    !(capture.existingRegistration && capture.existingRegistration.reused === true)
  )
  .map(buildGeneratedAuthoredEnvironmentProfile);

const CAPTURED_ENVIRONMENT_PROFILES = deepFreeze([
  TIER0_DARK_CAPTURED_PROFILE,
  TIER0_ELECTRICAL_CAPTURED_PROFILE,
  TIER0_ELECTRICAL_CAPTURED_PROFILE_B,
  TIER0_EXOTIC_CAPTURED_PROFILE,
  TIER0_EXOTIC_LEGACY_CAPTURED_PROFILE,
  TIER0_FIRESTORM_CAPTURED_PROFILE,
  TIER0_GAMMA_CAPTURED_PROFILE,
  TIER1_ELECTRICAL_CAPTURED_PROFILE,
  TIER1_ELECTRICAL_CAPTURED_PROFILE_B,
  TIER1_EXOTIC_CAPTURED_PROFILE,
  TIER1_GAMMA_CAPTURED_PROFILE,
]);

const REGISTERED_ENVIRONMENT_PROFILES = deepFreeze([
  ...GENERATED_AUTHORED_ENVIRONMENT_PROFILES,
  ...CAPTURED_ENVIRONMENT_PROFILES,
  TIER1_DARK_EMPIRICAL_PROFILE,
  TIER1_FIRESTORM_EMPIRICAL_PROFILE,
  ...TIER2_EMPIRICAL_ENVIRONMENT_PROFILES,
  ...TIER3_EMPIRICAL_ENVIRONMENT_PROFILES,
  ...TIER4_EMPIRICAL_ENVIRONMENT_PROFILES,
  ...TIER5_EMPIRICAL_ENVIRONMENT_PROFILES,
  ...TIER6_EMPIRICAL_ENVIRONMENT_PROFILES,
]);

const ABYSSAL_ENVIRONMENT_PROFILES_BY_KEY = deepFreeze(Object.fromEntries(
  REGISTERED_ENVIRONMENT_PROFILES.map((profile) => [
    buildProfileKey(profile.tier, profile.weatherType, profile.layoutVariant),
    profile,
  ]),
));

const LAYOUT_VARIANTS_BY_TIER_WEATHER = deepFreeze(
  REGISTERED_ENVIRONMENT_PROFILES.reduce((result, profile) => {
    if (profile.normalSelectionEligible !== true) {
      return result;
    }
    const key = `${profile.tier}:${profile.weatherType}`;
    result[key] = [...new Set([...(result[key] || []), profile.layoutVariant])];
    return result;
  }, {}),
);

const DEFAULT_LAYOUT_VARIANTS_BY_TIER_WEATHER = deepFreeze({
  "0:dark": TIER0_DARK_CAPTURED_LAYOUT_VARIANT,
  "0:electrical": TIER0_ELECTRICAL_CAPTURED_LAYOUT_VARIANT,
  "0:exotic": TIER0_EXOTIC_CAPTURED_LAYOUT_VARIANT,
  "0:firestorm": TIER0_FIRESTORM_CAPTURED_LAYOUT_VARIANT,
  "0:gamma": TIER0_GAMMA_CAPTURED_LAYOUT_VARIANT,
  "1:dark": TIER1_DARK_EMPIRICAL_LAYOUT_VARIANT,
  "1:electrical": TIER1_ELECTRICAL_CAPTURED_LAYOUT_VARIANT,
  "1:exotic": TIER1_EXOTIC_CAPTURED_LAYOUT_VARIANT,
  "1:firestorm": TIER1_FIRESTORM_EMPIRICAL_LAYOUT_VARIANT,
  "1:gamma": TIER1_GAMMA_CAPTURED_LAYOUT_VARIANT,
  "2:dark": "tier2-dark-empirical-objects-a",
  "2:electrical": "tier2-electrical-empirical-objects-a",
  "2:exotic": "tier2-exotic-empirical-objects-a",
  "2:firestorm": "tier2-firestorm-empirical-objects-a",
  "2:gamma": "tier2-gamma-empirical-objects-a",
  "3:dark": "tier3-dark-empirical-objects-a",
  "3:electrical": "tier3-electrical-empirical-objects-a",
  "3:exotic": "tier3-exotic-empirical-objects-a",
  "3:firestorm": "tier3-firestorm-empirical-objects-a",
  "3:gamma": "tier3-gamma-empirical-objects-a",
  "4:dark": "tier4-dark-empirical-objects-a",
  "4:electrical": "tier4-electrical-empirical-objects-a",
  "4:exotic": "tier4-exotic-empirical-objects-a",
  "4:firestorm": "tier4-firestorm-empirical-objects-a",
  "4:gamma": "tier4-gamma-empirical-objects-a",
  "5:dark": "tier5-dark-empirical-objects-a",
  "5:electrical": "tier5-electrical-empirical-objects-a",
  "5:exotic": "tier5-exotic-empirical-objects-a",
  "5:firestorm": "tier5-firestorm-empirical-objects-a",
  "5:gamma": "tier5-gamma-empirical-objects-a",
  "6:dark": "tier6-dark-empirical-objects-a",
  "6:electrical": "tier6-electrical-empirical-objects-a",
  "6:exotic": "tier6-exotic-empirical-objects-a",
  "6:firestorm": "tier6-firestorm-empirical-objects-a",
  "6:gamma": "tier6-gamma-empirical-objects-a",
});

function resolveDefaultLayoutVariant(tier, weatherType) {
  const key = [
    Number.isFinite(Number(tier)) ? Math.trunc(Number(tier)) : -1,
    String(weatherType || "").trim().toLowerCase(),
  ].join(":");
  return DEFAULT_LAYOUT_VARIANTS_BY_TIER_WEATHER[key] || "";
}

function hashSelectionSeed(value) {
  let hash = 2_166_136_261;
  for (const character of String(value == null ? "" : value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  return hash >>> 0;
}

function listAbyssalEnvironmentLayoutVariants(tier, weatherType) {
  const key = [
    Number.isFinite(Number(tier)) ? Math.trunc(Number(tier)) : -1,
    String(weatherType || "").trim().toLowerCase(),
  ].join(":");
  return [...(LAYOUT_VARIANTS_BY_TIER_WEATHER[key] || [])];
}

function selectAbyssalEnvironmentLayoutVariant(options = {}) {
  const variants = listAbyssalEnvironmentLayoutVariants(
    options.tier,
    options.weatherType,
  );
  if (variants.length === 0) return "";
  if (variants.length === 1) return variants[0];
  const selectionSeed = options.selectionSeed == null
    ? `${options.tier}:${options.weatherType}`
    : options.selectionSeed;
  return variants[hashSelectionSeed(selectionSeed) % variants.length];
}

function resolveAbyssalEnvironmentProfile(options = {}) {
  if (isProceduralEnvironment(options.layoutVariant)) {
    return buildProceduralEnvironmentProfile(options);
  }
  const tier = Number.isFinite(Number(options.tier))
    ? Math.trunc(Number(options.tier))
    : -1;
  const weatherType = String(options.weatherType || "").trim().toLowerCase();
  const requestedLayoutVariant = String(options.layoutVariant || "").trim().toLowerCase();
  const layoutVariant = requestedLayoutVariant || resolveDefaultLayoutVariant(tier, weatherType);
  if (tier < 0 || !weatherType) {
    return null;
  }
  const profile = layoutVariant
    ? ABYSSAL_ENVIRONMENT_PROFILES_BY_KEY[
      buildProfileKey(tier, weatherType, layoutVariant)
    ]
    : null;
  // Missing/retired layouts must not borrow a captured room of the same weather.
  return profile ? cloneValue(profile) : null;
}

function resolveAbyssalEnvironmentRoomProfile(options = {}) {
  const profile = resolveAbyssalEnvironmentProfile(options);
  const roomIndex = Number.isFinite(Number(options.roomIndex))
    ? Math.trunc(Number(options.roomIndex))
    : 0;
  const room = profile && isProceduralEnvironment(options.layoutVariant)
    ? buildProceduralEnvironmentRoom({ ...options, roomIndex })
    : profile && profile.rooms && profile.rooms[String(roomIndex)];
  if (!profile || !room) {
    return null;
  }
  return {
    profileID: profile.profileID,
    tier: profile.tier,
    weatherType: profile.weatherType,
    layoutVariant: profile.layoutVariant,
    evidence: profile.evidence,
    contentAuthority: profile.contentAuthority,
    normalSelectionEligible: profile.normalSelectionEligible === true,
    presentationEnabled: profile.presentationEnabled === true,
    mechanicsEnabled: profile.mechanicsEnabled === true,
    transitionEffect: profile.transitionEffect,
    limitations: cloneValue(profile.limitations),
    ...cloneValue(room),
  };
}

module.exports = {
  ABYSSAL_ENVIRONMENT_PROFILE_EVIDENCE,
  TIER0_DARK_CAPTURED_LAYOUT_VARIANT,
  TIER0_ELECTRICAL_CAPTURED_LAYOUT_VARIANT,
  TIER0_ELECTRICAL_CAPTURED_LAYOUT_VARIANT_B,
  TIER0_EXOTIC_CAPTURED_LAYOUT_VARIANT,
  TIER0_EXOTIC_LEGACY_CAPTURED_LAYOUT_VARIANT,
  TIER0_EXOTIC_STATIC_LAYOUT_VARIANT,
  TIER0_FIRESTORM_CAPTURED_LAYOUT_VARIANT,
  TIER0_GAMMA_CAPTURED_LAYOUT_VARIANT,
  TIER1_ELECTRICAL_CAPTURED_LAYOUT_VARIANT,
  TIER1_ELECTRICAL_CAPTURED_LAYOUT_VARIANT_B,
  TIER1_EXOTIC_CAPTURED_LAYOUT_VARIANT,
  TIER1_GAMMA_CAPTURED_LAYOUT_VARIANT,
  listAbyssalEnvironmentLayoutVariants,
  selectAbyssalEnvironmentLayoutVariant,
  resolveDefaultLayoutVariant,
  resolveAbyssalEnvironmentProfile,
  resolveAbyssalEnvironmentRoomProfile,
};
