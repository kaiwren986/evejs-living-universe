"use strict";

/**
 * What moon mining puts in space: the moon chunk during an extraction and the
 * ore field a fractured chunk leaves behind.
 *
 * Both are rebuilt from durable records whenever their system's scene is
 * built, so a restart or an unloaded system loses nothing:
 * - the chunk from the active extraction in `moonExtractions`;
 * - the field from its own row in `moonMiningFields`.
 *
 * Field rocks are ordinary asteroids. The mining runtime keeps each rock's
 * remaining ore in its own per-rock row and applies it when the rock is
 * rebuilt, a mined-out rock stays gone, and `moonMiningStructureID` credits
 * the refinery's mining ledger (miningRuntime.resolveLedgerObserverContext).
 * When the field decays its rocks and their mining rows are removed.
 */

const path = require("path");

const log = require(path.join(__dirname, "../../utils/logger"));
const { getWallclockNowMs } = require(path.join(__dirname, "../../space/runtime/runtimeClock"));
const database = require(path.join(__dirname, "../../gameStore"));
const worldData = require(path.join(__dirname, "../../space/worldData"));
const { resolveItemByTypeID } = require(path.join(__dirname, "../inventory/itemTypeRegistry"));
const { computeAsteroidRadiusFromQuantity } = require(path.join(__dirname, "../mining/miningMath"));
const moonExtractionRules = require(path.join(__dirname, "./moonExtractionRules"));
const { setBallPosition } = require(path.join(__dirname, "../../space/destiny/simulation/evolve"));
const { buildDict, buildFiletimeLong, buildList } = require(path.join(__dirname, "../_shared/serviceHelpers"));
const { toFileTimeFromMs } = require(path.join(__dirname, "../../space/runtime/runtimeClock"));

const FIELD_TABLE = "moonMiningFields";
const CHUNK_ENTITY_ID_BASE = 7_100_000_000_000;
const FIELD_ROCK_ID_BASE = 7_200_000_000_000;
const FIELD_ROCK_SLOTS_PER_EXTRACTION = 1_000;
const DESTRUCTION_EFFECT_EXPLOSION = 3;
const DESTRUCTION_EFFECT_ASTEROID_DEPLETION = 2;
const MOON_ORE_UNIT_VOLUME_FALLBACK = 10;
const OWNER_ID_WORLD = 1;
const ACTIVE_EXTRACTION_STATES = new Set(["active", "fracturing"]);
const TYPE_STANDUP_MOON_DRILL = 45009;
const MOON_EXTRACTION_FX_KEY = "moonExtraction";
const MOON_EXTRACTION_FX_GUID = "effects.MultiEffect";
const MOON_EXTRACTION_FX_SEQUENCE = "moon_mining";
const MOON_EXTRACTION_FX_TRIGGERS = Object.freeze(["moduleID", "moonID", "shipID", "targetID"]);

// Renderable rock models for the field. Ore types have no model of their own
// (graphicID 0), so each rock shows one of the same shells belt ore uses and
// carries its ore in the slim and mining-yield fields.
const ROCK_SHELL_TYPE_IDS = Object.freeze([
  64063, 64064, 64065, 64066, 64067, 64068, 64069, 64070,
  64071, 64072, 64073, 64074, 64075, 64076, 64077,
]);

let nextFieldDecayAtMs = null;

function toPositiveInt(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : 0;
}

function toFiniteNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function subtract(left, right) {
  return { x: left.x - right.x, y: left.y - right.y, z: left.z - right.z };
}

function add(left, right) {
  return { x: left.x + right.x, y: left.y + right.y, z: left.z + right.z };
}

function scale(vector, factor) {
  return { x: vector.x * factor, y: vector.y * factor, z: vector.z * factor };
}

function length(vector) {
  return Math.hypot(vector.x, vector.y, vector.z);
}

function normalize(vector, fallback = { x: 1, y: 0, z: 0 }) {
  const magnitude = length(vector);
  return magnitude > 0 ? scale(vector, 1 / magnitude) : { ...fallback };
}

function readPosition(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const position = {
    x: Number(value.x),
    y: Number(value.y),
    z: Number(value.z),
  };
  return Number.isFinite(position.x) && Number.isFinite(position.y) && Number.isFinite(position.z)
    ? position
    : null;
}

function hashUnit(seedText) {
  let hash = 2166136261;
  for (let index = 0; index < seedText.length; index += 1) {
    hash ^= seedText.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0x1_0000_0000;
}

function getDestiny() {
  return require(path.join(__dirname, "../../space/destiny"));
}

function getSpaceRuntime() {
  return require(path.join(__dirname, "../../space/runtime"));
}

function getLoadedScene(solarSystemID) {
  const runtime = getSpaceRuntime();
  const scenes = runtime && runtime.scenes;
  if (!scenes || typeof scenes.get !== "function") {
    return null;
  }
  // Only a scene that is already loaded: building one here would cold-load a
  // system nobody is in. An unloaded system gets its moon content when its
  // scene is built (handleSceneCreated).
  return scenes.get(toPositiveInt(solarSystemID)) || null;
}

function readStructure(structureID) {
  return require(path.join(__dirname, "./structureState"))
    .getStructureByID(toPositiveInt(structureID), { refresh: false }) || null;
}

// ── The chunk ────────────────────────────────────────────────────────

function chunkEntityIDForExtraction(extractionID) {
  return CHUNK_ENTITY_ID_BASE + toPositiveInt(extractionID);
}

/**
 * The chunk rises off the moon's surface facing the refinery and arrives
 * beside it. Where it arrives is where the field forms.
 */
function resolveChunkPath(structure, moonID) {
  const structurePosition = readPosition(structure && structure.position);
  const moon = worldData.getCelestialByID(toPositiveInt(moonID));
  const moonPosition = readPosition(moon && moon.position);
  if (!structurePosition || !moonPosition) {
    return null;
  }
  const towardMoon = normalize(subtract(moonPosition, structurePosition));
  const structureRadius = Math.max(0, toFiniteNumber(structure && structure.radius, 0));
  const arrival = add(
    structurePosition,
    scale(towardMoon, structureRadius + moonExtractionRules.CHUNK_ARRIVAL_DISTANCE_METERS),
  );
  const moonRadius = Math.max(0, toFiniteNumber(moon && moon.radius, 0));
  const start = add(moonPosition, scale(towardMoon, -moonRadius));
  return { start, arrival, direction: towardMoon };
}

function chunkProgress(extraction, nowMs) {
  const startMs = toFiniteNumber(extraction.startMoveTimeMs, 0);
  const endMs = toFiniteNumber(extraction.chunkAvailableTimeMs, 0);
  if (!(endMs > startMs)) {
    return 1;
  }
  return Math.min(1, Math.max(0, (toFiniteNumber(nowMs, startMs) - startMs) / (endMs - startMs)));
}

function buildChunkEntity(extraction, structure, nowMs) {
  const chunkPath = resolveChunkPath(structure, extraction.moonID);
  if (!chunkPath) {
    return null;
  }
  const chunkVolumeM3 = Object.values(extraction.oreVolumeByType || {})
    .reduce((sum, volume) => sum + Math.max(0, toFiniteNumber(volume, 0)), 0);
  const shellTypeID = moonExtractionRules.selectChunkShellTypeID(chunkVolumeM3);
  const shell = resolveItemByTypeID(shellTypeID) || {};
  const progress = chunkProgress(extraction, nowMs);
  const position = add(
    chunkPath.start,
    scale(subtract(chunkPath.arrival, chunkPath.start), progress),
  );
  return {
    kind: "moonChunk",
    itemID: chunkEntityIDForExtraction(extraction.extractionID),
    typeID: shellTypeID,
    groupID: toPositiveInt(shell.groupID) || 1940,
    categoryID: toPositiveInt(shell.categoryID) || 2,
    graphicID: toPositiveInt(shell.graphicID) || null,
    itemName: String(shell.name || "Moon Chunk"),
    ownerID: toPositiveInt(extraction.ownerID) || OWNER_ID_WORLD,
    radius: Math.max(1, toFiniteNumber(shell.radius, 30_000)),
    position,
    velocity: { x: 0, y: 0, z: 0 },
    direction: scale(chunkPath.direction, -1),
    staticVisibilityScope: "grid",
    moonChunkExtractionID: toPositiveInt(extraction.extractionID),
    moonMiningStructureID: toPositiveInt(extraction.structureID),
    presentationSpecialFx: buildChunkEffectStates(extraction, nowMs),
  };
}

// ── The drill's effect ───────────────────────────────────────────────
//
// The refinery's drill plays the client's moon_mining effect sequence on the
// chunk (static data effectsequences: tractor_phase fires at the moon, shows
// the chunk at 50.5 s and starts the tractor beam at 70 s; stasis_phase holds
// the chunk once it arrives; fracture_phase fires at it). TQ sends it as one
// OnSpecialFX from the refinery and its drill item at the chunk, and a pilot
// who arrives during the pull gets it with effectStarted at the extraction's
// start (golden log LOGS\CONCORD\0.5 Sec Space.lsw, Apanake refinery:
// (structureID, drillID, 45009, chunkID, None, 'effects.MultiEffect', False,
// True, 1, -1, None, None, <start>, {'phase': 'tractor_phase', 'moonID': ...,
// 'effectStarted': <start>, 'sequence': 'moon_mining', 'triggers': [...]})).
// The effect is replayed when the chunk is acquired, since the client needs
// the chunk ball before MultiEffect can target it, and is sent again with
// the new phase when the phase changes (fxSequencer.AddTrigger hands a
// repeat trigger to MultiEffect.UpdateGraphicInfo). Adapted from a community
// patch by Shadowblade (0001-Fix-Moon-Mining-Visuals.patch, 2026-11-05).

function getMoonExtractionPhase(extraction, nowMs) {
  if (extraction && extraction.state === "fracturing") {
    return "fracture_phase";
  }
  return toFiniteNumber(nowMs, 0) >= toFiniteNumber(extraction && extraction.chunkAvailableTimeMs, 0)
    ? "stasis_phase"
    : "tractor_phase";
}

function getMoonExtractionPhaseStartMs(extraction, phase) {
  if (phase === "fracture_phase") {
    return toFiniteNumber(extraction.fractureStartedAtMs, 0);
  }
  if (phase === "stasis_phase") {
    return toFiniteNumber(extraction.chunkAvailableTimeMs, 0);
  }
  return toFiniteNumber(extraction.startMoveTimeMs, 0);
}

function findStructureMoonDrill(structureID) {
  return require(path.join(__dirname, "./structureServiceModules"))
    .listFittedStructureServiceModules(structureID)
    .find((item) => toPositiveInt(item && item.typeID) === TYPE_STANDUP_MOON_DRILL) || null;
}

/**
 * The OnSpecialFX options for the drill's effect now. The extraction times
 * are wallclock; effectStarted is read against the client's sim time
 * (MultiEffect.__init__), so it is the scene's sim time less the time the
 * phase has run.
 */
function buildMoonExtractionFxOptions(effectState, nowMs, scene = null) {
  const extraction = effectState && effectState.extraction;
  if (!extraction) {
    return null;
  }
  const wallclockNowMs = scene && typeof scene.getCurrentWallclockMs === "function"
    ? scene.getCurrentWallclockMs()
    : toFiniteNumber(nowMs, getWallclockNowMs());
  const simNowMs = scene && typeof scene.getCurrentSimTimeMs === "function"
    ? scene.getCurrentSimTimeMs()
    : wallclockNowMs;
  const phase = getMoonExtractionPhase(extraction, wallclockNowMs);
  const elapsedMs = Math.max(0, wallclockNowMs - getMoonExtractionPhaseStartMs(extraction, phase));
  return {
    moduleID: effectState.moduleID,
    moduleTypeID: effectState.typeID,
    targetID: effectState.targetID,
    isOffensive: false,
    start: true,
    active: true,
    duration: -1,
    repeat: null,
    graphicInfo: buildDict([
      ["phase", phase],
      ["moonID", toPositiveInt(extraction.moonID)],
      ["effectStarted", buildFiletimeLong(toFileTimeFromMs(simNowMs - elapsedMs))],
      ["sequence", MOON_EXTRACTION_FX_SEQUENCE],
      ["triggers", buildList([...MOON_EXTRACTION_FX_TRIGGERS])],
    ]),
  };
}

function buildChunkEffectStates(extraction, nowMs) {
  const states = new Map();
  const drill = findStructureMoonDrill(extraction.structureID);
  if (!drill) {
    return states;
  }
  states.set(MOON_EXTRACTION_FX_KEY, {
    guid: MOON_EXTRACTION_FX_GUID,
    sourceEntityID: toPositiveInt(extraction.structureID),
    moduleID: toPositiveInt(drill.itemID),
    typeID: TYPE_STANDUP_MOON_DRILL,
    targetID: chunkEntityIDForExtraction(extraction.extractionID),
    forceFreshAcquireSpecialFxReplay: true,
    extraction: { ...extraction },
    phase: getMoonExtractionPhase(extraction, toFiniteNumber(nowMs, getWallclockNowMs())),
    buildReplayFxOptions(nowMs, scene) {
      return buildMoonExtractionFxOptions(this, nowMs, scene);
    },
  });
  return states;
}

/**
 * Keep the chunk's effect on the extraction's current record, and send the
 * effect again to the chunk's bubble when its phase has changed.
 */
function syncChunkEffect(scene, chunk, extraction) {
  const effectState = chunk && chunk.presentationSpecialFx instanceof Map
    ? chunk.presentationSpecialFx.get(MOON_EXTRACTION_FX_KEY)
    : null;
  if (!effectState) {
    return false;
  }
  effectState.extraction = { ...extraction };
  const nowMs = typeof scene.getCurrentWallclockMs === "function"
    ? scene.getCurrentWallclockMs()
    : getWallclockNowMs();
  const phase = getMoonExtractionPhase(extraction, nowMs);
  if (phase === effectState.phase) {
    return false;
  }
  effectState.phase = phase;
  if (typeof scene.broadcastSpecialFx !== "function") {
    return false;
  }
  const options = buildMoonExtractionFxOptions(effectState, nowMs, scene);
  scene.broadcastSpecialFx(effectState.sourceEntityID, effectState.guid, options, chunk);
  return true;
}

/** The extraction changed phase without moving its chunk (the drill fired). */
function syncChunkEffectForExtraction(extraction) {
  const scene = getLoadedScene(extraction && extraction.solarSystemID);
  const chunk = scene && scene.staticEntitiesByID.get(chunkEntityIDForExtraction(extraction.extractionID));
  if (!chunk) {
    return { success: true, sent: false };
  }
  return { success: true, sent: syncChunkEffect(scene, chunk, extraction) };
}

function addEntitiesToScene(scene, entities, options = {}) {
  const added = [];
  for (const entity of entities) {
    if (scene.addStaticEntity(entity)) {
      added.push(entity);
    }
  }
  if (added.length > 0 && options.broadcast !== false && typeof scene.broadcastAddBalls === "function") {
    scene.broadcastAddBalls(added, null);
  }
  return added;
}

/** Put the chunk of an active extraction into its system, if loaded. */
function spawnChunkForExtraction(extraction, options = {}) {
  const scene = options.scene || getLoadedScene(extraction && extraction.solarSystemID);
  if (!scene || !extraction || !ACTIVE_EXTRACTION_STATES.has(extraction.state)) {
    return { success: true, spawned: false };
  }
  const structure = readStructure(extraction.structureID);
  const entity = buildChunkEntity(extraction, structure, options.nowMs);
  if (!entity) {
    return { success: false, errorMsg: "CHUNK_PATH_UNAVAILABLE" };
  }
  const added = addEntitiesToScene(scene, [entity], options);
  return { success: true, spawned: added.length > 0, entity };
}

/**
 * Move a chunk ball that is already in space to a new point. Clients that
 * have the ball keep it, so a remove and re-add of the same id in one step
 * never reaches them (live client, 2026-11-05: the chunk stayed drawn at the
 * moon's surface, 1,495 km from the Athanor). The ball moves in place the way
 * a teleport moves one: the position authority commits it, it is re-boxed
 * (a Grid bubble change reaches Observers at the next bubble update), and its
 * bubble gets a stamped SetBallPosition.
 */
function moveChunkBall(scene, entity, position) {
  entity.position = { ...position };
  const commit = scene.positionAuthority && typeof scene.positionAuthority.commitEntity === "function"
    ? scene.positionAuthority.commitEntity(entity, {
      atSimTimeMs: scene.getCurrentSimTimeMs(),
      reason: "moon-chunk-move",
    })
    : { available: false };
  if (!commit.available) {
    return false;
  }
  setBallPosition(entity, entity.position);
  scene.reboxBall(entity);
  scene.queueBallHistory(entity, [{
    stamp: scene.historyStamp(),
    payload: getDestiny().buildSetBallPositionPayload(entity.itemID, entity.position),
  }]);
  return true;
}

/**
 * Put an active extraction's chunk where its times say it is: moved in place
 * when the ball is in space, added when it is not. The chunk is a static ball
 * placed along its path when its scene is built, so a scene that stayed
 * loaded for the whole pull still shows it where it set out until this runs.
 */
function placeChunkForExtraction(extraction, options = {}) {
  const scene = getLoadedScene(extraction && extraction.solarSystemID);
  if (!scene || !extraction || !ACTIVE_EXTRACTION_STATES.has(extraction.state)) {
    return { success: true, moved: false };
  }
  const chunkID = chunkEntityIDForExtraction(extraction.extractionID);
  const current = scene.staticEntitiesByID.get(chunkID) || null;
  const structure = readStructure(extraction.structureID);
  const placed = buildChunkEntity(extraction, structure, options.nowMs);
  if (!placed) {
    return { success: false, errorMsg: "CHUNK_PATH_UNAVAILABLE" };
  }
  if (!current) {
    const added = addEntitiesToScene(scene, [placed], options);
    return { success: true, moved: added.length > 0 };
  }
  if (length(subtract(readPosition(current.position), placed.position)) < 1) {
    syncChunkEffect(scene, current, extraction);
    return { success: true, moved: false };
  }
  if (moveChunkBall(scene, current, placed.position)) {
    syncChunkEffect(scene, current, extraction);
    return { success: true, moved: true };
  }
  scene.removeStaticEntity(chunkID, { terminalDestructionEffectID: 0, nowMs: options.nowMs });
  const added = addEntitiesToScene(scene, [placed], options);
  return { success: true, moved: added.length > 0 };
}

/** The chunk has arrived: put it at the refinery, where it waits to be fractured. */
function settleChunkAtArrival(extraction, options = {}) {
  return placeChunkForExtraction(extraction, {
    ...options,
    nowMs: extraction && extraction.chunkAvailableTimeMs,
  });
}

/** Take the chunk out of space; a fracture ends in an explosion. */
function removeChunkForExtraction(extraction, options = {}) {
  const scene = getLoadedScene(extraction && extraction.solarSystemID);
  if (!scene) {
    return { success: true, removed: false };
  }
  // Clients drop every effect naming a Ball when they remove it
  // (fxSequencer.py RemoveActivationsForBallID), so the drill effect needs no
  // stop of its own; only stop replaying it.
  const chunk = scene.staticEntitiesByID.get(chunkEntityIDForExtraction(extraction.extractionID));
  if (chunk && chunk.presentationSpecialFx instanceof Map) {
    chunk.presentationSpecialFx.delete(MOON_EXTRACTION_FX_KEY);
  }
  const result = scene.removeStaticEntity(chunkEntityIDForExtraction(extraction.extractionID), {
    terminalDestructionEffectID: options.explode === true ? DESTRUCTION_EFFECT_EXPLOSION : 0,
    nowMs: options.nowMs,
  });
  return { success: true, removed: Boolean(result && result.success) };
}

// ── The field ────────────────────────────────────────────────────────

function fieldKey(extractionID) {
  return String(toPositiveInt(extractionID));
}

function rockItemID(extractionID, ordinal) {
  return FIELD_ROCK_ID_BASE +
    toPositiveInt(extractionID) * FIELD_ROCK_SLOTS_PER_EXTRACTION +
    toPositiveInt(ordinal);
}

function readAllFields() {
  const result = database.read(FIELD_TABLE, "/");
  return result && result.success && result.data && typeof result.data === "object"
    ? result.data
    : {};
}

function readField(extractionID) {
  const result = database.read(FIELD_TABLE, `/${fieldKey(extractionID)}`);
  return result && result.success && result.data && typeof result.data === "object"
    ? result.data
    : null;
}

function pickRockShellTypeID(rockID, oreTypeID) {
  return ROCK_SHELL_TYPE_IDS[
    Math.floor(hashUnit(`${oreTypeID}:${rockID}:shell`) * ROCK_SHELL_TYPE_IDS.length)
  ];
}

function buildRockEntity(field, rock) {
  const ore = resolveItemByTypeID(rock.typeID) || {};
  const shellTypeID = pickRockShellTypeID(rock.itemID, rock.typeID);
  const shell = resolveItemByTypeID(shellTypeID) || {};
  const unitVolume = Math.max(0.000001, toFiniteNumber(ore.volume, MOON_ORE_UNIT_VOLUME_FALLBACK));
  return {
    kind: "asteroid",
    itemID: rock.itemID,
    typeID: toPositiveInt(shell.typeID) || shellTypeID,
    groupID: toPositiveInt(shell.groupID) || null,
    categoryID: toPositiveInt(shell.categoryID) || 2,
    graphicID: toPositiveInt(shell.graphicID) || null,
    slimGraphicID: toPositiveInt(shell.graphicID) || null,
    visualTypeID: toPositiveInt(shell.typeID) || shellTypeID,
    slimTypeID: rock.typeID,
    slimGroupID: toPositiveInt(ore.groupID) || null,
    slimCategoryID: toPositiveInt(ore.categoryID) || 25,
    miningYieldTypeID: rock.typeID,
    miningYieldKind: "ore",
    resourceQuantity: rock.quantity,
    itemName: String(ore.name || ""),
    slimName: String(ore.name || ""),
    ownerID: OWNER_ID_WORLD,
    radius: computeAsteroidRadiusFromQuantity(rock.typeID, rock.quantity, { unitVolume }),
    position: readPosition(rock.position) || readPosition(field.center),
    velocity: { x: 0, y: 0, z: 0 },
    direction: { x: 1, y: 0, z: 0 },
    staticVisibilityScope: "bubble",
    moonMiningFieldID: toPositiveInt(field.extractionID),
    moonMiningStructureID: toPositiveInt(field.structureID),
    observerItemName: String(field.structureName || ""),
  };
}

function materializeFieldRocks(scene, field, options = {}) {
  const rocks = Array.isArray(field.rocks) ? field.rocks : [];
  const entities = rocks
    .filter((rock) => toPositiveInt(rock && rock.itemID) && !scene.staticEntitiesByID.has(rock.itemID))
    .map((rock) => buildRockEntity(field, rock));
  const added = addEntitiesToScene(scene, entities, options);
  if (added.length > 0) {
    // The mining runtime memoizes its scene cache. Drop it so the next mining
    // read includes these rocks and any remaining ore saved for them.
    scene._miningRuntimeState = null;
  }
  return added.length;
}

function noteFieldDecay(decayAtMs) {
  const at = toFiniteNumber(decayAtMs, 0);
  if (at > 0 && (nextFieldDecayAtMs === null || at < nextFieldDecayAtMs)) {
    nextFieldDecayAtMs = at;
  }
}

/**
 * A fractured chunk becomes an ore field where it arrived. Rocks, sizes and
 * positions are fixed now and stored, so every later rebuild is identical.
 */
function createFieldFromExtraction(extraction, nowMs, options = {}) {
  const structure = readStructure(extraction && extraction.structureID);
  const chunkPath = resolveChunkPath(structure, extraction && extraction.moonID);
  if (!structure || !chunkPath) {
    return { success: false, errorMsg: "FIELD_POSITION_UNAVAILABLE" };
  }
  const attributes = moonExtractionRules.resolveStructureMoonAttributes(structure);
  const plan = moonExtractionRules.planFieldRocks(extraction.oreVolumeByType, {
    seed: `moon-field:${extraction.extractionID}`,
    fieldRadiusMultiplier: attributes.fieldRadiusMultiplier,
    resolveUnitVolume: (typeID) => toFiniteNumber(
      (resolveItemByTypeID(typeID) || {}).volume,
      MOON_ORE_UNIT_VOLUME_FALLBACK,
    ),
  });
  if (plan.rocks.length === 0) {
    return { success: false, errorMsg: "EMPTY_CHUNK" };
  }
  const createdAtMs = toFiniteNumber(nowMs, getWallclockNowMs());
  const field = {
    extractionID: toPositiveInt(extraction.extractionID),
    structureID: toPositiveInt(extraction.structureID),
    structureName: String(structure.itemName || structure.name || ""),
    solarSystemID: toPositiveInt(extraction.solarSystemID),
    moonID: toPositiveInt(extraction.moonID),
    ownerID: toPositiveInt(extraction.ownerID),
    center: chunkPath.arrival,
    createdAtMs,
    decayAtMs: createdAtMs + attributes.fieldDecaySeconds * 1000,
    rocks: plan.rocks.map((rock) => ({
      itemID: rockItemID(extraction.extractionID, rock.ordinal),
      typeID: rock.typeID,
      quantity: rock.quantity,
      position: add(chunkPath.arrival, rock.offset),
    })),
  };
  const write = database.write(FIELD_TABLE, `/${fieldKey(field.extractionID)}`, field);
  if (!write || write.success !== true) {
    return { success: false, errorMsg: (write && write.errorMsg) || "FIELD_WRITE_FAILED" };
  }
  noteFieldDecay(field.decayAtMs);
  const scene = options.scene || getLoadedScene(field.solarSystemID);
  const materialized = scene ? materializeFieldRocks(scene, field, options) : 0;
  log.info(
    `[MoonMiningSpace] field from extraction=${field.extractionID} structure=${field.structureID} ` +
      `rocks=${field.rocks.length} units=${plan.totalUnits} ` +
      `decayInHours=${(attributes.fieldDecaySeconds / 3600).toFixed(1)} materialized=${materialized}`,
  );
  return { success: true, field, materialized };
}

function removePersistedRockState(solarSystemID, rockIDs) {
  const miningRuntimeState = require(path.join(__dirname, "../mining/miningRuntimeState"));
  for (const rockID of rockIDs) {
    miningRuntimeState.removePersistedSystemEntity(solarSystemID, rockID);
  }
}

/** The field has decayed: its rocks leave space and their saved ore goes. */
function removeField(field, options = {}) {
  const rockIDs = (Array.isArray(field.rocks) ? field.rocks : [])
    .map((rock) => toPositiveInt(rock && rock.itemID))
    .filter(Boolean);
  const scene = getLoadedScene(field.solarSystemID);
  let removed = 0;
  if (scene) {
    for (const rockID of rockIDs) {
      const result = scene.removeStaticEntity(rockID, {
        terminalDestructionEffectID: DESTRUCTION_EFFECT_ASTEROID_DEPLETION,
        nowMs: options.nowMs,
      });
      if (result && result.success) {
        removed += 1;
      }
    }
    scene._miningRuntimeState = null;
  }
  removePersistedRockState(field.solarSystemID, rockIDs);
  database.remove(FIELD_TABLE, `/${fieldKey(field.extractionID)}`);
  log.info(
    `[MoonMiningSpace] field from extraction=${field.extractionID} decayed; ` +
      `removed ${removed} rock(s) from space`,
  );
  return removed;
}

/** Decay fields whose time has come. Cheap when none is due. */
function tick(nowMs) {
  const now = toFiniteNumber(nowMs, getWallclockNowMs());
  if (nextFieldDecayAtMs !== null && now < nextFieldDecayAtMs) {
    return { decayed: 0 };
  }
  let decayed = 0;
  let nextDue = null;
  for (const field of Object.values(readAllFields())) {
    const decayAtMs = toFiniteNumber(field && field.decayAtMs, 0);
    if (decayAtMs > 0 && decayAtMs <= now) {
      removeField(field, { nowMs: now });
      decayed += 1;
    } else if (decayAtMs > 0 && (nextDue === null || decayAtMs < nextDue)) {
      nextDue = decayAtMs;
    }
  }
  nextFieldDecayAtMs = nextDue === null ? Number.POSITIVE_INFINITY : nextDue;
  return { decayed };
}

// ── Scene build ──────────────────────────────────────────────────────

function listActiveExtractionsForSystem(solarSystemID) {
  const result = database.read("moonExtractions", "/extractions");
  const extractions = result && result.success && result.data && typeof result.data === "object"
    ? Object.values(result.data)
    : [];
  return extractions.filter((extraction) => (
    extraction &&
    toPositiveInt(extraction.solarSystemID) === solarSystemID &&
    ACTIVE_EXTRACTION_STATES.has(String(extraction.state || ""))
  ));
}

/**
 * Put a system's moon chunks and live ore fields into its new scene. Runs
 * before the mining runtime builds its cache for the scene, so rocks pick up
 * their saved ore on the first mining read.
 */
function handleSceneCreated(scene) {
  const solarSystemID = toPositiveInt(scene && scene.systemID);
  if (!solarSystemID) {
    return { chunks: 0, rocks: 0 };
  }
  const nowMs = typeof scene.getCurrentWallclockMs === "function"
    ? scene.getCurrentWallclockMs()
    : getWallclockNowMs();
  let chunks = 0;
  for (const extraction of listActiveExtractionsForSystem(solarSystemID)) {
    const result = spawnChunkForExtraction(extraction, { scene, nowMs, broadcast: false });
    if (result.spawned) {
      chunks += 1;
    }
  }
  let rocks = 0;
  for (const field of Object.values(readAllFields())) {
    if (!field || toPositiveInt(field.solarSystemID) !== solarSystemID) {
      continue;
    }
    if (toFiniteNumber(field.decayAtMs, 0) <= nowMs) {
      continue;
    }
    noteFieldDecay(field.decayAtMs);
    rocks += materializeFieldRocks(scene, field, { broadcast: false });
  }
  return { chunks, rocks };
}

function resetMoonMiningSpaceRuntimeForTests() {
  nextFieldDecayAtMs = null;
}

module.exports = {
  CHUNK_ENTITY_ID_BASE,
  FIELD_ROCK_ID_BASE,
  FIELD_TABLE,
  chunkEntityIDForExtraction,
  createFieldFromExtraction,
  handleSceneCreated,
  placeChunkForExtraction,
  readField,
  removeChunkForExtraction,
  resetMoonMiningSpaceRuntimeForTests,
  resolveChunkPath,
  rockItemID,
  settleChunkAtArrival,
  spawnChunkForExtraction,
  syncChunkEffectForExtraction,
  tick,
};
