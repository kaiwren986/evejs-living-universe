"use strict";

// Space object chat commands: /celestial and /lco (a celestial or large collidable object near
// the caller), /keepstar (a Palatine Keepstar visual), /fire and /fire2 (combat dummies: one
// ship, or a fleet in formation), /jetcan, and /container and /wreck (through the debris field
// handler), /testclear and /sysjunkclear (clearing debris near the caller or in the whole system), with the
// placement, entity building and ID allocation they share. handleSpawnContainerCommand and
// handleSpawnWreckCommand, which nothing has called since /container and /wreck moved to the
// debris field handler, came along unchanged.

const path = require("path");

const {
  createSpaceItemForCharacter,
  listContainerItems,
  ITEM_FLAGS,
  moveItemTypeFromCharacterLocation,
} = require("../../inventory/itemStore");
const {
  listAvailableDebrisTypes,
  resolveDebrisType,
  spawnDebrisFieldForSession,
  getSpaceDebrisLifetimeMs,
  clearNearbyDebrisForSession,
  clearSystemDebrisForSession,
} = require("../../inventory/spaceDebrisState");
const {
  resolveShipByName,
  resolveShipByTypeID,
} = require("../shipTypeRegistry");
const {
  resolveItemByTypeID,
  resolveItemByName,
} = require("../../inventory/itemTypeRegistry");
const {
  resolveRuntimeWreckRadius,
} = require("../../inventory/wreckRadius");
const {
  ENTITY_TYPE,
} = require(path.join(__dirname, "../../../space/entityConstants"));
const {
  BALL_FLAG,
} = require(path.join(__dirname, "../../../space/destiny/constants"));
const {
  buildChildEntityScopeMetadata,
} = require("../../../space/destiny/identity/interactionScope");
const spaceRuntime = require("../../../space/runtime");
const {
  handledResult,
} = require(path.join(__dirname, "./commandReplies"));
const {
  normalizePositiveInteger,
  splitTrailingAmount,
  parseOptionalTypeAndCount,
} = require(path.join(__dirname, "./commandArguments"));
const {
  formatSuggestions,
} = require(path.join(__dirname, "./commandSuggestions"));
const {
  isSpaceSessionReady,
} = require(path.join(__dirname, "./commandSessionLocation"));
const {
  syncInventoryChangesToSession,
} = require(path.join(__dirname, "./commandInventorySync"));
const {
  normalizeSpaceVector,
  addVectors,
  scaleVector,
  crossVectors,
  subtractVectors,
} = require(path.join(__dirname, "./spaceVectors"));

const DEFAULT_SPACE_CONTAINER_NAME = "Cargo Container";
const DEFAULT_SPACE_WRECK_NAME = "Wreck";
const CELESTIAL_CATEGORY_ID = 2;
const CELESTIAL_SPAWN_CLEARANCE_METERS = 1_000;
// Global but not massive, like planets on main and every TQ-captured LCO. A massive
// flag turns on client-side bumping, which DEC-001 keeps out.
const CELESTIAL_DESTINY_FLAGS = BALL_FLAG.IS_GLOBAL;
const LARGE_COLLIDABLE_OBJECT_GROUP_ID = 226;
const DEFAULT_FIRE_TARGET_NAME = "Drake";
const COMBAT_DUMMY_OWNER_ID = 1000006;
const COMBAT_DUMMY_CORPORATION_ID = 1000006;
const PALATINE_KEEPSTAR_TYPE_ID = 40340;
const KEEPSTAR_DEFAULT_SPAWN_DISTANCE_METERS = 400000;
const KEEPSTAR_DEFAULT_RADIUS_METERS = 150000;

const DEFAULT_FIRE2_FLEET_SIZE = 10;

const DEFAULT_FIRE2_FLEET_SHIP_NAMES = Object.freeze([
  "Avatar",
  "Revelation",
  "Rorqual",
  "Orca",
  "Abaddon",
  "Harbinger",
  "Maller",
  "Coercer",
  "Punisher",
  "Executioner",
]);
const FIRE2_BASE_DISTANCE_METERS = 32_000;
const FIRE2_ROW_SPACING_METERS = 11_000;
const FIRE2_LATERAL_SPACING_METERS = 8_000;
const FIRE2_OVERLAP_PADDING_METERS = 1_500;
// Runtime-only visual entities use a synthetic high itemID range so they never
// collide with inventory-backed rows and naturally disappear on restart.
let nextTransientVisualEntityID = 4000000000000000;
let nextCombatDummyEntityID = 3900000000000000;
// CCP parity: Jettisoned cargo containers persist for exactly 2 hours from
// creation regardless of contents.  They do NOT despawn when emptied -- the
// timer is purely time-based.  (Source: EVE University wiki, community-
// verified against live Tranquility behaviour.)
const JETCAN_LIFETIME_MS = 2 * 60 * 60 * 1000; // 2 hours

function syncSpaceRootInventoryChangesToSession(session, changes = []) {
  const numericSystemID = normalizePositiveInteger(
    session &&
      session._space &&
      session._space.systemID,
  );
  if (!numericSystemID) {
    return;
  }

  const filteredChanges = (Array.isArray(changes) ? changes : []).filter((change) => {
    const item = change && change.item;
    const previousData = change && (change.previousData || change.previousState);
    const nextLocationID = normalizePositiveInteger(item && item.locationID);
    const previousLocationID = normalizePositiveInteger(previousData && previousData.locationID);
    return (
      (nextLocationID === numericSystemID && Number(item && item.flagID) === 0) ||
      (previousLocationID === numericSystemID && Number(previousData && previousData.flagID) === 0)
    );
  });

  syncInventoryChangesToSession(session, filteredChanges);
}

function buildNearbySpaceSpawnState(shipEntity, distanceMeters = 250) {
  const position = {
    x: Number(shipEntity && shipEntity.position && shipEntity.position.x || 0),
    y: Number(shipEntity && shipEntity.position && shipEntity.position.y || 0),
    z: Number(shipEntity && shipEntity.position && shipEntity.position.z || 0),
  };
  const direction = normalizeSpaceVector(
    shipEntity && shipEntity.direction,
    { x: 1, y: 0, z: 0 },
  );
  return {
    position: addVectors(position, scaleVector(direction, Math.max(50, Number(distanceMeters) || 250))),
    velocity: { x: 0, y: 0, z: 0 },
    direction,
    mode: "STOP",
    speedFraction: 0,
  };
}

function buildCelestialEntity(itemType, shipEntity, options = {}) {
  if (
    !itemType ||
    Number(itemType.categoryID) !== CELESTIAL_CATEGORY_ID ||
    !shipEntity
  ) {
    return null;
  }

  const objectRadius = Math.max(1, Number(itemType.radius) || 1);
  const shipRadius = Math.max(0, Number(shipEntity.radius) || 0);
  const centerDistance =
    shipRadius + objectRadius + CELESTIAL_SPAWN_CLEARANCE_METERS;
  const spawnState = buildNearbySpaceSpawnState(shipEntity, centerDistance);
  const kind = String(options.kind || "celestial");

  const entity = {
    kind,
    commandSpawnedCelestial: true,
    itemID: allocateTransientVisualEntityID(),
    typeID: Number(itemType.typeID),
    groupID: Number(itemType.groupID),
    categoryID: CELESTIAL_CATEGORY_ID,
    graphicID: Number(itemType.graphicID) || null,
    ownerID: 1,
    itemName: itemType.name || `Celestial ${itemType.typeID}`,
    slimName: itemType.name || `Celestial ${itemType.typeID}`,
    radius: objectRadius,
    position: spawnState.position,
    velocity: spawnState.velocity,
    direction: spawnState.direction,
    staticVisibilityScope: "bubble",
    destinyBallMode: "RIGID",
    destinyBallFlags: CELESTIAL_DESTINY_FLAGS,
  };

  if (options.largeCollidableObject === true) {
    entity.commandSpawnedLargeCollidableObject = true;
  }
  return entity;
}

function buildLargeCollidableObjectEntity(itemType, shipEntity) {
  if (
    !itemType ||
    Number(itemType.groupID) !== LARGE_COLLIDABLE_OBJECT_GROUP_ID
  ) {
    return null;
  }
  return buildCelestialEntity(itemType, shipEntity, {
    kind: "largeCollidableObject",
    largeCollidableObject: true,
  });
}

function buildRandomUnitVector() {
  const theta = Math.random() * Math.PI * 2;
  const u = (Math.random() * 2) - 1;
  const planarScale = Math.sqrt(Math.max(0, 1 - (u * u)));
  return normalizeSpaceVector({
    x: Math.cos(theta) * planarScale,
    y: u,
    z: Math.sin(theta) * planarScale,
  }, { x: 1, y: 0, z: 0 });
}

function buildOffsetSpaceSpawnState(shipEntity, distanceMeters = 20_000) {
  const origin = {
    x: Number(shipEntity && shipEntity.position && shipEntity.position.x || 0),
    y: Number(shipEntity && shipEntity.position && shipEntity.position.y || 0),
    z: Number(shipEntity && shipEntity.position && shipEntity.position.z || 0),
  };
  const offsetDirection = buildRandomUnitVector();
  const position = addVectors(
    origin,
    scaleVector(offsetDirection, Math.max(1_000, Number(distanceMeters) || 20_000)),
  );
  return {
    position,
    velocity: { x: 0, y: 0, z: 0 },
    direction: normalizeSpaceVector(
      buildRandomUnitVector(),
      shipEntity && shipEntity.direction,
    ),
    targetPoint: position,
    mode: "STOP",
    speedFraction: 0,
  };
}

function allocateTransientVisualEntityID() {
  const allocated = nextTransientVisualEntityID;
  nextTransientVisualEntityID += 1;
  return allocated;
}

function allocateCombatDummyEntityID() {
  const allocated = nextCombatDummyEntityID;
  nextCombatDummyEntityID += 1;
  return allocated;
}

function buildPalatineKeepstarVisualEntity(session, anchorEntity) {
  const keepstarType = resolveItemByTypeID(PALATINE_KEEPSTAR_TYPE_ID);
  if (!keepstarType) {
    return null;
  }

  const spawnDistance = Math.max(
    KEEPSTAR_DEFAULT_SPAWN_DISTANCE_METERS,
    (Number(keepstarType.radius) || KEEPSTAR_DEFAULT_RADIUS_METERS) + 200000,
  );
  const spawnState = buildOffsetSpaceSpawnState(anchorEntity, spawnDistance);
  const corporationID = Number(session && session.corporationID || 0) || 0;
  const allianceID = Number(session && session.allianceID || 0) || 0;
  const warFactionID = Number(session && session.warFactionID || 0) || 0;
  const ownerID =
    corporationID ||
    Number(session && (session.characterID || session.charid) || 0) ||
    1;

  return {
    kind: "station",
    itemID: allocateTransientVisualEntityID(),
    typeID: keepstarType.typeID,
    groupID: keepstarType.groupID || 1657,
    categoryID: keepstarType.categoryID || 65,
    itemName: keepstarType.name || "Upwell Palatine Keepstar",
    ownerID,
    corporationID,
    allianceID,
    warFactionID,
    radius: Number(keepstarType.radius) || KEEPSTAR_DEFAULT_RADIUS_METERS,
    position: spawnState.position,
    velocity: { x: 0, y: 0, z: 0 },
    direction: spawnState.direction,
    targetPoint: spawnState.targetPoint,
    mode: "STOP",
    speedFraction: 0,
    dockPosition: null,
    dockOrientation: spawnState.direction,
    dunRotation: [0, 0, 0],
    activityLevel: null,
    skinMaterialSetID: null,
    celestialEffect: null,
  };
}

function getShipRadiusMeters(shipType) {
  const radius = Number(shipType && shipType.radius);
  if (Number.isFinite(radius) && radius > 0) {
    return radius;
  }
  return 50;
}

function sortShipsLargestToSmallest(left, right) {
  const massDelta = (Number(right && right.mass) || 0) - (Number(left && left.mass) || 0);
  if (massDelta !== 0) {
    return massDelta;
  }
  const radiusDelta = getShipRadiusMeters(right) - getShipRadiusMeters(left);
  if (radiusDelta !== 0) {
    return radiusDelta;
  }
  const volumeDelta = (Number(right && right.volume) || 0) - (Number(left && left.volume) || 0);
  if (volumeDelta !== 0) {
    return volumeDelta;
  }
  return String(left && left.name || "").localeCompare(String(right && right.name || ""));
}

function buildFormationBasis(direction) {
  const forward = normalizeSpaceVector(direction, { x: 1, y: 0, z: 0 });
  const upReference = Math.abs(Number(forward.y) || 0) >= 0.95
    ? { x: 1, y: 0, z: 0 }
    : { x: 0, y: 1, z: 0 };
  const right = normalizeSpaceVector(
    crossVectors(forward, upReference),
    { x: 0, y: 0, z: 1 },
  );
  const up = normalizeSpaceVector(
    crossVectors(right, forward),
    upReference,
  );
  return { forward, right, up };
}

function resolveFire2FleetShipTypes() {
  const seenTypeIDs = new Set();
  const resolved = [];
  for (const shipName of DEFAULT_FIRE2_FLEET_SHIP_NAMES) {
    const lookup = resolveShipByName(shipName);
    if (!lookup.success || !lookup.match) {
      continue;
    }
    const typeID = Number(lookup.match.typeID) || 0;
    if (typeID <= 0 || seenTypeIDs.has(typeID)) {
      continue;
    }
    seenTypeIDs.add(typeID);
    resolved.push(lookup.match);
  }

  const ships = resolved.sort(sortShipsLargestToSmallest);
  if (ships.length < 10) {
    return {
      success: false,
      errorMsg: "FIRE2_FLEET_TYPES_UNAVAILABLE",
      availableCount: ships.length,
    };
  }

  return {
    success: true,
    ships,
  };
}

function buildFire2FleetShipList(shipTypes, fleetSize) {
  const normalizedSize = Math.max(1, normalizePositiveInteger(fleetSize) || DEFAULT_FIRE2_FLEET_SIZE);
  const fleet = [];
  for (let index = 0; index < normalizedSize; index += 1) {
    const bucketIndex = Math.min(
      shipTypes.length - 1,
      Math.floor((index * shipTypes.length) / normalizedSize),
    );
    fleet.push(shipTypes[bucketIndex]);
  }
  return fleet;
}

function buildFire2FormationRowCounts(fleetSize) {
  const rowCounts = [];
  let remaining = Math.max(1, normalizePositiveInteger(fleetSize) || DEFAULT_FIRE2_FLEET_SIZE);
  let nextRowSize = 1;
  while (remaining > 0) {
    const rowSize = Math.min(nextRowSize, remaining);
    rowCounts.push(rowSize);
    remaining -= rowSize;
    nextRowSize += 1;
  }
  return rowCounts;
}

function buildFire2RowSlots(rowShipCount) {
  const slots = [];
  if (rowShipCount % 2 === 1) {
    slots.push({ lane: 0 });
  }

  let laneMagnitude = rowShipCount % 2 === 0 ? 0.5 : 1;
  while (slots.length < rowShipCount) {
    slots.push({ lane: -laneMagnitude });
    if (slots.length < rowShipCount) {
      slots.push({ lane: laneMagnitude });
    }
    laneMagnitude += 1;
  }

  return slots;
}

function buildFire2FleetFormation(anchorEntity, shipTypes, fleetSize) {
  const fleetShips = buildFire2FleetShipList(shipTypes, fleetSize);
  const rowCounts = buildFire2FormationRowCounts(fleetShips.length);
  const anchorPosition = {
    x: Number(anchorEntity && anchorEntity.position && anchorEntity.position.x || 0),
    y: Number(anchorEntity && anchorEntity.position && anchorEntity.position.y || 0),
    z: Number(anchorEntity && anchorEntity.position && anchorEntity.position.z || 0),
  };
  const basis = buildFormationBasis(anchorEntity && anchorEntity.direction);
  const formationOrigin = addVectors(
    anchorPosition,
    scaleVector(basis.forward, FIRE2_BASE_DISTANCE_METERS),
  );
  const facingDirection = normalizeSpaceVector(
    subtractVectors(anchorPosition, formationOrigin),
    scaleVector(basis.forward, -1),
  );

  const layout = [];
  let shipIndex = 0;
  let rowDistanceMeters = 0;
  let previousRowMaxRadius = 0;
  let formationRowIndex = 0;

  for (const rowCount of rowCounts) {
    const rowShips = fleetShips.slice(shipIndex, shipIndex + rowCount);
    if (rowShips.length === 0) {
      break;
    }

    const rowMaxRadius = rowShips.reduce(
      (largest, shipType) => Math.max(largest, getShipRadiusMeters(shipType)),
      0,
    );
    if (layout.length > 0) {
      rowDistanceMeters += Math.max(
        FIRE2_ROW_SPACING_METERS,
        previousRowMaxRadius + rowMaxRadius + FIRE2_OVERLAP_PADDING_METERS,
      );
    }

    const lateralSpacingMeters = Math.max(
      FIRE2_LATERAL_SPACING_METERS,
      (rowMaxRadius * 2) + FIRE2_OVERLAP_PADDING_METERS,
    );
    const verticalSpacingMeters = Math.max(
      2_500,
      rowMaxRadius + (FIRE2_OVERLAP_PADDING_METERS * 0.75),
    );
    const wingSweepBackMeters = Math.max(
      1_250,
      Math.min(
        3_500,
        (rowMaxRadius * 0.45) + (FIRE2_OVERLAP_PADDING_METERS * 0.25),
      ),
    );
    const rowSlots = buildFire2RowSlots(rowShips.length);

    for (let slotIndex = 0; slotIndex < rowShips.length; slotIndex += 1) {
      const rowSlot = rowSlots[slotIndex] || { lane: 0 };
      const lane = Number(rowSlot.lane) || 0;
      const laneDepth = Math.abs(lane);
      const lateralOffsetMeters = lane * lateralSpacingMeters;
      const wingPullbackMeters = laneDepth * wingSweepBackMeters;
      const centerAdvanceMeters = lane === 0
        ? Math.min(300, Math.max(150, rowMaxRadius * 0.04))
        : 0;
      const verticalDirection = lane === 0
        ? (formationRowIndex % 2 === 0 ? 1 : -1)
        : (lane < 0 ? 1 : -1) * (formationRowIndex % 2 === 0 ? 1 : -1);
      const verticalOffsetMeters = lane === 0
        ? verticalDirection * verticalSpacingMeters * 0.35
        : verticalDirection
          * Math.min(2.5, Math.max(1, laneDepth))
          * verticalSpacingMeters
          * 0.55;
      const position = addVectors(
        addVectors(
          formationOrigin,
          scaleVector(
            basis.forward,
            rowDistanceMeters - wingPullbackMeters + centerAdvanceMeters,
          ),
        ),
        addVectors(
          scaleVector(basis.right, lateralOffsetMeters),
          scaleVector(basis.up, verticalOffsetMeters),
        ),
      );
      layout.push({
        shipType: rowShips[slotIndex],
        spawnState: {
          position,
          velocity: { x: 0, y: 0, z: 0 },
          direction: facingDirection,
          targetPoint: position,
          mode: "STOP",
          speedFraction: 0,
        },
      });
    }

    previousRowMaxRadius = rowMaxRadius;
    shipIndex += rowShips.length;
    formationRowIndex += 1;
  }

  return layout;
}

function isContainerType(itemType) {
  const groupName = String(itemType && itemType.groupName || "").trim().toLowerCase();
  return groupName.includes("container") || groupName === "spawn container";
}

function isWreckType(itemType) {
  const groupName = String(itemType && itemType.groupName || "").trim().toLowerCase();
  return groupName === "wreck";
}

function resolveSpaceItemType(argumentText, defaultName, predicate, label) {
  const lookupText = String(argumentText || "").trim() || defaultName;
  const lookup = resolveItemByName(lookupText);
  if (!lookup.success) {
    return lookup;
  }
  if (!predicate(lookup.match)) {
    return {
      success: false,
      errorMsg: `${label}_TYPE_REQUIRED`,
      suggestions: [lookup.match.name],
    };
  }
  return lookup;
}

function handleCelestialSpawnCommand(
  session,
  argumentText,
  chatHub,
  options,
  commandOptions = {},
) {
  const commandName = String(commandOptions.commandName || "celestial");
  const entityLabel = String(commandOptions.entityLabel || "Celestial");
  const requiredGroupID = Number(commandOptions.requiredGroupID) || null;
  const typeIDText = String(argumentText || "").trim();
  if (!/^\d+$/.test(typeIDText)) {
    return handledResult(
      chatHub,
      session,
      options,
      `Usage: /${commandName} <typeID>`,
    );
  }

  const typeID = Number(typeIDText);
  if (!Number.isSafeInteger(typeID) || typeID <= 0) {
    return handledResult(
      chatHub,
      session,
      options,
      `${entityLabel} typeID must be a positive whole number.`,
    );
  }
  if (!isSpaceSessionReady(session)) {
    return handledResult(
      chatHub,
      session,
      options,
      `You must be in space before using /${commandName}.`,
    );
  }

  const itemType = resolveItemByTypeID(typeID);
  if (!itemType) {
    return handledResult(
      chatHub,
      session,
      options,
      `${entityLabel} type not found: ${typeID}.`,
    );
  }
  if (requiredGroupID && Number(itemType.groupID) !== requiredGroupID) {
    return handledResult(
      chatHub,
      session,
      options,
      `Type ${typeID} (${itemType.name}) is not a ${entityLabel} (group ${requiredGroupID}).`,
    );
  }
  if (Number(itemType.categoryID) !== CELESTIAL_CATEGORY_ID) {
    return handledResult(
      chatHub,
      session,
      options,
      `Type ${typeID} (${itemType.name}) is not a Celestial (category ${CELESTIAL_CATEGORY_ID}).`,
    );
  }

  const scene = spaceRuntime.getSceneForSession(session);
  const shipEntity = spaceRuntime.getEntity(session, session._space.shipID);
  if (!scene || !shipEntity) {
    return handledResult(chatHub, session, options, "Active ship was not found in space.");
  }

  const entity = requiredGroupID
    ? buildLargeCollidableObjectEntity(itemType, shipEntity)
    : buildCelestialEntity(itemType, shipEntity);
  if (!entity || !scene.addStaticEntity(entity)) {
    return handledResult(
      chatHub,
      session,
      options,
      `${entityLabel} spawn failed.`,
    );
  }
  if (typeof scene.broadcastAddBalls === "function") {
    scene.broadcastAddBalls([entity], null, { freshAcquire: true });
  }

  return handledResult(
    chatHub,
    session,
    options,
    `Spawned ${itemType.name} (type ${itemType.typeID}, entity ${entity.itemID}) 1 km in front of your ship, measured edge to edge. It is runtime-only and clears on restart.`,
  );
}

function handleCelestialCommand(session, argumentText, chatHub, options) {
  return handleCelestialSpawnCommand(
    session,
    argumentText,
    chatHub,
    options,
  );
}

function handleLargeCollidableObjectCommand(
  session,
  argumentText,
  chatHub,
  options,
) {
  return handleCelestialSpawnCommand(
    session,
    argumentText,
    chatHub,
    options,
    {
      commandName: "lco",
      entityLabel: "Large Collidable Object",
      requiredGroupID: LARGE_COLLIDABLE_OBJECT_GROUP_ID,
    },
  );
}

function handleSpawnContainerCommand(session, argumentText, chatHub, options) {
  if (!isSpaceSessionReady(session)) {
    return handledResult(
      chatHub,
      session,
      options,
      "You must be in space before using /spawncontainer.",
    );
  }

  const containerLookup = resolveSpaceItemType(
    argumentText,
    DEFAULT_SPACE_CONTAINER_NAME,
    isContainerType,
    "CONTAINER",
  );
  if (!containerLookup.success) {
    const message =
      containerLookup.errorMsg === "ITEM_NOT_FOUND"
        ? `Container type not found: ${String(argumentText || "").trim() || DEFAULT_SPACE_CONTAINER_NAME}.${formatSuggestions(containerLookup.suggestions)}`
        : containerLookup.errorMsg === "ITEM_NAME_AMBIGUOUS"
          ? `Container type is ambiguous: ${argumentText}.${formatSuggestions(containerLookup.suggestions)}`
          : `Type must resolve to a container item.${formatSuggestions(containerLookup.suggestions)}`;
    return handledResult(chatHub, session, options, message.trim());
  }

  const scene = spaceRuntime.getSceneForSession(session);
  const shipEntity = spaceRuntime.getEntity(session, session._space.shipID);
  if (!scene || !shipEntity) {
    return handledResult(chatHub, session, options, "Active ship was not found in space.");
  }
  const createResult = createSpaceItemForCharacter(
    session.characterID,
    session._space.systemID,
    containerLookup.match,
    {
      ...buildChildEntityScopeMetadata(shipEntity),
      ...buildNearbySpaceSpawnState(shipEntity),
    },
  );
  if (!createResult.success || !createResult.data) {
    return handledResult(chatHub, session, options, "Container spawn failed.");
  }

  syncInventoryChangesToSession(session, createResult.changes || []);
  const spawnResult = spaceRuntime.spawnDynamicInventoryEntity(
    session._space.systemID,
    createResult.data.itemID,
    {
      sceneDescriptor: scene.sceneDescriptor,
    },
  );
  if (!spawnResult.success) {
    return handledResult(
      chatHub,
      session,
      options,
      "Container item was created, but the space ball failed to spawn.",
    );
  }

  return handledResult(
    chatHub,
    session,
    options,
    `Spawned ${containerLookup.match.name} (${createResult.data.itemID}) in space.`,
  );
}

function handleSpawnWreckCommand(session, argumentText, chatHub, options) {
  if (!isSpaceSessionReady(session)) {
    return handledResult(
      chatHub,
      session,
      options,
      "You must be in space before using /spawnwreck.",
    );
  }

  const wreckLookup = resolveSpaceItemType(
    argumentText,
    DEFAULT_SPACE_WRECK_NAME,
    isWreckType,
    "WRECK",
  );
  if (!wreckLookup.success) {
    const message =
      wreckLookup.errorMsg === "ITEM_NOT_FOUND"
        ? `Wreck type not found: ${String(argumentText || "").trim() || DEFAULT_SPACE_WRECK_NAME}.${formatSuggestions(wreckLookup.suggestions)}`
        : wreckLookup.errorMsg === "ITEM_NAME_AMBIGUOUS"
          ? `Wreck type is ambiguous: ${argumentText}.${formatSuggestions(wreckLookup.suggestions)}`
          : `Type must resolve to a wreck item.${formatSuggestions(wreckLookup.suggestions)}`;
    return handledResult(chatHub, session, options, message.trim());
  }

  const scene = spaceRuntime.getSceneForSession(session);
  const shipEntity = spaceRuntime.getEntity(session, session._space.shipID);
  if (!scene || !shipEntity) {
    return handledResult(chatHub, session, options, "Active ship was not found in space.");
  }
  const createResult = createSpaceItemForCharacter(
    session.characterID,
    session._space.systemID,
    wreckLookup.match,
    {
      ...buildChildEntityScopeMetadata(shipEntity),
      ...buildNearbySpaceSpawnState(shipEntity, 300),
      spaceRadius: resolveRuntimeWreckRadius(wreckLookup.match),
    },
  );
  if (!createResult.success || !createResult.data) {
    return handledResult(chatHub, session, options, "Wreck spawn failed.");
  }

  syncInventoryChangesToSession(session, createResult.changes || []);
  const spawnResult = spaceRuntime.spawnDynamicInventoryEntity(
    session._space.systemID,
    createResult.data.itemID,
    {
      sceneDescriptor: scene.sceneDescriptor,
    },
  );
  if (!spawnResult.success) {
    return handledResult(
      chatHub,
      session,
      options,
      "Wreck item was created, but the space ball failed to spawn.",
    );
  }

  return handledResult(
    chatHub,
    session,
    options,
    `Spawned ${wreckLookup.match.name} (${createResult.data.itemID}) in space.`,
  );
}

function handleJetcanCommand(session, argumentText, chatHub, options) {
  if (!isSpaceSessionReady(session)) {
    return handledResult(
      chatHub,
      session,
      options,
      "You must be in space before using /jetcan.",
    );
  }

  const trimmedArgument = String(argumentText || "").trim();
  if (!trimmedArgument) {
    return handledResult(
      chatHub,
      session,
      options,
      "Usage: /jetcan <item name|typeID> [amount]",
    );
  }

  let itemLookup = resolveItemByName(trimmedArgument);
  let normalizedAmount = 1;
  if (!itemLookup.success) {
    const splitLookup = splitTrailingAmount(trimmedArgument);
    if (splitLookup.lookupText && splitLookup.amount !== null) {
      const splitMatch = resolveItemByName(splitLookup.lookupText);
      if (splitMatch.success) {
        itemLookup = splitMatch;
        normalizedAmount = normalizePositiveInteger(Math.trunc(splitLookup.amount));
      }
    }
  }

  if (!normalizedAmount) {
    return handledResult(
      chatHub,
      session,
      options,
      "Jetcan amount must be a positive whole number.",
    );
  }

  if (!itemLookup.success) {
    const message =
      itemLookup.errorMsg === "ITEM_NOT_FOUND"
        ? `Item not found: ${trimmedArgument}.${formatSuggestions(itemLookup.suggestions)}`
        : `Item name is ambiguous: ${trimmedArgument}.${formatSuggestions(itemLookup.suggestions)}`;
    return handledResult(chatHub, session, options, message.trim());
  }

  const shipID = Number(session._space.shipID || 0) || 0;
  const cargoItems = listContainerItems(
    session.characterID,
    shipID,
    ITEM_FLAGS.CARGO_HOLD,
  ).filter((item) => Number(item.typeID) === Number(itemLookup.match.typeID));
  const availableQuantity = cargoItems.reduce((sum, item) => (
    sum + (Number(item.singleton) === 1 ? 1 : Math.max(0, Number(item.stacksize || item.quantity || 0)))
  ), 0);
  if (availableQuantity < normalizedAmount) {
    return handledResult(
      chatHub,
      session,
      options,
      `Not enough ${itemLookup.match.name} in cargo. Available: ${availableQuantity.toLocaleString("en-US")}.`,
    );
  }

  const containerLookup = resolveSpaceItemType(
    DEFAULT_SPACE_CONTAINER_NAME,
    DEFAULT_SPACE_CONTAINER_NAME,
    isContainerType,
    "CONTAINER",
  );
  if (!containerLookup.success) {
    return handledResult(
      chatHub,
      session,
      options,
      "Default jetcan container type could not be resolved.",
    );
  }

  const scene = spaceRuntime.getSceneForSession(session);
  const shipEntity = spaceRuntime.getEntity(session, shipID);
  if (!scene || !shipEntity) {
    return handledResult(chatHub, session, options, "Active ship was not found in space.");
  }
  // CCP parity: jetcans last exactly 2 hours from creation, regardless of
  // whether items are added or removed.  Empty cans persist until the timer
  // expires -- there is no early despawn on empty.
  const createResult = createSpaceItemForCharacter(
    session.characterID,
    session._space.systemID,
    containerLookup.match,
    {
      ...buildChildEntityScopeMetadata(shipEntity),
      ...buildNearbySpaceSpawnState(shipEntity, 275),
      createdAtMs: spaceRuntime.getSimulationTimeMsForSession(session),
      expiresAtMs: spaceRuntime.getSimulationTimeMsForSession(session) + JETCAN_LIFETIME_MS,
    },
  );
  if (!createResult.success || !createResult.data) {
    return handledResult(chatHub, session, options, "Jetcan creation failed.");
  }

  const moveResult = moveItemTypeFromCharacterLocation(
    session.characterID,
    shipID,
    ITEM_FLAGS.CARGO_HOLD,
    createResult.data.itemID,
    ITEM_FLAGS.HANGAR,
    itemLookup.match.typeID,
    normalizedAmount,
  );
  if (!moveResult.success) {
    return handledResult(chatHub, session, options, "Jetcan item move failed.");
  }

  syncInventoryChangesToSession(session, createResult.changes || []);
  syncInventoryChangesToSession(session, (moveResult.data && moveResult.data.changes) || []);
  const spawnResult = spaceRuntime.spawnDynamicInventoryEntity(
    session._space.systemID,
    createResult.data.itemID,
    {
      sceneDescriptor: scene.sceneDescriptor,
    },
  );
  if (!spawnResult.success) {
    return handledResult(
      chatHub,
      session,
      options,
      "Jetcan contents moved, but the space ball failed to spawn.",
    );
  }

  return handledResult(
    chatHub,
    session,
    options,
    `Jettisoned ${normalizedAmount.toLocaleString("en-US")}x ${itemLookup.match.name} into ${containerLookup.match.name} (${createResult.data.itemID}). Expires in 2 hours.`,
  );
}

function handleDebrisFieldCommand(session, argumentText, chatHub, options, kind) {
  // /wreck list  or  /container list  →  show all valid types with name + typeID
  if (String(argumentText || "").trim().toLowerCase() === "list") {
    const label = kind === "wreck" ? "Wreck" : "Container";
    const types = listAvailableDebrisTypes(kind);
    if (types.length === 0) {
      return handledResult(chatHub, session, options, `No ${label.toLowerCase()} types found.`);
    }
    const lines = types.map((t) => `  ${t.name}  (typeID ${t.typeID})`);
    return handledResult(
      chatHub,
      session,
      options,
      `Available ${label.toLowerCase()} types (${types.length}):\n${lines.join("\n")}\n\nUsage: /${kind} <name|typeID> [count]`,
    );
  }

  if (!isSpaceSessionReady(session)) {
    return handledResult(
      chatHub,
      session,
      options,
      `You must be in space before using /${kind}.`,
    );
  }

  const parsed = parseOptionalTypeAndCount(argumentText);
  if (
    argumentText &&
    String(argumentText).trim() &&
    /\s+\d+\s*$/.test(String(argumentText)) &&
    !parsed.count
  ) {
    return handledResult(
      chatHub,
      session,
      options,
      "Count must be a positive whole number.",
    );
  }

  if (parsed.typeName) {
    const typeLookup = resolveDebrisType(kind, parsed.typeName);
    if (!typeLookup.success) {
      const label = kind === "wreck" ? "Wreck" : "Container";
      const message =
        typeLookup.errorMsg === "ITEM_NOT_FOUND"
          ? `${label} type not found: ${parsed.typeName}.${formatSuggestions(typeLookup.suggestions)}`
          : `${label} type is ambiguous: ${parsed.typeName}.${formatSuggestions(typeLookup.suggestions)}`;
      return handledResult(chatHub, session, options, message.trim());
    }
  }

  const spawnResult = spawnDebrisFieldForSession(session, kind, {
    typeName: parsed.typeName,
    count: parsed.count,
  });
  if (!spawnResult.success) {
    const message =
      spawnResult.errorMsg === "SPACE_REQUIRED"
        ? `You must be in space before using /${kind}.`
        : "Debris spawn failed.";
    return handledResult(chatHub, session, options, message);
  }

  syncSpaceRootInventoryChangesToSession(
    session,
    spawnResult.data && spawnResult.data.changes,
  );

  const requestedCount = Number(spawnResult.data && spawnResult.data.requestedCount) || 0;
  const actualCount = Number(spawnResult.data && spawnResult.data.actualCount) || 0;
  const lifetimeHours = Math.round((getSpaceDebrisLifetimeMs() / 3600000) * 10) / 10;
  const sample = ((spawnResult.data && spawnResult.data.created) || [])
    .slice(0, 3)
    .map((entry) => `${entry.typeName}(${entry.item.itemID})`)
    .join(", ");

  return handledResult(
    chatHub,
    session,
    options,
    [
      `Spawned ${actualCount}/${requestedCount} ${kind}${actualCount === 1 ? "" : "s"} within 20 km.`,
      sample ? `Sample: ${sample}.` : null,
      // Each one not spawned, by why.
      Object.keys((spawnResult.data && spawnResult.data.notSpawned) || {}).length > 0
        ? `Not spawned: ${Object.entries(spawnResult.data.notSpawned).map(([reason, missed]) => `${missed} ${reason}`).join(", ")}.`
        : null,
      `Lifetime: ${lifetimeHours}h.`,
    ].filter(Boolean).join(" "),
  );
}

function handleTestClearCommand(session, chatHub, options) {
  if (!isSpaceSessionReady(session)) {
    return handledResult(
      chatHub,
      session,
      options,
      "You must be in space before using /testclear.",
    );
  }

  const clearResult = clearNearbyDebrisForSession(session);
  if (!clearResult.success) {
    return handledResult(
      chatHub,
      session,
      options,
      "Clearing nearby debris failed.",
    );
  }

  syncSpaceRootInventoryChangesToSession(
    session,
    clearResult.data && clearResult.data.changes,
  );

  return handledResult(
    chatHub,
    session,
    options,
    `Cleared ${Number((clearResult.data && clearResult.data.removed || []).length) || 0} wrecks/containers within 20 km.`,
  );
}

function handleSystemJunkClearCommand(session, chatHub, options) {
  if (!isSpaceSessionReady(session)) {
    return handledResult(
      chatHub,
      session,
      options,
      "You must be in space before using /sysjunkclear.",
    );
  }

  const clearResult = clearSystemDebrisForSession(session);
  if (!clearResult.success) {
    return handledResult(
      chatHub,
      session,
      options,
      "Clearing system debris failed.",
    );
  }

  syncSpaceRootInventoryChangesToSession(
    session,
    clearResult.data && clearResult.data.changes,
  );

  return handledResult(
    chatHub,
    session,
    options,
    `Cleared ${Number((clearResult.data && clearResult.data.removed || []).length) || 0} wrecks/containers across the current solar system.`,
  );
}

function handleFireCommand(session, argumentText, chatHub, options) {
  if (!isSpaceSessionReady(session)) {
    return handledResult(
      chatHub,
      session,
      options,
      "You must be in space before using /fire.",
    );
  }

  const lookupText = String(argumentText || "").trim() || DEFAULT_FIRE_TARGET_NAME;
  const shipLookup = /^\d+$/.test(lookupText)
    ? {
      success: Boolean(resolveShipByTypeID(Number(lookupText) || 0)),
      match: resolveShipByTypeID(Number(lookupText) || 0),
      suggestions: [],
      errorMsg: "SHIP_NOT_FOUND",
    }
    : resolveShipByName(lookupText);
  if (!shipLookup.success || !shipLookup.match) {
    const message =
      shipLookup.errorMsg === "SHIP_NOT_FOUND"
        ? `Ship type not found: ${lookupText}.${formatSuggestions(shipLookup.suggestions)}`
        : `Ship type is ambiguous: ${lookupText}.${formatSuggestions(shipLookup.suggestions)}`;
    return handledResult(chatHub, session, options, message.trim());
  }

  const scene = spaceRuntime.getSceneForSession(session);
  const anchorEntity = spaceRuntime.getEntity(session, session._space.shipID);
  if (!scene || !anchorEntity) {
    return handledResult(chatHub, session, options, "Active ship was not found in space.");
  }

  const spawnResult = spaceRuntime.spawnDynamicShip(
    session._space.systemID,
    {
      itemID: allocateCombatDummyEntityID(),
      typeID: shipLookup.match.typeID,
      groupID: shipLookup.match.groupID,
      categoryID: shipLookup.match.categoryID || 6,
      itemName: `${shipLookup.match.name} Dummy`,
      ownerID: COMBAT_DUMMY_OWNER_ID,
      characterID: 0,
      corporationID: COMBAT_DUMMY_CORPORATION_ID,
      allianceID: 0,
      warFactionID: 0,
      npcEntityType: ENTITY_TYPE.NPC,
      ...buildChildEntityScopeMetadata(anchorEntity),
      ...buildOffsetSpaceSpawnState(anchorEntity, 20_000),
      conditionState: {
        damage: 0,
        charge: 1,
        armorDamage: 0,
        shieldCharge: 1,
        incapacitated: false,
      },
    },
    {
      sceneDescriptor: scene.sceneDescriptor,
    },
  );
  if (!spawnResult.success || !spawnResult.data || !spawnResult.data.entity) {
    return handledResult(chatHub, session, options, "Combat dummy spawn failed.");
  }

  return handledResult(
    chatHub,
    session,
    options,
    `Spawned ${shipLookup.match.name} dummy hull ${spawnResult.data.entity.itemID} roughly 20 km away.`,
  );
}

function handleKeepstarCommand(session, chatHub, options) {
  if (!isSpaceSessionReady(session)) {
    return handledResult(
      chatHub,
      session,
      options,
      "You must be in space before using /keepstar.",
    );
  }

  const scene = spaceRuntime.getSceneForSession(session);
  const anchorEntity = spaceRuntime.getEntity(session, session._space.shipID);
  if (!scene || !anchorEntity) {
    return handledResult(chatHub, session, options, "Active ship was not found in space.");
  }

  const keepstarEntity = buildPalatineKeepstarVisualEntity(session, anchorEntity);
  if (!keepstarEntity) {
    return handledResult(
      chatHub,
      session,
      options,
      "Palatine Keepstar type data was not found in the local item registry.",
    );
  }

  const spawnResult = scene.spawnDynamicEntity(keepstarEntity);
  if (!spawnResult.success || !spawnResult.data || !spawnResult.data.entity) {
    return handledResult(chatHub, session, options, "Keepstar visual spawn failed.");
  }

  return handledResult(
    chatHub,
    session,
    options,
    `Spawned runtime-only Palatine Keepstar ${spawnResult.data.entity.itemID} roughly ${(KEEPSTAR_DEFAULT_SPAWN_DISTANCE_METERS / 1000).toFixed(0)} km away. It is visual-only and clears on restart.`,
  );
}

function handleFire2Command(session, argumentText, chatHub, options) {
  if (!isSpaceSessionReady(session)) {
    return handledResult(
      chatHub,
      session,
      options,
      "You must be in space before using /fire2.",
    );
  }

  const scene = spaceRuntime.getSceneForSession(session);
  const anchorEntity = spaceRuntime.getEntity(session, session._space.shipID);
  if (!scene || !anchorEntity) {
    return handledResult(chatHub, session, options, "Active ship was not found in space.");
  }

  const trimmedArgument = String(argumentText || "").trim();
  const requestedFleetSize = trimmedArgument
    ? normalizePositiveInteger(trimmedArgument)
    : DEFAULT_FIRE2_FLEET_SIZE;
  if (trimmedArgument && !requestedFleetSize) {
    return handledResult(chatHub, session, options, "Usage: /fire2 [count]");
  }

  const fleetLookup = resolveFire2FleetShipTypes();
  if (!fleetLookup.success) {
    return handledResult(
      chatHub,
      session,
      options,
      `The default /fire2 fleet could not be assembled from local ship data (${fleetLookup.availableCount || 0}/10 available).`,
    );
  }

  const formation = buildFire2FleetFormation(
    anchorEntity,
    fleetLookup.ships,
    requestedFleetSize,
  );
  const spawned = [];
  for (const entry of formation) {
    const shipType = entry.shipType;
    const spawnResult = spaceRuntime.spawnDynamicShip(
      session._space.systemID,
      {
        itemID: allocateCombatDummyEntityID(),
        typeID: shipType.typeID,
        groupID: shipType.groupID,
        categoryID: shipType.categoryID || 6,
        itemName: `${shipType.name} Fleet Dummy`,
        ownerID: COMBAT_DUMMY_OWNER_ID,
        characterID: 0,
        corporationID: COMBAT_DUMMY_CORPORATION_ID,
        allianceID: 0,
        warFactionID: 0,
        npcEntityType: ENTITY_TYPE.NPC,
        ...buildChildEntityScopeMetadata(anchorEntity),
        ...entry.spawnState,
        conditionState: {
          damage: 0,
          charge: 1,
          armorDamage: 0,
          shieldCharge: 1,
          incapacitated: false,
        },
      },
      {
        sceneDescriptor: scene.sceneDescriptor,
      },
    );
    if (spawnResult.success && spawnResult.data && spawnResult.data.entity) {
      spawned.push({
        shipType,
        entity: spawnResult.data.entity,
      });
    }
  }

  if (spawned.length === 0) {
    return handledResult(chatHub, session, options, "Fleet dummy spawn failed.");
  }

  const leadShip = spawned[0] && spawned[0].shipType;
  const trailingShip = spawned[spawned.length - 1] && spawned[spawned.length - 1].shipType;
  return handledResult(
    chatHub,
    session,
    options,
    [
      `Spawned ${spawned.length}/${formation.length} fleet dummies in a staggered arrowhead roughly ${Math.round(FIRE2_BASE_DISTANCE_METERS / 1000)} km ahead.`,
      leadShip && trailingShip
        ? `Formation runs ${leadShip.name} -> ${trailingShip.name} from largest to smallest.`
        : null,
    ].filter(Boolean).join(" "),
  );
}

module.exports = {
  buildCelestialEntity,
  buildLargeCollidableObjectEntity,
  handleCelestialCommand,
  handleLargeCollidableObjectCommand,
  handleJetcanCommand,
  handleDebrisFieldCommand,
  handleTestClearCommand,
  handleSystemJunkClearCommand,
  handleFireCommand,
  handleKeepstarCommand,
  handleFire2Command,
};
