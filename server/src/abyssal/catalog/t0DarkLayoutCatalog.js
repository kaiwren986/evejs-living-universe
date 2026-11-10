"use strict";

const {
  FILAMENT_TYPE_ID,
  T0_DARK_RETAIL_CAPTURED_LAYOUT,
} = require("./t0DarkRetailCapturedLayout");
const {
  T0_DARK_TRANSITION_PROFILE_SET_ID,
  TRANSITION_POLICY_AUTHORITATIVE_CAPTURED,
} = require("./abyssalTransitionProfiles");
const {
  T0_DARK_VARIANT_BLUEPRINTS,
  getT0DarkDungeonCloudByDungeonID,
  getT0DarkWeatherPresentation,
  getAbyssalLensFlare,
  getAbyssalNebula,
} = require("./t0DarkDevMenuCatalog");
const {
  cloneValue,
  deepFreeze,
  normalizeText,
} = require("../domain/abyssalValueUtils");

const LAYOUT_SELECTION_SCHEMA_VERSION = 1;
const LAYOUT_CATALOG_VERSION = 4;
const LAYOUT_SELECTION_MODEL = "captured-production-explicit-staff-override";
const LEGACY_LAYOUT_SET_ID = "abyssal:t0:dark:run:retail-capture-001";
const SCENERY_POLICY_AUTHORITATIVE = "authoritative";
const SCENERY_POLICY_EXPERIMENTAL = "experimental";
const EVIDENCE_STATUS_CAPTURED_RETAIL = "captured-retail";
const EVIDENCE_STATUS_DEV_MENU_DERIVED = "dev-menu-derived";
const LEGACY_ROOM_LAYOUT_IDS = Object.freeze({
  1: "abyssal:t0:dark:room1:retail-capture-001",
  2: "abyssal:t0:dark:room2:retail-capture-001",
  3: "abyssal:t0:dark:room3:retail-capture-001",
});
const KNOWN_ROOM_ROLES = new Set([
  "weather_object",
  "functional_environmental_structure",
  "suppressor",
  "depth_boundary_object",
  "filament_cloud",
  "volumetric_cloud_ball",
  "decorative_crystal_debris",
  "decorative_extraction_cluster",
  "transfer_conduit",
  "origin_controller_marker",
  "npc",
  "reward_cache",
  "player_insertion_locator",
  "environmental_perimeter",
]);
const LEGACY_ENVIRONMENT_BY_ROOM = Object.freeze({
  1: Object.freeze({ dungeonID: 6204, cloudTypeID: 47667, cloudGraphicID: 22108, nebulaGraphicID: 22209, nebulaCode: "05A", weatherTypeID: 47378, lensTypeID: 47435, lensResource: "abyssal_white" }),
  2: Object.freeze({ dungeonID: 6207, cloudTypeID: 47670, cloudGraphicID: 22111, nebulaGraphicID: 22210, nebulaCode: "05B", weatherTypeID: 47378, lensTypeID: 47435, lensResource: "abyssal_white" }),
  3: Object.freeze({ dungeonID: 6205, cloudTypeID: 47668, cloudGraphicID: 22109, nebulaGraphicID: 22211, nebulaCode: "05C", weatherTypeID: 47378, lensTypeID: 47435, lensResource: "abyssal_white" }),
});
const CRITICAL_POSITION_ROLES = new Set([
  "reward_cache",
  "transfer_conduit",
  "origin_controller_marker",
  "suppressor",
]);

function normalizeLowerText(value) {
  return normalizeText(value).toLowerCase();
}

function toInt(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isFinitePosition(position) {
  return position && [position.x, position.y, position.z]
    .every((coordinate) => Number.isFinite(Number(coordinate)));
}

function fnv1a32(value) {
  let hash = 0x811c9dc5;
  for (const character of String(value || "")) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function canonicalRoomFingerprintInput(room) {
  const objects = (Array.isArray(room && room.objects) ? room.objects : [])
    .map((entry) => ({
      typeID: toInt(entry && entry.typeID, 0),
      dunObjectID: toInt(entry && entry.dunObjectID, 0),
      role: normalizeText(entry && entry.role),
      position: [
        Number(entry && entry.position && entry.position.x),
        Number(entry && entry.position && entry.position.y),
        Number(entry && entry.position && entry.position.z),
      ],
    }))
    .sort((left, right) => {
      const leftKey = JSON.stringify(left);
      const rightKey = JSON.stringify(right);
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
  return JSON.stringify({
    roomIndex: toInt(room && room.roomIndex, 0),
    dungeonID: toInt(room && room.dungeonID, 0),
    roomID: toInt(room && room.roomID, 0),
    objects,
  });
}

function computeRoomLayoutFingerprint(room) {
  return `fnv1a32:${fnv1a32(canonicalRoomFingerprintInput(room)).toString(16).padStart(8, "0")}`;
}

function buildCatalogRoom(roomIndex) {
  const room = T0_DARK_RETAIL_CAPTURED_LAYOUT.rooms[roomIndex];
  const layoutID = LEGACY_ROOM_LAYOUT_IDS[roomIndex];
  const environment = LEGACY_ENVIRONMENT_BY_ROOM[roomIndex];
  const nebula = getAbyssalNebula(environment.nebulaCode);
  return deepFreeze({
    ...cloneValue(room),
    layoutID,
    evidenceStatus: EVIDENCE_STATUS_CAPTURED_RETAIL,
    sceneryPolicy: SCENERY_POLICY_AUTHORITATIVE,
    transitionPolicy: TRANSITION_POLICY_AUTHORITATIVE_CAPTURED,
    transitionProfileSetID: T0_DARK_TRANSITION_PROFILE_SET_ID,
    tier: 0,
    weather: "dark",
    filamentTypeIDs: [FILAMENT_TYPE_ID],
    entities: cloneValue(room.objects),
    npcEncounter: {
      entries: cloneValue(room.npcEntries),
      objectiveType: "kill_all_captured_hostiles",
    },
    environmentObjects: cloneValue([
      ...room.functionalObjects,
      room.cloudObject,
      room.weatherObject,
    ].filter(Boolean)),
    rewardObjects: cloneValue(room.rewardCache ? [room.rewardCache] : []),
    conduitDefinitions: cloneValue(room.conduit ? [room.conduit] : []),
    evidence: {
      confidence: "CAPTURED_RETAIL_COMPLETE",
      sourceFile: "TQTranquilAbyssal5.txt",
      sourceSegment: "2026-07-15T23:20:24--2026-07-15T23:28:56",
      filamentTypeID: FILAMENT_TYPE_ID,
      roomIndex,
    },
    environmentProfile: {
      profileID: `abyssal:environment-profile:tier0-dark-captured-a-room${roomIndex}-v1`,
      tier: 0,
      weatherType: "dark",
      layoutVariant: "tier0-dark-captured-a",
      evidence: "RETAIL_CAPTURED",
      presentationEnabled: true,
      mechanicsEnabled: false,
      transitionEffect: "effects.JumpOutAbyssal",
      roomIndex,
      nebulaGraphicID: environment.nebulaGraphicID,
      volumetricCloudDungeonID: environment.dungeonID,
      dungeonRoomID: toInt(room.roomID, 0),
      volumetricCloudObjectTypeID: environment.cloudTypeID,
      volumetricCloudDunObjectID: toInt(room.cloudDunObjectID, 0),
      sceneCubeResource: nebula && nebula.sceneCubeResource,
      volumetricCloudResource: `res:/dx9/model/celestial/environment/cloud/volumetric/dungeons/${environment.dungeonID}/clouds_${environment.dungeonID}.red`,
      nearFieldResource: "NF_Abyssal_Darkness_S1_01a.red",
      lensFlareResource: environment.lensResource,
      lensFlareTypeID: environment.lensTypeID,
      gradientResource: null,
      weatherObjectTypeID: environment.weatherTypeID,
      roomLayoutProfileID: `abyssal:t0:dark:captured:room-${roomIndex}:props`,
      limitations: [],
    },
    enabled: true,
    selectionWeight: 1,
    fingerprint: computeRoomLayoutFingerprint(room),
    expectedEntityTotal: room.objects.length,
  });
}


function degreesToRadians(value) {
  return (Number(value) || 0) * Math.PI / 180;
}

function transformPosition(position, transform = {}) {
  if (!isFinitePosition(position)) return cloneValue(position);
  let x = Number(position.x);
  let y = Number(position.y);
  const z = Number(position.z);
  if (transform.mirrorX === true) x *= -1;
  if (transform.mirrorY === true) y *= -1;
  const yaw = degreesToRadians(transform.yawDegrees);
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  return {
    x: x * cos - y * sin,
    y: x * sin + y * cos,
    z,
  };
}

function transformRotation(rotation, transform = {}) {
  if (!Array.isArray(rotation) || rotation.length !== 3) return cloneValue(rotation);
  const transformed = rotation.map((entry) => Number(entry) || 0);
  transformed[2] += Number(transform.yawDegrees) || 0;
  if (transform.mirrorX === true || transform.mirrorY === true) transformed[2] *= -1;
  return transformed;
}

function transformVariantEntity(entity, roomSpec, variantID) {
  if (!entity || typeof entity !== "object") return entity;
  const cloud = getT0DarkDungeonCloudByDungeonID(roomSpec.dungeonID);
  const weather = getT0DarkWeatherPresentation(roomSpec.weatherStage);
  const lens = getAbyssalLensFlare(roomSpec.lensCode);
  const next = {
    ...cloneValue(entity),
    position: transformPosition(entity.position, roomSpec.transform),
    rotation: transformRotation(entity.rotation, roomSpec.transform),
    sourceEvidence: {
      ...cloneValue(entity.sourceEvidence),
      variantSource: "Abyssal Content Tool screenshots 12137.jpg--12143.jpg",
      variantID,
      transform: cloneValue(roomSpec.transform),
    },
  };
  if (normalizeText(entity.role) === "volumetric_cloud_ball" && cloud) {
    next.typeID = cloud.typeID;
    next.name = `${cloud.family[0].toUpperCase()}${cloud.family.slice(1)} Dungeon Cloud ${cloud.dungeonID}`;
    next.graphicID = cloud.graphicID;
  }
  if (normalizeText(entity.role) === "weather_object" && weather) {
    next.typeID = weather.typeID;
    next.name = `darkness_weather_${weather.stage}`;
  }
  if (toInt(entity.typeID, 0) === 47435 && lens) {
    next.typeID = lens.typeID;
    next.name = lens.code.replace("A", "A_");
    next.graphicID = toInt(lens.graphicID, toInt(entity.graphicID, 0));
  }
  return next;
}

function buildVariantRoom(baseRoomIndex, variant, roomSpec) {
  const baseRoom = cloneValue(buildCatalogRoom(baseRoomIndex));
  const cloud = getT0DarkDungeonCloudByDungeonID(roomSpec.dungeonID);
  const weather = getT0DarkWeatherPresentation(roomSpec.weatherStage);
  const lens = getAbyssalLensFlare(roomSpec.lensCode);
  const nebula = getAbyssalNebula(roomSpec.nebulaCode);
  if (!cloud || !weather || !lens || !nebula) {
    throw new Error(`INVALID_T0_DARK_VARIANT_BLUEPRINT:${variant.variantID}:room-${baseRoomIndex}`);
  }
  const transformEntries = (entries) => (Array.isArray(entries) ? entries : [])
    .map((entry) => transformVariantEntity(entry, roomSpec, variant.variantID));
  const room = {
    ...baseRoom,
    layoutID: `abyssal:t0:dark:room${baseRoomIndex}:${variant.variantID}-v1`,
    evidenceStatus: EVIDENCE_STATUS_DEV_MENU_DERIVED,
    sceneryPolicy: SCENERY_POLICY_AUTHORITATIVE,
    dungeonID: cloud.dungeonID,
    nebulaGraphicID: nebula.graphicID,
    cloudTypeID: cloud.typeID,
    objects: transformEntries(baseRoom.objects),
    props: transformEntries(baseRoom.props),
    functionalObjects: transformEntries(baseRoom.functionalObjects),
    npcEntries: transformEntries(baseRoom.npcEntries),
    weatherObject: transformVariantEntity(baseRoom.weatherObject, roomSpec, variant.variantID),
    cloudObject: transformVariantEntity(baseRoom.cloudObject, roomSpec, variant.variantID),
    conduit: transformVariantEntity(baseRoom.conduit, roomSpec, variant.variantID),
    rewardCache: transformVariantEntity(baseRoom.rewardCache, roomSpec, variant.variantID),
    evidence: {
      confidence: "DEV_MENU_TYPES_WITH_CAPTURED_GEOMETRY_TRANSFORM",
      sourceFile: "12137.jpg--12143.jpg",
      sourceSegment: "Abyssal Content Tool Tier 0 dropdowns",
      geometrySourceFile: "TQTranquilAbyssal5.txt",
      filamentTypeID: FILAMENT_TYPE_ID,
      roomIndex: baseRoomIndex,
      variantID: variant.variantID,
      limitations: "Dungeon presentation IDs are dev-menu/SDE derived; functional placement is a rigid transform of the known-good retail capture. The scenery policy is authoritative only for this selected EveJS layout and does not claim exact CCP coordinates.",
    },
    environmentProfile: {
      profileID: `abyssal:environment-profile:tier0-dark-${variant.variantID}-room${baseRoomIndex}-v1`,
      tier: 0,
      weatherType: "dark",
      layoutVariant: `tier0-dark-${variant.variantID}`,
      evidence: "DEV_MENU_TYPES_WITH_CAPTURED_GEOMETRY_TRANSFORM",
      presentationEnabled: true,
      mechanicsEnabled: false,
      transitionEffect: "effects.JumpOutAbyssal",
      roomIndex: baseRoomIndex,
      nebulaGraphicID: nebula.graphicID,
      volumetricCloudDungeonID: cloud.dungeonID,
      dungeonRoomID: toInt(baseRoom.roomID, 0),
      volumetricCloudObjectTypeID: cloud.typeID,
      volumetricCloudDunObjectID: toInt(baseRoom.cloudDunObjectID, 0),
      sceneCubeResource: nebula.sceneCubeResource,
      volumetricCloudResource: cloud.resource,
      nearFieldResource: "NF_Abyssal_Darkness_S1_01a.red",
      lensFlareResource: lens.resource,
      lensFlareTypeID: lens.typeID,
      gradientResource: null,
      weatherObjectTypeID: weather.typeID,
      roomLayoutProfileID: `abyssal:t0:dark:${variant.variantID}:room-${baseRoomIndex}:props`,
      limitations: [
        "Functional geometry is a rigid transform of the captured Tranquil Dark baseline.",
        "The dev menu proves the presentation choices but does not expose CCP's original room-object coordinates.",
      ],
    },
    enabled: true,
    selectionWeight: 1,
  };
  room.entities = cloneValue(room.objects);
  room.environmentObjects = cloneValue([
    ...room.functionalObjects,
    room.cloudObject,
    room.weatherObject,
  ].filter(Boolean));
  room.rewardObjects = cloneValue(room.rewardCache ? [room.rewardCache] : []);
  room.conduitDefinitions = cloneValue(room.conduit ? [room.conduit] : []);
  room.npcEncounter = {
    entries: cloneValue(room.npcEntries),
    objectiveType: "kill_all_variant_hostiles",
  };
  room.expectedEntityTotal = room.objects.length;
  room.fingerprint = computeRoomLayoutFingerprint(room);
  return deepFreeze(room);
}

function buildVariantLayoutSet(variant) {
  return deepFreeze({
    layoutSetID: `abyssal:t0:dark:run:${variant.variantID}-v1`,
    displayName: variant.label,
    evidenceStatus: EVIDENCE_STATUS_DEV_MENU_DERIVED,
    sceneryPolicy: SCENERY_POLICY_AUTHORITATIVE,
    transitionPolicy: TRANSITION_POLICY_AUTHORITATIVE_CAPTURED,
    transitionProfileSetID: T0_DARK_TRANSITION_PROFILE_SET_ID,
    tier: 0,
    weather: "dark",
    filamentTypeIDs: [FILAMENT_TYPE_ID],
    rooms: variant.rooms.map((roomSpec, index) => buildVariantRoom(index + 1, variant, roomSpec)),
    enabled: true,
    selectionWeight: Number(variant.selectionWeight) || 1,
    evidence: {
      confidence: "DEV_MENU_TYPES_WITH_CAPTURED_GEOMETRY_TRANSFORM",
      sourceFile: "12137.jpg--12143.jpg",
      geometrySourceFile: "TQTranquilAbyssal5.txt",
      selectionProbability: "PROVISIONAL_WEIGHTED_UNIFORM",
      runtimeSceneryRequirement: "REQUIRED_BY_SELECTED_LAYOUT",
      variantID: variant.variantID,
    },
  });
}

const LEGACY_LAYOUT_SET = deepFreeze({
  layoutSetID: LEGACY_LAYOUT_SET_ID,
  evidenceStatus: EVIDENCE_STATUS_CAPTURED_RETAIL,
  sceneryPolicy: SCENERY_POLICY_AUTHORITATIVE,
  transitionPolicy: TRANSITION_POLICY_AUTHORITATIVE_CAPTURED,
  transitionProfileSetID: T0_DARK_TRANSITION_PROFILE_SET_ID,
  tier: 0,
  weather: "dark",
  filamentTypeIDs: [FILAMENT_TYPE_ID],
  rooms: [buildCatalogRoom(1), buildCatalogRoom(2), buildCatalogRoom(3)],
  enabled: true,
  selectionWeight: 2,
  evidence: {
    confidence: "CAPTURED_RETAIL_COMPLETE",
    sourceFile: "TQTranquilAbyssal5.txt",
    sourceSegment: "2026-07-15T23:20:24--2026-07-15T23:28:56",
    selectionProbability: "UNKNOWN_PROVISIONAL_UNIFORM_WEIGHT",
  },
});

const DEV_MENU_VARIANT_LAYOUT_SETS = Object.freeze(
  T0_DARK_VARIANT_BLUEPRINTS.map((variant) => buildVariantLayoutSet(variant)),
);
const AUTHORED_LAYOUT_SETS = Object.freeze([
  LEGACY_LAYOUT_SET,
  ...DEV_MENU_VARIANT_LAYOUT_SETS,
]);

function validateLayoutSet(layoutSet, seenLayoutSetIDs, seenRoomLayoutIDs) {
  const errors = [];
  const layoutSetID = normalizeText(layoutSet && layoutSet.layoutSetID);
  if (!layoutSetID) errors.push("missing layout ID");
  if (layoutSetID && seenLayoutSetIDs.has(layoutSetID)) errors.push("duplicate layout ID");
  if (layoutSetID) seenLayoutSetIDs.add(layoutSetID);
  if (toInt(layoutSet && layoutSet.tier, -1) !== 0) errors.push("wrong tier");
  if (normalizeLowerText(layoutSet && layoutSet.weather) !== "dark") errors.push("wrong weather");
  if (layoutSet && layoutSet.evidenceStatus === EVIDENCE_STATUS_CAPTURED_RETAIL) {
    if (layoutSet.transitionPolicy !== TRANSITION_POLICY_AUTHORITATIVE_CAPTURED) {
      errors.push("captured retail layout set must declare authoritative captured transitions");
    }
    if (normalizeText(layoutSet.transitionProfileSetID) !== T0_DARK_TRANSITION_PROFILE_SET_ID) {
      errors.push("captured retail layout set has the wrong transition profile set");
    }
  }
  if (!(layoutSet && Array.isArray(layoutSet.filamentTypeIDs) && layoutSet.filamentTypeIDs.includes(FILAMENT_TYPE_ID))) {
    errors.push("missing compatible filament type 56132");
  }
  if (!(layoutSet && layoutSet.evidence && normalizeText(layoutSet.evidence.sourceFile))) {
    errors.push("missing evidence metadata");
  }
  const layoutSceneryPolicy = normalizeText(layoutSet && layoutSet.sceneryPolicy);
  if (![SCENERY_POLICY_AUTHORITATIVE, SCENERY_POLICY_EXPERIMENTAL].includes(layoutSceneryPolicy)) {
    errors.push("layout set must declare an accepted scenery policy");
  }
  if (
    layoutSet && layoutSet.evidenceStatus === EVIDENCE_STATUS_CAPTURED_RETAIL &&
    layoutSceneryPolicy !== SCENERY_POLICY_AUTHORITATIVE
  ) {
    errors.push("captured retail layout set must declare authoritative scenery");
  }
  const rooms = Array.isArray(layoutSet && layoutSet.rooms) ? layoutSet.rooms : [];
  if (rooms.length !== 3) errors.push("complete run template must contain three rooms");
  for (let roomIndex = 1; roomIndex <= 3; roomIndex += 1) {
    const room = rooms.find((entry) => toInt(entry && entry.roomIndex, 0) === roomIndex);
    if (!room) {
      errors.push(`missing room ${roomIndex}`);
      continue;
    }
    const layoutID = normalizeText(room.layoutID);
    if (!layoutID) errors.push(`room ${roomIndex}: missing layout ID`);
    if (layoutID && seenRoomLayoutIDs.has(layoutID)) errors.push(`room ${roomIndex}: duplicate layout ID`);
    if (layoutID) seenRoomLayoutIDs.add(layoutID);
    if (toInt(room.roomIndex, 0) !== roomIndex) errors.push(`room ${roomIndex}: wrong room index`);
    if (!(room.evidence && normalizeText(room.evidence.sourceFile))) {
      errors.push(`room ${roomIndex}: missing evidence metadata`);
    }
    const roomSceneryPolicy = normalizeText(room.sceneryPolicy);
    if (![SCENERY_POLICY_AUTHORITATIVE, SCENERY_POLICY_EXPERIMENTAL].includes(roomSceneryPolicy)) {
      errors.push(`room ${roomIndex}: invalid scenery policy`);
    }
    if (
      room.evidenceStatus === EVIDENCE_STATUS_CAPTURED_RETAIL &&
      roomSceneryPolicy !== SCENERY_POLICY_AUTHORITATIVE
    ) {
      errors.push(`room ${roomIndex}: captured retail scenery is not authoritative`);
    }
    if (!(room.environmentProfile && toInt(room.environmentProfile.volumetricCloudDungeonID, 0) > 0)) {
      errors.push(`room ${roomIndex}: missing environment profile`);
    }
    const objects = Array.isArray(room.objects) ? room.objects : [];
    if (objects.length <= 0) errors.push(`room ${roomIndex}: missing entities`);
    const criticalPositions = new Set();
    for (const [objectIndex, object] of objects.entries()) {
      const role = normalizeText(object && object.role);
      if (!KNOWN_ROOM_ROLES.has(role)) {
        errors.push(`room ${roomIndex}: unresolved entity role at object ${objectIndex + 1}`);
      }
      if (!isFinitePosition(object && object.position)) {
        errors.push(`room ${roomIndex}: invalid numeric position at object ${objectIndex + 1}`);
      }
      if (toInt(object && object.typeID, 0) === 49662) {
        errors.push(`room ${roomIndex}: unexpected type 49662`);
      }
      if (!(object && object.sourceEvidence && normalizeText(object.sourceEvidence.capture))) {
        errors.push(`room ${roomIndex}: missing object evidence at object ${objectIndex + 1}`);
      }
      if (role === "origin_controller_marker" && (roomIndex !== 3 || toInt(object.typeID, 0) !== 47686)) {
        errors.push(`room ${roomIndex}: synthetic origin marker`);
      }
      if (CRITICAL_POSITION_ROLES.has(role) && isFinitePosition(object && object.position)) {
        const positionKey = [object.position.x, object.position.y, object.position.z].map(Number).join(":");
        if (criticalPositions.has(positionKey)) {
          errors.push(`room ${roomIndex}: duplicate critical functional position ${positionKey}`);
        }
        criticalPositions.add(positionKey);
      }
    }
    const conduit = objects.find((entry) => roomIndex < 3
      ? normalizeText(entry && entry.role) === "transfer_conduit" && toInt(entry && entry.typeID, 0) === 47685
      : normalizeText(entry && entry.role) === "origin_controller_marker" && toInt(entry && entry.typeID, 0) === 47686);
    if (!conduit) errors.push(roomIndex < 3
      ? `room ${roomIndex}: missing conduit`
      : "room 3: missing final exit");
  }
  return errors;
}

function buildValidatedCatalog() {
  const enabled = [];
  const disabled = [];
  const seenLayoutSetIDs = new Set();
  const seenRoomLayoutIDs = new Set();
  for (const layoutSet of AUTHORED_LAYOUT_SETS) {
    const errors = validateLayoutSet(layoutSet, seenLayoutSetIDs, seenRoomLayoutIDs);
    if (layoutSet.enabled === true && errors.length === 0) enabled.push(layoutSet);
    else disabled.push({
      layoutSetID: normalizeText(layoutSet && layoutSet.layoutSetID) || "unknown",
      errors: errors.length > 0 ? errors : ["layout disabled by data"],
    });
  }
  return deepFreeze({ enabled, disabled });
}

const VALIDATED_CATALOG = buildValidatedCatalog();

function isCompatibleT0DarkLayoutRequest(options = {}) {
  return toInt(options.tier, -1) === 0 &&
    normalizeLowerText(options.weatherType || options.weather) === "dark" &&
    toInt(options.filamentTypeID, 0) === FILAMENT_TYPE_ID;
}

function listEnabledT0DarkLayoutSets() {
  return cloneValue(VALIDATED_CATALOG.enabled);
}

function getT0DarkLayoutCatalogValidationReport() {
  return cloneValue(VALIDATED_CATALOG);
}

function resolveT0DarkLayoutSetByID(layoutSetID, options = {}) {
  const requestedID = normalizeText(layoutSetID);
  const source = options.includeKnownGoodFallback === true
    ? [...VALIDATED_CATALOG.enabled, LEGACY_LAYOUT_SET]
    : VALIDATED_CATALOG.enabled;
  const layoutSet = source.find((entry) => entry.layoutSetID === requestedID);
  return layoutSet ? cloneValue(layoutSet) : null;
}

function resolveT0DarkRoomLayoutByID(roomLayoutID) {
  const requestedID = normalizeText(roomLayoutID);
  for (const layoutSet of [...VALIDATED_CATALOG.enabled, LEGACY_LAYOUT_SET]) {
    const room = layoutSet.rooms.find((entry) => entry.layoutID === requestedID);
    if (room) return cloneValue(room);
  }
  return null;
}

function buildLegacyT0DarkLayoutSelectionState(source = "legacy-migration") {
  return {
    layoutSelectionSchemaVersion: LAYOUT_SELECTION_SCHEMA_VERSION,
    layoutCatalogVersion: LAYOUT_CATALOG_VERSION,
    layoutSelectionModel: LAYOUT_SELECTION_MODEL,
    layoutSelectionSeed: 0,
    selectedLayoutSetID: LEGACY_LAYOUT_SET_ID,
    selectedRoomLayoutIDs: cloneValue(LEGACY_ROOM_LAYOUT_IDS),
    layoutSelectionSource: source,
    layoutSelectionWeightsSummary: `${LEGACY_LAYOUT_SET_ID}=production-only`,
  };
}

function deriveT0DarkLayoutSelectionSeed(options = {}) {
  return fnv1a32([
    toInt(options.runID, 0),
    toInt(options.filamentTypeID, 0),
    toInt(options.tier, -1),
    normalizeLowerText(options.weatherType || options.weather),
  ].join(":"));
}

function selectT0DarkLayoutSet(options = {}) {
  if (!isCompatibleT0DarkLayoutRequest(options)) {
    return { success: false, errorMsg: "INCOMPATIBLE_T0_DARK_LAYOUT_REQUEST" };
  }
  const enabledLayouts = VALIDATED_CATALOG.enabled;
  const overrideLayoutID = normalizeText(options.overrideLayoutID);
  let selected = LEGACY_LAYOUT_SET;
  let source = "captured-production-default";
  if (overrideLayoutID) {
    selected = enabledLayouts.find((entry) => entry.layoutSetID === overrideLayoutID) || null;
    if (!selected) return { success: false, errorMsg: "UNKNOWN_OR_DISABLED_LAYOUT_ID" };
    source = "staff-override";
  }
  const selectionSeed = deriveT0DarkLayoutSelectionSeed(options);
  return {
    success: true,
    data: {
      layoutSet: cloneValue(selected),
      selectionState: {
        layoutSelectionSchemaVersion: LAYOUT_SELECTION_SCHEMA_VERSION,
        layoutCatalogVersion: LAYOUT_CATALOG_VERSION,
        layoutSelectionModel: LAYOUT_SELECTION_MODEL,
        layoutSelectionSeed: selectionSeed,
        selectedLayoutSetID: selected.layoutSetID,
        selectedRoomLayoutIDs: Object.fromEntries(
          selected.rooms.map((room) => [String(room.roomIndex), room.layoutID]),
        ),
        layoutSelectionSource: source,
        layoutSelectionWeightsSummary:
          `${LEGACY_LAYOUT_SET_ID}=production-only;development=staff-override-only`,
      },
    },
  };
}

function resolveSelectedT0DarkRoom(source, roomIndex) {
  const numericRoomIndex = toInt(roomIndex, 0);
  const selectedRoomLayoutIDs = source && source.selectedRoomLayoutIDs &&
    typeof source.selectedRoomLayoutIDs === "object"
    ? source.selectedRoomLayoutIDs
    : null;
  const roomLayoutID = normalizeText(
    selectedRoomLayoutIDs && (
      selectedRoomLayoutIDs[String(numericRoomIndex)] || selectedRoomLayoutIDs[numericRoomIndex]
    ),
  ) || LEGACY_ROOM_LAYOUT_IDS[numericRoomIndex];
  return resolveT0DarkRoomLayoutByID(roomLayoutID);
}

module.exports = {
  LAYOUT_SELECTION_SCHEMA_VERSION,
  LAYOUT_CATALOG_VERSION,
  LAYOUT_SELECTION_MODEL,
  LEGACY_LAYOUT_SET_ID,
  LEGACY_ROOM_LAYOUT_IDS,
  SCENERY_POLICY_AUTHORITATIVE,
  SCENERY_POLICY_EXPERIMENTAL,
  EVIDENCE_STATUS_CAPTURED_RETAIL,
  EVIDENCE_STATUS_DEV_MENU_DERIVED,
  DEV_MENU_VARIANT_LAYOUT_SETS,
  computeRoomLayoutFingerprint,
  isCompatibleT0DarkLayoutRequest,
  listEnabledT0DarkLayoutSets,
  getT0DarkLayoutCatalogValidationReport,
  resolveT0DarkLayoutSetByID,
  resolveT0DarkRoomLayoutByID,
  buildLegacyT0DarkLayoutSelectionState,
  deriveT0DarkLayoutSelectionSeed,
  selectT0DarkLayoutSet,
  resolveSelectedT0DarkRoom,
};
