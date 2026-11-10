"use strict";
const { getPersistedCorporationAuthority, corporationAuthorityHasRole } = require("../corporation/corporationAuthority");

const path = require("path");

const BaseService = require(path.join(__dirname, "../baseService"));
const log = require(path.join(__dirname, "../../utils/logger"));
const database = require(path.join(__dirname, "../../gameStore"));
const {
  throwWrappedUserError,
} = require(path.join(__dirname, "../../common/machoErrors"));
const {
  buildDict,
  buildFiletimeLong,
  buildKeyVal,
  buildList,
  normalizeNumber,
  normalizeText,
  unwrapMarshalValue,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const structureState = require(path.join(__dirname, "./structureState"));
const {
  STRUCTURE_SERVICE_ID,
  STRUCTURE_SERVICE_STATE,
} = require(path.join(__dirname, "./structureConstants"));
const {
  characterHasStructureService,
} = require(path.join(__dirname, "./structurePayloads"));
const {
  isControllingStructureSession,
} = require(path.join(__dirname, "./structureControlState"));
const {
  listOnlineStructureServiceModules,
} = require(path.join(__dirname, "./structureServiceModules"));
const sessionRegistry = require(path.join(__dirname, "../chat/sessionRegistry"));
const {
  getCharacterIDsInCorporation,
} = require(path.join(__dirname, "../corporation/corporationState"));
const {
  NOTIFICATION_GROUP,
  NOTIFICATION_TYPE,
} = require(path.join(__dirname, "../notifications/notificationConstants"));
const {
  createNotification,
} = require(path.join(__dirname, "../notifications/notificationState"));
const {
  loadConfiguredMoonResourceShadowRead,
} = require(path.join(__dirname, "./moonResourceShadowRead"));
const { isPochvenSystem } = require(path.join(__dirname, "../../space/pochvenPolicy"));
const moonExtractionRules = require(path.join(__dirname, "./moonExtractionRules"));

const TABLE = "moonExtractions";
const ROOT_PATH = "/";

const TYPE_CHARACTER = 1373;
const TYPE_STANDUP_MOON_DRILL = 45009;
const CORP_ROLE_STATION_MANAGER = 2048;
const MINIMUM_EXTRACTION_DURATION_SECONDS = 518460;
const MAXIMUM_EXTRACTION_DURATION_SECONDS = 4838400;
const DEFAULT_AUTO_FRACTURE_DELAY_SECONDS = 10800;
const DEFAULT_YIELD_MULTIPLIER = 1;
const FRACTURE_TOTAL_DURATION_SECONDS = 30;
// The client's fracture timeline: the drill fires for 25 seconds before the
// chunk explodes, and the asteroids appear 5 seconds later.
const FRACTURE_EXPLOSION_DELAY_SECONDS = 25;
const COMPLETED_REASON_FRACTURED = "fractured";
const COMPLETED_REASON_CANCELLED = "cancelled";
const COMPLETED_REASON_DECAYED = "decayed";
const COMPLETED_REASON_OFFLINED = "offlined";
const FILETIME_EPOCH_OFFSET = 116444736000000000n;
const FILETIME_TICKS_PER_MS = 10000n;
const ACTIVE_EXTRACTION_STATES = new Set(["active", "fracturing"]);
let nowMsOverride = null;

function emitMoonResourceShadowDiagnostic(entry) {
  const currentTypes = (entry.currentComposition || []).map((row) => row.typeID).join(",");
  const authorityTypes = (entry.authorityComposition || []).map((row) => row.typeID).join(",");
  log.info(
    `[MoonResourceShadow] status=${entry.status} structure=${entry.structureID || 0} ` +
      `moon=${entry.moonID || 0} currentMoon=${entry.currentProfileMoonID || 0} ` +
      `currentTypes=${currentTypes || "none"} authorityTypes=${authorityTypes || "none"}`,
  );
}

const configuredMoonResourceShadowRead = loadConfiguredMoonResourceShadowRead({
  emitDiagnostic: emitMoonResourceShadowDiagnostic,
});

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizePositiveInteger(value, fallback = 0) {
  const numeric = Math.trunc(normalizeNumber(value, fallback));
  return numeric > 0 ? numeric : fallback;
}

function normalizeNonNegativeInteger(value, fallback = 0) {
  const numeric = Math.trunc(normalizeNumber(value, fallback));
  return numeric >= 0 ? numeric : fallback;
}

function normalizeFiniteNumber(value, fallback = 0) {
  const numeric = normalizeNumber(value, fallback);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function currentFileTimeMs() {
  if (typeof nowMsOverride === "function") {
    const overridden = Number(nowMsOverride());
    if (Number.isFinite(overridden) && overridden >= 0) {
      return Math.trunc(overridden);
    }
  }
  return Date.now();
}

function setNowMsOverride(override = null) {
  nowMsOverride = typeof override === "function" ? override : null;
}

function fileTimeLongFromMs(valueMs) {
  const numericMs = normalizeNonNegativeInteger(valueMs, currentFileTimeMs());
  return buildFiletimeLong(
    BigInt(numericMs) * FILETIME_TICKS_PER_MS + FILETIME_EPOCH_OFFSET,
  );
}

function notificationFileTimeLongFromMs(valueMs) {
  const numericMs = normalizeNonNegativeInteger(valueMs, currentFileTimeMs());
  return {
    type: "long",
    value: String(
      BigInt(numericMs) * FILETIME_TICKS_PER_MS + FILETIME_EPOCH_OFFSET,
    ),
  };
}

function clampDurationSeconds(value) {
  const duration = normalizeFiniteNumber(value, 0);
  if (duration <= 0) {
    return 0;
  }
  return Math.max(
    MINIMUM_EXTRACTION_DURATION_SECONDS,
    Math.min(MAXIMUM_EXTRACTION_DURATION_SECONDS, Math.trunc(duration)),
  );
}

function getSessionCorpID(session) {
  return getPersistedCorporationAuthority(session)?.corporationID || 0;
}

function getSessionStructureID(session) {
  return normalizePositiveInteger(
    session && (session.structureid || session.structureID || session.shipid),
    0,
  );
}

function getSessionCharacterID(session) {
  return normalizePositiveInteger(
    session && (session.characterID || session.charid || session.charID),
    0,
  );
}

function hasStationManagerRole(session) {
  return corporationAuthorityHasRole(getPersistedCorporationAuthority(session), BigInt(CORP_ROLE_STATION_MANAGER));
}

function canReadStructureExtraction(session, structureID) {
  const structure = structureState.getStructureByID(structureID, { refresh: false });
  if (!structure) return false;
  const ownerID = normalizePositiveInteger(structure.ownerCorpID || structure.ownerID, 0);
  return (ownerID > 0 && getSessionCorpID(session) === ownerID && hasStationManagerRole(session)) ||
    (isControllingStructureSession(session, structureID) &&
      characterHasStructureService(session, structure, STRUCTURE_SERVICE_ID.MOON_MINING));
}

function requireStructureExtractionReadAccess(session, structureID) {
  if (!canReadStructureExtraction(session, structureID)) {
    throwMoonExtractionUserError("STRUCTURE_CONTROL_DENIED");
  }
}

function hasOnlineMoonDrillModule(structureID) {
  return listOnlineStructureServiceModules(structureID)
    .some((moduleItem) =>
      normalizePositiveInteger(moduleItem && moduleItem.typeID, 0) ===
        TYPE_STANDUP_MOON_DRILL,
    );
}

function isMoonMiningServiceOnline(structure) {
  return normalizePositiveInteger(
    structure &&
      structure.serviceStates &&
      structure.serviceStates[String(STRUCTURE_SERVICE_ID.MOON_MINING)],
    STRUCTURE_SERVICE_STATE.OFFLINE,
  ) === STRUCTURE_SERVICE_STATE.ONLINE;
}

function isExtractionPullDisrupted(extraction, currentTimeMs) {
  const structureID = normalizePositiveInteger(
    extraction && extraction.structureID,
    0,
  );
  if (!structureID) {
    return false;
  }
  const structure = structureState.getStructureByID(structureID, { refresh: false });
  if (!structure) {
    return false;
  }
  if (normalizePositiveInteger(structure.destroyedAt, 0) > 0) {
    return true;
  }
  if (
    extraction.state !== "active" ||
    normalizeNonNegativeInteger(extraction.chunkAvailableTimeMs, 0) <= currentTimeMs
  ) {
    return false;
  }
  return !isMoonMiningServiceOnline(structure) || !hasOnlineMoonDrillModule(structureID);
}

function throwMoonExtractionUserError(reason = "") {
  switch (String(reason || "")) {
    case "STRUCTURE_CONTROL_DENIED":
      throwWrappedUserError("StructureDefenseDenied");
      break;
    case "NO_ONLINE_MOON_DRILL":
      throwWrappedUserError("CustomNotify", {
        notify: "An online Standup Moon Drill is required.",
      });
      break;
    case "NOT_CONTROLLING_STRUCTURE":
      throwWrappedUserError("CustomNotify", {
        notify: "You must be controlling this structure.",
      });
      break;
    case "EXTRACTION_NOT_READY":
      throwWrappedUserError("CustomNotify", {
        notify: "The moon chunk is not ready to fracture.",
      });
      break;
    case "STATION_MANAGER_REQUIRED":
      throwWrappedUserError("CustomNotify", {
        notify: "Station Manager role is required.",
      });
      break;
    case "POCHVEN_MOON_MINING_DENIED":
      throwWrappedUserError("CustomNotify", {
        notify: "Moon mining is not available in Pochven.",
      });
      break;
    default:
      throwWrappedUserError("CustomNotify", {
        notify: "Moon extraction action is not available.",
      });
      break;
  }
}

function validateMoonExtractionMutationAccess(session, structureID, options = {}) {
  const targetStructureID = normalizePositiveInteger(structureID, 0);
  const structure = structureState.getStructureByID(targetStructureID, { refresh: false });
  if (!targetStructureID || !structure) {
    return { success: false, errorMsg: "STRUCTURE_CONTROL_DENIED" };
  }
  if (isPochvenSystem(structure.solarSystemID)) {
    return { success: false, errorMsg: "POCHVEN_MOON_MINING_DENIED" };
  }
  if (!isControllingStructureSession(session, targetStructureID)) {
    return { success: false, errorMsg: "NOT_CONTROLLING_STRUCTURE" };
  }
  if (!characterHasStructureService(
    session,
    structure,
    STRUCTURE_SERVICE_ID.MOON_MINING,
  )) {
    return { success: false, errorMsg: "STRUCTURE_CONTROL_DENIED" };
  }
  if (!hasOnlineMoonDrillModule(targetStructureID)) {
    return { success: false, errorMsg: "NO_ONLINE_MOON_DRILL" };
  }
  if (options.requireStationManager === true && (
    !hasStationManagerRole(session) ||
    getSessionCorpID(session) !== normalizePositiveInteger(structure.ownerCorpID || structure.ownerID, 0)
  )) {
    return { success: false, errorMsg: "STATION_MANAGER_REQUIRED" };
  }
  return { success: true, structure };
}

function buildInitialState() {
  return {
    nextExtractionID: 1,
    nextEventID: 1,
    extractions: {},
    resourcesByStructureID: {},
  };
}

function normalizeResourceVolumes(rawVolumes = {}) {
  const source = unwrapMarshalValue(rawVolumes);
  if (!isPlainObject(source)) {
    return {};
  }

  const volumes = {};
  for (const [rawTypeID, rawVolume] of Object.entries(source)) {
    const typeID = normalizePositiveInteger(rawTypeID, 0);
    const volume = normalizeFiniteNumber(rawVolume, 0);
    if (typeID > 0 && volume > 0) {
      volumes[String(typeID)] = volume;
    }
  }
  return volumes;
}

function normalizeResourceEntry(rawEntry = {}) {
  const source = unwrapMarshalValue(rawEntry);
  if (!isPlainObject(source)) {
    return null;
  }

  const rawResources = isPlainObject(source.resources)
    ? source.resources
    : source;
  const resources = {};
  for (const [rawTypeID, rawAbundance] of Object.entries(rawResources)) {
    const typeID = normalizePositiveInteger(rawTypeID, 0);
    const abundance = normalizeFiniteNumber(rawAbundance, 0);
    if (typeID > 0 && abundance > 0) {
      resources[String(typeID)] = abundance;
    }
  }

  return {
    structureID: normalizePositiveInteger(source.structureID, 0),
    moonID: normalizePositiveInteger(source.moonID, 0),
    solarSystemID: normalizePositiveInteger(source.solarSystemID, 0),
    ownerID: normalizePositiveInteger(source.ownerID || source.ownerCorpID, 0),
    yieldMultiplier: Math.max(
      0,
      normalizeFiniteNumber(source.yieldMultiplier, DEFAULT_YIELD_MULTIPLIER),
    ) || DEFAULT_YIELD_MULTIPLIER,
    autoFractureDelaySeconds: Math.max(
      0,
      normalizeFiniteNumber(
        source.autoFractureDelaySeconds,
        DEFAULT_AUTO_FRACTURE_DELAY_SECONDS,
      ),
    ),
    resources,
    oreVolumeByType: normalizeResourceVolumes(
      source.oreVolumeByType ||
        source.oreVolumeByTypeID ||
        source.oreVolumes ||
        source.moonOreVolumeByType,
    ),
    autoMoonMiningCycleOutput: normalizeResourceAmounts(
      source.autoMoonMiningCycleOutput || source.autoMoonMinerCycleOutput || source.cycleOutput,
    ),
    nextHarvestTimeMs: normalizeNonNegativeInteger(
      source.nextHarvestTimeMs || source.nextHarvestTime,
      0,
    ),
    lastHarvestTimeMs: normalizeNonNegativeInteger(
      source.lastHarvestTimeMs || source.lastHarvestTime,
      0,
    ),
    miningCycleTimeSeconds: normalizeNonNegativeInteger(
      source.miningCycleTimeSeconds || source.miningCycleTime,
      0,
    ),
    // The composition pack the ores were seeded from; a different installed
    // pack reseeds the structure (moonMiningBindingRuntime).
    datasetVersion: normalizeText(source.datasetVersion, "") || null,
  };
}

function normalizeResourceAmounts(rawAmounts = {}) {
  const source = unwrapMarshalValue(rawAmounts);
  if (!isPlainObject(source)) {
    return {};
  }

  const amounts = {};
  for (const [rawTypeID, rawAmount] of Object.entries(source)) {
    const typeID = normalizePositiveInteger(rawTypeID, 0);
    const amount = normalizeNonNegativeInteger(rawAmount, 0);
    if (typeID > 0 && amount > 0) {
      amounts[String(typeID)] = amount;
    }
  }
  return amounts;
}

function normalizeExtraction(rawEntry = {}) {
  const source = unwrapMarshalValue(rawEntry);
  if (!isPlainObject(source)) {
    return null;
  }

  const extractionID = normalizePositiveInteger(source.extractionID, 0);
  const structureID = normalizePositiveInteger(source.structureID, 0);
  const chunkAvailableTimeMs = normalizePositiveInteger(
    source.chunkAvailableTimeMs,
    0,
  );
  const startMoveTimeMs = normalizePositiveInteger(source.startMoveTimeMs, 0);
  if (!extractionID || !structureID || !chunkAvailableTimeMs || !startMoveTimeMs) {
    return null;
  }

  const naturalDecayTimeMs = normalizePositiveInteger(
    source.naturalDecayTimeMs,
    chunkAvailableTimeMs + DEFAULT_AUTO_FRACTURE_DELAY_SECONDS * 1000,
  );
  return {
    extractionID,
    structureID,
    moonID: normalizePositiveInteger(source.moonID, 0),
    solarSystemID: normalizePositiveInteger(source.solarSystemID, 0),
    ownerID: normalizePositiveInteger(source.ownerID || source.ownerCorpID, 0),
    startMoveTimeMs,
    chunkAvailableTimeMs,
    naturalDecayTimeMs,
    durationSeconds: clampDurationSeconds(source.durationSeconds),
    yieldMultiplier: Math.max(
      0,
      normalizeFiniteNumber(source.yieldMultiplier, DEFAULT_YIELD_MULTIPLIER),
    ) || DEFAULT_YIELD_MULTIPLIER,
    calendarEventID: normalizeNonNegativeInteger(source.calendarEventID, 0),
    state: normalizeText(source.state, "active") || "active",
    fractureStartedAtMs: normalizeNonNegativeInteger(source.fractureStartedAtMs, 0),
    fractureCompleteAtMs: normalizeNonNegativeInteger(source.fractureCompleteAtMs, 0),
    readyNotificationSentAtMs: normalizeNonNegativeInteger(
      source.readyNotificationSentAtMs || source.readyNotifiedAtMs,
      0,
    ),
    oreVolumeByType: normalizeResourceVolumes(
      source.oreVolumeByType ||
        source.oreVolumeByTypeID ||
        source.oreVolumes ||
        source.moonOreVolumeByType,
    ),
    createdAt: normalizeNonNegativeInteger(source.createdAt, currentFileTimeMs()),
    completedAt: normalizeNonNegativeInteger(source.completedAt, 0),
    completedReason: normalizeText(source.completedReason, ""),
  };
}

function ensureStateShape(state) {
  const nextState = state && typeof state === "object"
    ? cloneValue(state)
    : buildInitialState();

  nextState.nextExtractionID = Math.max(
    1,
    normalizePositiveInteger(nextState.nextExtractionID, 1),
  );
  nextState.nextEventID = Math.max(
    1,
    normalizePositiveInteger(nextState.nextEventID, 1),
  );
  if (!isPlainObject(nextState.extractions)) {
    nextState.extractions = {};
  }
  if (!isPlainObject(nextState.resourcesByStructureID)) {
    nextState.resourcesByStructureID = {};
  }

  let highestExtractionID = 0;
  let highestEventID = 0;
  const repairedExtractions = {};
  for (const rawEntry of Object.values(nextState.extractions)) {
    const extraction = normalizeExtraction(rawEntry);
    if (!extraction) {
      continue;
    }
    repairedExtractions[String(extraction.extractionID)] = extraction;
    highestExtractionID = Math.max(highestExtractionID, extraction.extractionID);
    highestEventID = Math.max(highestEventID, extraction.calendarEventID || 0);
  }
  nextState.extractions = repairedExtractions;

  const repairedResources = {};
  for (const [rawStructureID, rawEntry] of Object.entries(nextState.resourcesByStructureID)) {
    const profile = normalizeResourceEntry({
      structureID: rawStructureID,
      ...rawEntry,
    });
    if (!profile || !profile.structureID) {
      continue;
    }
    repairedResources[String(profile.structureID)] = profile;
  }
  nextState.resourcesByStructureID = repairedResources;
  nextState.nextExtractionID = Math.max(
    nextState.nextExtractionID,
    highestExtractionID + 1,
  );
  nextState.nextEventID = Math.max(nextState.nextEventID, highestEventID + 1);
  return nextState;
}

function getResourceProfileForStructure(state, structureID) {
  const profile = state.resourcesByStructureID[String(structureID)];
  return profile ? normalizeResourceEntry(profile) : null;
}

function getActiveExtractionForStructure(state, structureID) {
  const targetStructureID = normalizePositiveInteger(structureID, 0);
  return Object.values(state.extractions)
    .map((entry) => normalizeExtraction(entry))
    .find((entry) =>
      entry &&
      entry.structureID === targetStructureID &&
      ACTIVE_EXTRACTION_STATES.has(entry.state),
    ) || null;
}

function buildExtractionPayload(extraction) {
  if (!extraction) {
    return null;
  }

  return buildKeyVal([
    ["extractionID", extraction.extractionID],
    ["structureID", extraction.structureID],
    ["moonID", extraction.moonID],
    ["solarSystemID", extraction.solarSystemID],
    ["ownerID", extraction.ownerID],
    ["startMoveTime", fileTimeLongFromMs(extraction.startMoveTimeMs)],
    ["chunkAvailableTime", fileTimeLongFromMs(extraction.chunkAvailableTimeMs)],
    ["naturalDecayTime", fileTimeLongFromMs(extraction.naturalDecayTimeMs)],
    ["durationSeconds", extraction.durationSeconds],
    ["yieldMultiplier", extraction.yieldMultiplier],
  ]);
}

function buildResourceCompositionPayload(profile) {
  if (!profile || !isPlainObject(profile.resources)) {
    return buildDict([]);
  }

  return buildDict(
    Object.entries(profile.resources)
      .map(([typeID, abundance]) => [
        normalizePositiveInteger(typeID, 0),
        normalizeFiniteNumber(abundance, 0),
      ])
      .filter(([typeID, abundance]) => typeID > 0 && abundance > 0)
      .sort((left, right) => left[0] - right[0]),
  );
}

function resolveStructureContext(structureID, profile, session) {
  const structure = structureState.getStructureByID(structureID, { refresh: false });
  return {
    moonID: normalizePositiveInteger(
      profile && profile.moonID,
      normalizePositiveInteger(structure && structure.moonID, 0),
    ),
    solarSystemID: normalizePositiveInteger(
      profile && profile.solarSystemID,
      normalizePositiveInteger(
        structure && structure.solarSystemID,
        normalizePositiveInteger(session && (session.solarsystemid2 || session.solarsystemid), 0),
      ),
    ),
    ownerID: normalizePositiveInteger(
      profile && profile.ownerID,
      normalizePositiveInteger(
        structure && (structure.ownerCorpID || structure.ownerID),
        getSessionCorpID(session),
      ),
    ),
    yieldMultiplier: Math.max(
      0,
      normalizeFiniteNumber(
        profile && profile.yieldMultiplier,
        DEFAULT_YIELD_MULTIPLIER,
      ),
    ) || DEFAULT_YIELD_MULTIPLIER,
    autoFractureDelaySeconds: Math.max(
      0,
      normalizeFiniteNumber(
        profile && profile.autoFractureDelaySeconds,
        DEFAULT_AUTO_FRACTURE_DELAY_SECONDS,
      ),
    ),
  };
}

/**
 * What a new extraction pulls: the multiplier the client shows on the
 * extraction, the delay before the chunk fractures itself, and the m3 of each
 * ore. The seeded profile carries the structure's base values (a hand-written
 * seed may set its own); fitted moon rigs scale them the way their SDE
 * effects scale the structure's attributes.
 */
function resolveExtractionYield(structureID, profile, durationSeconds, structureContext) {
  const structure = structureState.getStructureByID(structureID, { refresh: false });
  let rigYieldScale = 1;
  let rigFractureDelayScale = 1;
  if (structure) {
    const withRigs = moonExtractionRules.resolveStructureMoonAttributes(structure);
    const withoutRigs = moonExtractionRules.resolveStructureMoonAttributes(structure, { rigTypeIDs: [] });
    rigYieldScale = withoutRigs.yieldMultiplier > 0
      ? withRigs.yieldMultiplier / withoutRigs.yieldMultiplier
      : 1;
    rigFractureDelayScale = withoutRigs.autoFractureDelaySeconds > 0
      ? withRigs.autoFractureDelaySeconds / withoutRigs.autoFractureDelaySeconds
      : 1;
  }
  const yieldMultiplier = structureContext.yieldMultiplier * rigYieldScale;
  return {
    yieldMultiplier,
    autoFractureDelaySeconds: Math.round(
      structureContext.autoFractureDelaySeconds * rigFractureDelayScale,
    ),
    oreVolumeByType: moonExtractionRules.computeOreVolumeByType(
      profile && profile.resources,
      moonExtractionRules.computeChunkVolumeM3(durationSeconds, yieldMultiplier),
    ),
  };
}

function getMoonMiningSpaceRuntime() {
  return require(path.join(__dirname, "./moonMiningSpaceRuntime"));
}

/**
 * An ended extraction in space: a fractured chunk (by the drill or on its own
 * after the auto-fracture delay) explodes into an ore field; a cancelled or
 * interrupted one just leaves. Space is presentation of the extraction
 * record, so a failure here is logged and never undoes the completion.
 */
function settleExtractionInSpace(extraction, nowMs) {
  const fractured =
    extraction.completedReason === COMPLETED_REASON_FRACTURED ||
    extraction.completedReason === COMPLETED_REASON_DECAYED;
  try {
    const space = getMoonMiningSpaceRuntime();
    space.removeChunkForExtraction(extraction, { explode: fractured, nowMs });
    if (fractured) {
      const field = space.createFieldFromExtraction(extraction, nowMs);
      if (!field.success) {
        log.warn(
          `[MoonExtractions] extraction ${extraction.extractionID} fractured without an ore field: ` +
            `${field.errorMsg}`,
        );
      }
    }
  } catch (error) {
    log.warn(
      `[MoonExtractions] extraction ${extraction.extractionID} could not settle in space: ${error.message}`,
    );
  }
}

// The drilled chunk explodes 25 seconds into the fracture; the field it
// leaves appears when the fracture completes at 30 seconds.
function explodeFiredChunks(state, nowMs) {
  for (const rawEntry of Object.values(state.extractions || {})) {
    const extraction = normalizeExtraction(rawEntry);
    if (
      !extraction ||
      extraction.state !== "fracturing" ||
      extraction.fractureStartedAtMs <= 0 ||
      extraction.fractureStartedAtMs + FRACTURE_EXPLOSION_DELAY_SECONDS * 1000 > nowMs
    ) {
      continue;
    }
    try {
      getMoonMiningSpaceRuntime().removeChunkForExtraction(extraction, { explode: true, nowMs });
    } catch (error) {
      log.warn(`[MoonExtractions] chunk ${extraction.extractionID} did not explode: ${error.message}`);
    }
  }
}

function settleChunkAtArrival(extraction, nowMs) {
  try {
    getMoonMiningSpaceRuntime().settleChunkAtArrival(extraction, { nowMs });
  } catch (error) {
    log.warn(`[MoonExtractions] chunk ${extraction.extractionID} did not settle at the refinery: ${error.message}`);
  }
}

function tickMoonMiningSpace(nowMs) {
  try {
    getMoonMiningSpaceRuntime().tick(nowMs);
  } catch (error) {
    log.warn(`[MoonExtractions] moon field decay tick failed: ${error.message}`);
  }
}

function sendMoonExtractionUpdate(session, extraction) {
  if (!session || typeof session.sendNotification !== "function") {
    return;
  }
  session.sendNotification("OnMoonExtractionUpdate", "clientID", [
    buildExtractionPayload(extraction),
  ]);
}

function shouldSendExtractionUpdateToSession(session, extraction) {
  if (!session || typeof session.sendNotification !== "function" || !extraction) {
    return false;
  }
  const ownerID = normalizePositiveInteger(extraction.ownerID, 0);
  const structureID = normalizePositiveInteger(extraction.structureID, 0);
  return (
    (ownerID > 0 && getSessionCorpID(session) === ownerID && hasStationManagerRole(session)) ||
    (structureID > 0 && canReadStructureExtraction(session, structureID))
  );
}

function sendMoonExtractionClearedToSessions(extraction, options = {}) {
  const sessions = Array.isArray(options.sessions)
    ? options.sessions
    : sessionRegistry.getSessions();
  const notifiedSessions = new Set();
  let sentCount = 0;
  for (const session of sessions) {
    if (
      notifiedSessions.has(session) ||
      !shouldSendExtractionUpdateToSession(session, extraction)
    ) {
      continue;
    }
    notifiedSessions.add(session);
    sendMoonExtractionUpdate(session, null);
    sentCount += 1;
  }
  return sentCount;
}

function readCharacterRecord(characterID) {
  const numericCharacterID = normalizePositiveInteger(characterID, 0);
  if (!numericCharacterID) {
    return null;
  }
  const result = database.read("characters", "/");
  const characters =
    result.success && result.data && typeof result.data === "object"
      ? result.data
      : {};
  const record = characters[String(numericCharacterID)];
  return record && typeof record === "object" ? record : null;
}

function buildShowInfoLink(typeID, name, itemID) {
  const numericTypeID = normalizePositiveInteger(typeID, 0);
  const numericItemID = normalizePositiveInteger(itemID, 0);
  const label = String(name || `Item ${numericItemID || numericTypeID}`);
  return `<a href="showinfo:${numericTypeID}//${numericItemID}">${label}</a>`;
}

function buildCharacterShowInfoLink(characterID) {
  const numericCharacterID = normalizePositiveInteger(characterID, 0);
  if (!numericCharacterID) {
    return "";
  }
  const record = readCharacterRecord(numericCharacterID);
  const characterTypeID = normalizePositiveInteger(
    record && (record.typeID || record.characterTypeID),
    TYPE_CHARACTER,
  );
  const characterName = String(
    (record && (record.characterName || record.name)) ||
      `Character ${numericCharacterID}`,
  );
  return buildShowInfoLink(characterTypeID, characterName, numericCharacterID);
}

function buildMoonMiningNotificationBaseData(extraction) {
  if (!extraction) {
    return null;
  }
  const structureID = normalizePositiveInteger(extraction.structureID, 0);
  if (!structureID) {
    return null;
  }
  const structure = structureState.getStructureByID(structureID, { refresh: false });
  const structureTypeID = normalizePositiveInteger(
    structure && structure.typeID,
    0,
  );
  const solarSystemID = normalizePositiveInteger(
    extraction.solarSystemID,
    normalizePositiveInteger(structure && structure.solarSystemID, 0),
  );
  const moonID = normalizePositiveInteger(
    extraction.moonID,
    normalizePositiveInteger(structure && structure.moonID, 0),
  );
  if (!structureTypeID || !solarSystemID || !moonID) {
    log.warn(
      `[MoonExtractions] Skipping moon-mining notification for ` +
      `structure=${structureID}: missing structureTypeID/solarSystemID/moonID`,
    );
    return null;
  }
  const structureName = String(
    (structure && (structure.itemName || structure.name)) ||
      `Structure ${structureID}`,
  );
  return {
    structureLink: buildShowInfoLink(structureTypeID, structureName, structureID),
    structureID,
    structureName,
    structureTypeID,
    solarSystemID,
    moonID,
  };
}

function buildMoonMiningNotificationData(extraction, notificationTypeID, options = {}) {
  const baseData = buildMoonMiningNotificationBaseData(extraction);
  if (!baseData) {
    return null;
  }
  const oreVolumeByType = normalizeResourceVolumes(extraction.oreVolumeByType);
  switch (notificationTypeID) {
    case NOTIFICATION_TYPE.MOONMINING_EXTRACTION_STARTED: {
      const startedBy = normalizePositiveInteger(options.startedBy, 0);
      return {
        ...baseData,
        startedBy,
        startedByLink: buildCharacterShowInfoLink(startedBy),
        readyTime: notificationFileTimeLongFromMs(extraction.chunkAvailableTimeMs),
        autoTime: notificationFileTimeLongFromMs(extraction.naturalDecayTimeMs),
        oreVolumeByType,
      };
    }
    case NOTIFICATION_TYPE.MOONMINING_EXTRACTION_CANCELLED: {
      const cancelledBy = normalizePositiveInteger(options.cancelledBy, 0);
      return {
        ...baseData,
        cancelledBy: cancelledBy || null,
        cancelledByLink: cancelledBy ? buildCharacterShowInfoLink(cancelledBy) : "",
      };
    }
    case NOTIFICATION_TYPE.MOONMINING_EXTRACTION_FINISHED:
      return {
        ...baseData,
        autoTime: notificationFileTimeLongFromMs(extraction.naturalDecayTimeMs),
        oreVolumeByType,
      };
    case NOTIFICATION_TYPE.MOONMINING_LASER_FIRED: {
      const firedBy = normalizePositiveInteger(options.firedBy, 0);
      return {
        ...baseData,
        firedBy,
        firedByLink: buildCharacterShowInfoLink(firedBy),
        oreVolumeByType,
      };
    }
    case NOTIFICATION_TYPE.MOONMINING_AUTOMATIC_FRACTURE:
      return {
        ...baseData,
        oreVolumeByType,
      };
    default:
      return baseData;
  }
}

function createMoonMiningOwnerNotifications(extraction, notificationTypeID, options = {}) {
  const typeID = normalizePositiveInteger(notificationTypeID, 0);
  const ownerID = normalizePositiveInteger(extraction && extraction.ownerID, 0);
  if (!typeID || !ownerID) {
    return 0;
  }
  const data = buildMoonMiningNotificationData(extraction, typeID, options);
  if (!data) {
    return 0;
  }
  let createdCount = 0;
  for (const characterID of [...new Set(getCharacterIDsInCorporation(ownerID))]) {
    const result = createNotification(characterID, {
      typeID,
      senderID: ownerID,
      groupID: NOTIFICATION_GROUP.STRUCTURES,
      processed: false,
      data,
      emitLive: false,
    });
    if (!result || result.success !== true) {
      log.warn(
        `[MoonExtractions] Failed to create moon-mining notification ` +
        `type=${typeID} structure=${data.structureID} character=${characterID}: ` +
        `${result && result.errorMsg ? result.errorMsg : "UNKNOWN"}`,
      );
      continue;
    }
    createdCount += 1;
  }
  return createdCount;
}

function markReadyMoonExtractionsInState(state, nowMs = currentFileTimeMs()) {
  const currentTimeMs = normalizeNonNegativeInteger(nowMs, currentFileTimeMs());
  const readyExtractions = [];
  for (const [rawKey, rawEntry] of Object.entries(state.extractions || {})) {
    const extraction = normalizeExtraction(rawEntry);
    if (
      !extraction ||
      extraction.state !== "active" ||
      extraction.readyNotificationSentAtMs > 0 ||
      extraction.chunkAvailableTimeMs > currentTimeMs ||
      extraction.naturalDecayTimeMs <= currentTimeMs
    ) {
      continue;
    }
    const readyExtraction = {
      ...extraction,
      readyNotificationSentAtMs: currentTimeMs,
    };
    const key = String(readyExtraction.extractionID);
    if (rawKey !== key) {
      delete state.extractions[rawKey];
    }
    state.extractions[key] = readyExtraction;
    readyExtractions.push(readyExtraction);
  }
  return {
    changed: readyExtractions.length > 0,
    readyExtractions,
  };
}

function completeExpiredExtractionsInState(state, nowMs = currentFileTimeMs()) {
  const currentTimeMs = normalizeNonNegativeInteger(nowMs, currentFileTimeMs());
  const completedExtractions = [];
  for (const [rawKey, rawEntry] of Object.entries(state.extractions || {})) {
    const extraction = normalizeExtraction(rawEntry);
    if (!extraction || !ACTIVE_EXTRACTION_STATES.has(extraction.state)) {
      continue;
    }
    const fractureDue =
      extraction.state === "fracturing" &&
      extraction.fractureCompleteAtMs > 0 &&
      extraction.fractureCompleteAtMs <= currentTimeMs;
    // A ready chunk nobody fires on -- no pilot, a drill out of fuel, a
    // reinforced structure -- explodes by itself at its natural decay time
    // (CCP, "The Goo must flow": "This could happen if no one fires the
    // laser, or the Moon Drill runs out of fuel after the extraction has
    // finished, or if the structure has been reinforced").
    const decayDue =
      extraction.state === "active" &&
      extraction.naturalDecayTimeMs > 0 &&
      extraction.naturalDecayTimeMs <= currentTimeMs;
    const offlinedDue = isExtractionPullDisrupted(extraction, currentTimeMs);
    if (!offlinedDue && !fractureDue && !decayDue) {
      continue;
    }
    const completedExtraction = {
      ...extraction,
      state: "completed",
      completedReason: offlinedDue
        ? COMPLETED_REASON_OFFLINED
        : fractureDue
          ? COMPLETED_REASON_FRACTURED
          : COMPLETED_REASON_DECAYED,
      completedAt: currentTimeMs,
    };
    const key = String(completedExtraction.extractionID);
    if (rawKey !== key) {
      delete state.extractions[rawKey];
    }
    state.extractions[key] = completedExtraction;
    completedExtractions.push(completedExtraction);
  }
  return {
    changed: completedExtractions.length > 0,
    completedExtractions,
  };
}

class MoonExtractionsService extends BaseService {
  constructor(options = {}) {
    super("moonExtractions");
    this._state = options.state ? ensureStateShape(options.state) : null;
    this._useInjectedState = Boolean(options.state);
    this._moonResourceShadowRead = Object.prototype.hasOwnProperty.call(
      options,
      "moonResourceShadowRead",
    )
      ? options.moonResourceShadowRead
      : configuredMoonResourceShadowRead;
  }

  _getState() {
    if (this._useInjectedState) {
      return this._state;
    }

    // StructureState drives the production extraction timer through a short-
    // lived service instance. Reload durable state for RPCs so that instance's
    // automatic completion cannot leave this long-lived client service serving
    // (or later persisting) an obsolete extraction.
    const existing = database.read(TABLE, ROOT_PATH);
    if (existing.success && existing.data && typeof existing.data === "object") {
      this._state = ensureStateShape(existing.data);
      return this._state;
    }

    if (this._state) {
      return this._state;
    }

    this._state = buildInitialState();
    database.write(TABLE, ROOT_PATH, this._state);
    return this._state;
  }

  _persistState() {
    if (!this._useInjectedState) {
      database.write(TABLE, ROOT_PATH, this._state);
    }
    return this._state;
  }

  // Bind and seed a structure anchored before moon binding existed, or reseed
  // one whose ores came from an older composition pack. It writes only the
  // structure's own entry, so it runs before the handler takes its snapshot.
  _ensureMoonMiningReady(structureID) {
    if (this._useInjectedState || !structureID) {
      return;
    }
    try {
      require(path.join(__dirname, "./moonMiningBindingRuntime"))
        .ensureMoonMiningReady(structureID, { source: "moonExtractions" });
    } catch (error) {
      log.warn(`[MoonExtractions] moon binding check failed for structure ${structureID}: ${error.message}`);
    }
  }

  _completeExtractionForStructure(structureID, reason, session) {
    const access = validateMoonExtractionMutationAccess(session, structureID, {
      requireStationManager: reason === "cancelled",
    });
    if (!access.success) {
      throwMoonExtractionUserError(access.errorMsg);
    }

    const state = this._getState();
    const extraction = getActiveExtractionForStructure(state, structureID);
    if (!extraction) {
      return null;
    }
    if (reason === COMPLETED_REASON_FRACTURED && extraction.state === "fracturing") {
      return null;
    }
    if (
      reason === COMPLETED_REASON_FRACTURED &&
      extraction.chunkAvailableTimeMs > currentFileTimeMs()
    ) {
      throwMoonExtractionUserError("EXTRACTION_NOT_READY");
    }
    if (reason === COMPLETED_REASON_FRACTURED) {
      const nowMs = currentFileTimeMs();
      extraction.state = "fracturing";
      extraction.fractureStartedAtMs = nowMs;
      extraction.fractureCompleteAtMs =
        nowMs + FRACTURE_TOTAL_DURATION_SECONDS * 1000;
      state.extractions[String(extraction.extractionID)] = extraction;
      this._persistState();
      createMoonMiningOwnerNotifications(
        extraction,
        NOTIFICATION_TYPE.MOONMINING_LASER_FIRED,
        { firedBy: getSessionCharacterID(session) },
      );
      return null;
    }

    extraction.state = "completed";
    extraction.completedReason = reason;
    extraction.completedAt = currentFileTimeMs();
    state.extractions[String(extraction.extractionID)] = extraction;
    this._persistState();
    if (reason === COMPLETED_REASON_CANCELLED) {
      createMoonMiningOwnerNotifications(
        extraction,
        NOTIFICATION_TYPE.MOONMINING_EXTRACTION_CANCELLED,
        { cancelledBy: getSessionCharacterID(session) },
      );
    }
    if (!this._useInjectedState) {
      settleExtractionInSpace(extraction, extraction.completedAt);
    }
    sendMoonExtractionUpdate(session, null);
    return null;
  }

  Handle_GetExtractionAndEventIDFromStructureID(args = [], session) {
    const structureID = normalizePositiveInteger(
      Array.isArray(args) && args.length > 0 ? args[0] : getSessionStructureID(session),
      getSessionStructureID(session),
    );
    if (!structureState.getStructureByID(structureID, { refresh: false })) return [null, null];
    requireStructureExtractionReadAccess(session, structureID);
    const extraction = structureID
      ? getActiveExtractionForStructure(this._getState(), structureID)
      : null;
    return [
      buildExtractionPayload(extraction),
      extraction ? extraction.calendarEventID || 0 : null,
    ];
  }

  Handle_GetExtractionsForCorp(args = [], session) {
    const corpID = normalizePositiveInteger(
      Array.isArray(args) && args.length > 0 ? args[0] : getSessionCorpID(session),
      getSessionCorpID(session),
    );
    if (!corpID || corpID !== getSessionCorpID(session) || !hasStationManagerRole(session)) {
      throwMoonExtractionUserError("STATION_MANAGER_REQUIRED");
    }
    const rows = Object.values(this._getState().extractions)
      .map((entry) => normalizeExtraction(entry))
      .filter((entry) =>
        entry &&
        ACTIVE_EXTRACTION_STATES.has(entry.state) &&
        entry.ownerID === corpID,
      )
      .sort((left, right) => left.chunkAvailableTimeMs - right.chunkAvailableTimeMs)
      .map((entry) => buildExtractionPayload(entry));
    return buildList(rows);
  }

  Handle_GetMoonResourcesForStructure(args = [], session) {
    const structureID = normalizePositiveInteger(
      Array.isArray(args) && args.length > 0 ? args[0] : getSessionStructureID(session),
      getSessionStructureID(session),
    );
    if (!structureState.getStructureByID(structureID, { refresh: false })) return buildDict([]);
    requireStructureExtractionReadAccess(session, structureID);
    this._ensureMoonMiningReady(structureID);
    const state = structureID ? this._getState() : null;
    const profile = state ? getResourceProfileForStructure(state, structureID) : null;
    if (
      structureID &&
      this._moonResourceShadowRead &&
      typeof this._moonResourceShadowRead.observe === "function"
    ) {
      this._moonResourceShadowRead.observe({
        structureID,
        structure: structureState.getStructureByID(structureID, { refresh: false }),
        currentProfile: profile,
      });
    }
    return buildResourceCompositionPayload(profile);
  }

  Handle_StartNewExtraction(args = [], session) {
    const structureID = normalizePositiveInteger(args[0], 0);
    const durationSeconds = clampDurationSeconds(args[1]);
    const addToCalendar = Boolean(args[2]);
    if (!structureID || !durationSeconds) {
      return null;
    }

    const access = validateMoonExtractionMutationAccess(session, structureID);
    if (!access.success) {
      throwMoonExtractionUserError(access.errorMsg);
    }

    this._ensureMoonMiningReady(structureID);
    const state = this._getState();
    const profile = getResourceProfileForStructure(state, structureID);
    if (!profile || Object.keys(profile.resources || {}).length === 0) {
      log.warn(
        `[MoonExtractions] Refusing to start extraction without seeded moon resources for structure ${structureID}`,
      );
      return null;
    }

    const existing = getActiveExtractionForStructure(state, structureID);
    if (existing) {
      return buildExtractionPayload(existing);
    }

    const structureContext = resolveStructureContext(structureID, profile, session);
    const extractionYield = resolveExtractionYield(
      structureID,
      profile,
      durationSeconds,
      structureContext,
    );
    const extractionID = state.nextExtractionID;
    state.nextExtractionID += 1;
    const nowMs = currentFileTimeMs();
    const chunkAvailableTimeMs = nowMs + durationSeconds * 1000;
    const extraction = {
      extractionID,
      structureID,
      moonID: structureContext.moonID,
      solarSystemID: structureContext.solarSystemID,
      ownerID: structureContext.ownerID,
      startMoveTimeMs: nowMs,
      chunkAvailableTimeMs,
      naturalDecayTimeMs:
        chunkAvailableTimeMs + extractionYield.autoFractureDelaySeconds * 1000,
      durationSeconds,
      yieldMultiplier: extractionYield.yieldMultiplier,
      calendarEventID: addToCalendar ? state.nextEventID : 0,
      state: "active",
      readyNotificationSentAtMs: 0,
      oreVolumeByType: extractionYield.oreVolumeByType,
      createdAt: nowMs,
      completedAt: 0,
      completedReason: "",
    };
    if (addToCalendar) {
      state.nextEventID += 1;
    }
    state.extractions[String(extractionID)] = extraction;
    this._persistState();
    createMoonMiningOwnerNotifications(
      extraction,
      NOTIFICATION_TYPE.MOONMINING_EXTRACTION_STARTED,
      { startedBy: getSessionCharacterID(session) },
    );
    sendMoonExtractionUpdate(session, extraction);
    if (!this._useInjectedState) {
      try {
        getMoonMiningSpaceRuntime().spawnChunkForExtraction(extraction, { nowMs });
      } catch (error) {
        log.warn(`[MoonExtractions] moon chunk for extraction ${extractionID} did not spawn: ${error.message}`);
      }
    }
    return buildExtractionPayload(extraction);
  }

  Handle_FractureChunkWithStructure(args = [], session) {
    return this._completeExtractionForStructure(
      getSessionStructureID(session),
      COMPLETED_REASON_FRACTURED,
      session,
    );
  }

  Handle_CancelExtraction(args = [], session) {
    return this._completeExtractionForStructure(
      getSessionStructureID(session),
      COMPLETED_REASON_CANCELLED,
      session,
    );
  }
}

MoonExtractionsService.readResourceProfileForStructure = function readResourceProfileForStructure(
  structureID,
  options = {},
) {
  const targetStructureID = normalizePositiveInteger(structureID, 0);
  if (!targetStructureID) {
    return null;
  }

  const state = options.state
    ? ensureStateShape(options.state)
    : ensureStateShape((database.read(TABLE, ROOT_PATH).data) || buildInitialState());
  return getResourceProfileForStructure(state, targetStructureID);
};

MoonExtractionsService._testing = {
  TABLE,
  MINIMUM_EXTRACTION_DURATION_SECONDS,
  MAXIMUM_EXTRACTION_DURATION_SECONDS,
  DEFAULT_AUTO_FRACTURE_DELAY_SECONDS,
  FRACTURE_TOTAL_DURATION_SECONDS,
  FRACTURE_EXPLOSION_DELAY_SECONDS,
  COMPLETED_REASON_DECAYED,
  COMPLETED_REASON_FRACTURED,
  COMPLETED_REASON_OFFLINED,
  buildExtractionPayload,
  buildResourceCompositionPayload,
  completeExpiredExtractionsInState,
  ensureStateShape,
  normalizeResourceAmounts,
  normalizeResourceVolumes,
  markReadyMoonExtractionsInState,
  readResourceProfileForStructure: MoonExtractionsService.readResourceProfileForStructure,
  sendMoonExtractionClearedToSessions,
  setNowMsOverride,
  resetNowMsOverride: () => setNowMsOverride(),
};

MoonExtractionsService.tickExtractions = function tickExtractions(
  nowMs = currentFileTimeMs(),
  options = {},
) {
  const service = options.service instanceof MoonExtractionsService
    ? options.service
    : new MoonExtractionsService(options.state ? { state: options.state } : {});
  const state = service._getState();
  const readyResult = markReadyMoonExtractionsInState(state, nowMs);
  const result = completeExpiredExtractionsInState(state, nowMs);
  let notifiedSessions = 0;
  let notifiedCharacters = 0;
  if (readyResult.changed || result.changed) {
    service._persistState();
    for (const extraction of readyResult.readyExtractions) {
      notifiedCharacters += createMoonMiningOwnerNotifications(
        extraction,
        NOTIFICATION_TYPE.MOONMINING_EXTRACTION_FINISHED,
      );
      if (!service._useInjectedState) {
        settleChunkAtArrival(extraction, nowMs);
      }
    }
    for (const extraction of result.completedExtractions) {
      if (extraction.completedReason === COMPLETED_REASON_DECAYED) {
        notifiedCharacters += createMoonMiningOwnerNotifications(
          extraction,
          NOTIFICATION_TYPE.MOONMINING_AUTOMATIC_FRACTURE,
        );
      }
      if (!service._useInjectedState) {
        settleExtractionInSpace(extraction, nowMs);
      }
      notifiedSessions += sendMoonExtractionClearedToSessions(extraction, options);
    }
  }
  if (!service._useInjectedState) {
    explodeFiredChunks(state, nowMs);
    tickMoonMiningSpace(nowMs);
  }
  return {
    success: true,
    changed: readyResult.changed || result.changed,
    readyNotificationCount: readyResult.readyExtractions.length,
    completedCount: result.completedExtractions.length,
    completedExtractions: result.completedExtractions.map((entry) => cloneValue(entry)),
    notifiedCharacters,
    notifiedSessions,
    state: cloneValue(state),
  };
};

module.exports = MoonExtractionsService;
