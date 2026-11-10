"use strict";

const { queueDogmaEvent } = require("../../space/runtime/dogmaEvents");

const {
  toFiniteNumber,
} = require("../../common/numbers");

const crypto = require("node:crypto");
const path = require("path");
const config = require(path.join(__dirname, "../../config"));
const log = require(path.join(__dirname, "../../utils/logger"));

const {
  buildDict,
  buildFiletimeLong,
  buildList,
  buildPythonSet,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const sessionRegistry = require(path.join(__dirname, "../chat/sessionRegistry"));
const crimewatchRuntimeState = require(path.join(
  __dirname,
  "crimewatchRuntimeState",
));
// CONCORD responders are spawned and ordered through the NPC runtime, which loads the space
// runtime. Required on use, so loading crimewatch (which the space runtime does) does not load
// the NPC runtime in the middle of the space runtime's own load.
function getNpcRuntime() {
  return require(path.join(__dirname, "../../space/npc/npcRuntime"));
}
const {
  findSafeWarpOriginAnchor,
} = require(path.join(__dirname, "../../space/npc/npcWarpOrigins"));
const {
  ENTITY_TYPE,
} = require(path.join(__dirname, "../../space/entityConstants"));
const {
  buildChildEntityScopeMetadata,
} = require(path.join(
  __dirname,
  "../../space/destiny/identity/interactionScope",
));
const {
  getSolarSystemPseudoSecurity,
  isHighSecuritySystem,
  isLowSecuritySystem,
} = require(path.join(__dirname, "systemSecurity"));

const projectedManualStarbaseSources = new WeakMap();

const SAFETY_LEVEL_NONE = 0;
const SAFETY_LEVEL_PARTIAL = 1;
const SAFETY_LEVEL_FULL = 2;

const WEAPONS_TIMER_STATE_IDLE = 100;
const WEAPONS_TIMER_STATE_ACTIVE = 101;
const WEAPONS_TIMER_STATE_TIMER = 102;
const PVP_TIMER_STATE_IDLE = 200;
const PVP_TIMER_STATE_ACTIVE = 201;
const PVP_TIMER_STATE_TIMER = 202;
const CRIMINAL_TIMER_STATE_IDLE = 300;
const CRIMINAL_TIMER_STATE_ACTIVE_CRIMINAL = 301;
const CRIMINAL_TIMER_STATE_ACTIVE_SUSPECT = 302;
const CRIMINAL_TIMER_STATE_TIMER_CRIMINAL = 303;
const CRIMINAL_TIMER_STATE_TIMER_SUSPECT = 304;
const NPC_TIMER_STATE_IDLE = 400;
const NPC_TIMER_STATE_ACTIVE = 401;
const NPC_TIMER_STATE_TIMER = 402;
const DISAPPROVAL_TIMER_STATE_IDLE = 500;
const DISAPPROVAL_TIMER_STATE_TIMER = 502;
const ATTRIBUTE_PILOT_SECURITY_STATUS = 2610;

const WEAPON_TIMER_DURATION_MS = 60_000;
const PVP_TIMER_DURATION_MS = 15 * 60_000;
const NPC_TIMER_DURATION_MS = 5 * 60_000;
const CRIMINAL_TIMER_DURATION_MS = 15 * 60_000;
const DISAPPROVAL_TIMER_DURATION_MS = 5 * 60_000;
const LIMITED_ENGAGEMENT_DURATION_MS = 5 * 60_000;
const SECURITY_STATUS_MIN = -10;
const SECURITY_STATUS_MAX = 10;
const OUTLAW_SECURITY_STATUS = -5;
const SECURITY_STATUS_SHIP_AGGRESSION_MODIFIER = -0.025;
const SECURITY_STATUS_CAPSULE_AGGRESSION_MODIFIER = -0.25;
const SECURITY_STATUS_ROUND_DIGITS = 4;
const SECURITY_STATUS_DUPLICATE_WINDOW_MS = WEAPON_TIMER_DURATION_MS;
const GROUP_CAPSULE = 29;
const GROUP_STARGATE = 10;
const GROUP_STATION = 15;
const MIN_PLAYER_OWNER_ID = 90_000_000;
const CONCORD_CORPORATION_ID = 1_000_125;
const CATEGORY_DEPLOYABLE = 22;
const GROUP_MOBILE_DEPOT = 1246;
// Customs Office Gantry (crimewatch/const.py targetGroupsWithSuspectPenaltyInHighSec:
// groupOrbitalConstructionPlatforms): shooting one in highsec is a suspect act.
const GROUP_ORBITAL_CONSTRUCTION_PLATFORM = 1106;
// Corporation property in space with no pilot: orbitals (Customs Offices,
// gantries, skyhooks) and Upwell structures. The client treats a player-owned
// one like any other player target (crimewatchSvc.GetSafetyLevelRestrictionForAttackingTarget:
// not CanAttackFreely, so criminal in highsec unless DoesConcordReact says no).
const CATEGORY_ORBITAL = 46;
const CATEGORY_STRUCTURE = 65;
const GROUP_MOBILE_TRACTOR_UNIT = 1250;
const PENALTY_CONTRIBUTION_VERSION = 1;
const THEFT_RECEIPT_STATE_PREPARED = "prepared";
const THEFT_RECEIPT_STATE_COMMITTED = "committed";

const ONE_AU_IN_METERS = 149_597_870_700;
// EntityWarpIn starts the warp curve five ticks in (evolve.js entityWarpIn), so a
// responder is on grid about 2 s after leaving from here, off grid.
const CONCORD_RESPONSE_WARP_ORIGIN_MIN_DISTANCE_METERS = 100_000_000;
const CONCORD_RESPONSE_WARP_ORIGIN_MAX_DISTANCE_METERS = 200_000_000;
const CONCORD_RESPONSE_WARP_ORIGIN_SEARCH_STEP_METERS = 50_000_000;
const CONCORD_RESPONSE_WARP_ORIGIN_CLEARANCE_METERS = 50_000_000;
const CONCORD_RESPONSE_WARP_ORIGIN_LOCAL_SPAWN_DISTANCE_METERS = 1_000;
const CONCORD_RESPONSE_WARP_ORIGIN_LOCAL_SPAWN_SPREAD_METERS = 12_000;
const CONCORD_RESPONSE_WARP_SPEED_AU = 15;
// Two Police Captains and a Police Commander, as TQ logs show CONCORD standing and
// as CCP's 2008 Serious Security blog and EVE University describe it. Their own
// scan resolutions make the disable and the kill: the Captains lock a frigate in
// about 2 s, and the Commander a battleship in about 15 s and a freighter in about 7 s.
const CONCORD_RESPONSE_SPAWN_GROUP_ID = "concord_crimewatch_response";
// Time from dispatch to the Captains' lock, measured in Jita: stopped on grid at
// 4.5 s, wake at 5.1 s, then their own lock, 2.2 s on a frigate and 0.4 s on a
// freighter. The published times were measured on gank ships between those.
const CONCORD_RESPONSE_TRAVEL_MS = 6_000;
// EVE University, Suicide ganking: a spawn already within 150 km reacts almost at
// once, and one further away respawns beside the offender, adding about 6 s.
const CONCORD_RESPONSE_IDLE_SPAWN_RANGE_METERS = 150_000;
const CONCORD_RESPONSE_IDLE_SPAWN_RELOCATE_MS = 6_000;
// `client/crime4.txt` showed native EntityShip `EntityWarpIn` finishing its
// client-side warp phase roughly one second after the acquire packet batch, so
// the old 3.5s server ingress badly overhung the client and read as "spawn in,
// then sit there". `client/crime6.txt` showed the opposite extreme: a 1.0s
// server ingress let observers acquire CONCORD so late that the very next tick
// was already the full Stop/SetBallPosition landing handoff. Keep Crimewatch
// ingress slightly longer than the client's local effect so observers actually
// get a visible arrival window without drifting multiple seconds out of sync.
// Keep it above the 2.0s floor from `crime6.txt` so observers get one more
// scene beat to read the decel/landing instead of collapsing straight into the
// first authoritative Stop handoff.
const CONCORD_RESPONSE_INGRESS_DURATION_MS = 2_500;
const CONCORD_RESPONSE_ARRIVAL_RING_METERS = 9_000;
const CONCORD_RESPONSE_RETASK_INTERVAL_MS = 1_000;
const CONCORD_RESPONSE_COMPLETION_CLEAR_MS = 3_000;

const characterCrimewatchState = new Map();
const limitedEngagements = new Map();
const hydratedLimitedEngagementKeys = new Set();
let allLimitedEngagementsHydrated = false;
const systemConcordResponses = new Map();
const lastBroadcastTimerSnapshots = new Map();
const lastBroadcastFlagSnapshots = new Map();
const lastBroadcastDisapprovalSnapshots = new Map();
const recentSecurityPenaltyTargets = new Map();
// Live module references are deliberately transient. Durable expiries remain
// finite, so restarting the server cannot leave an active timer stuck forever.
const moduleCombatActivities = new Map();
const characterCombatActivities = new Map();
// Limited engagements the pilots' clients show as ongoing (-1) because an
// offensive module between the pair is still running. Retail stops the
// engagement countdown while the fight continues and restarts it when the
// last module stops (LOGS\Tutorial\Soldier of Fortune\kill 2 capsuleers.lsw,
// lose 5 ships.lsw: StopTimeout beside PvpTimer 201, StartTimeout beside 202).
const ongoingLimitedEngagementKeys = new Set();
const LIMITED_ENGAGEMENT_TIMEOUT_ONGOING = -1;

function getCharacterStateService() {
  return require(path.join(__dirname, "../character/characterState"));
}

function getKillRightStateService() {
  return require(path.join(__dirname, "../bounty/killRightState"));
}

function getKillRightNotificationsService() {
  return require(path.join(__dirname, "../bounty/killRightNotifications"));
}

function getWarRuntimeStateService() {
  return require(path.join(__dirname, "../corporation/warRuntimeState"));
}

function getCorporationStateService() {
  return require(path.join(__dirname, "../corporation/corporationState"));
}

function isLegalCorporationFriendlyFire(
  attackerCharacterID,
  targetCharacterID,
  nowMs,
) {
  try {
    const corporationState = getCorporationStateService();
    if (
      !corporationState ||
      typeof corporationState.areCharactersFriendlyFireLegal !== "function"
    ) {
      return false;
    }
    return Boolean(
      corporationState.areCharactersFriendlyFireLegal(
        attackerCharacterID,
        targetCharacterID,
        { nowMs },
      ),
    );
  } catch (error) {
    log.debug(`[Crimewatch] friendly fire check for attacker=${attackerCharacterID} target=${targetCharacterID} failed: ${error && error.message}`);
    return false;
  }
}

function findLegalWarAggression(attackerCharacterID, targetCharacterID, nowMs) {
  const warRuntime = getWarRuntimeStateService();
  if (
    !warRuntime ||
    typeof warRuntime.findActiveWarBetweenCharacters !== "function"
  ) {
    return null;
  }
  return warRuntime.findActiveWarBetweenCharacters(
    attackerCharacterID,
    targetCharacterID,
    { nowMs },
  );
}

function resolveCharacterRecord(characterID) {
  const characterState = getCharacterStateService();
  return characterState && typeof characterState.getCharacterRecord === "function"
    ? characterState.getCharacterRecord(characterID)
    : null;
}

function updateCharacterStateRecord(characterID, mutator) {
  const characterState = getCharacterStateService();
  return characterState && typeof characterState.updateCharacterRecord === "function"
    ? characterState.updateCharacterRecord(characterID, mutator)
    : { success: false, errorMsg: "CHARACTER_STATE_UNAVAILABLE" };
}

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function toInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value));
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.min(
    Math.max(toFiniteNumber(value, minimum), toFiniteNumber(minimum, value)),
    toFiniteNumber(maximum, value),
  );
}

function roundNumber(value, digits = 6) {
  const numeric = toFiniteNumber(value, 0);
  const factor = 10 ** Math.max(0, Math.trunc(toFiniteNumber(digits, 0)));
  return Math.round(numeric * factor) / factor;
}

function cloneVector(value, fallback = { x: 0, y: 0, z: 0 }) {
  return {
    x: toFiniteNumber(value && value.x, fallback.x),
    y: toFiniteNumber(value && value.y, fallback.y),
    z: toFiniteNumber(value && value.z, fallback.z),
  };
}

function addVectors(left, right) {
  return {
    x: toFiniteNumber(left && left.x, 0) + toFiniteNumber(right && right.x, 0),
    y: toFiniteNumber(left && left.y, 0) + toFiniteNumber(right && right.y, 0),
    z: toFiniteNumber(left && left.z, 0) + toFiniteNumber(right && right.z, 0),
  };
}

function subtractVectors(left, right) {
  return {
    x: toFiniteNumber(left && left.x, 0) - toFiniteNumber(right && right.x, 0),
    y: toFiniteNumber(left && left.y, 0) - toFiniteNumber(right && right.y, 0),
    z: toFiniteNumber(left && left.z, 0) - toFiniteNumber(right && right.z, 0),
  };
}

function scaleVector(vector, scalar) {
  return {
    x: toFiniteNumber(vector && vector.x, 0) * scalar,
    y: toFiniteNumber(vector && vector.y, 0) * scalar,
    z: toFiniteNumber(vector && vector.z, 0) * scalar,
  };
}

function magnitude(vector) {
  const resolved = cloneVector(vector);
  return Math.sqrt((resolved.x ** 2) + (resolved.y ** 2) + (resolved.z ** 2));
}

function normalizeVector(vector, fallback = { x: 1, y: 0, z: 0 }) {
  const resolved = cloneVector(vector, fallback);
  const length = magnitude(resolved);
  if (!Number.isFinite(length) || length <= 0) {
    return cloneVector(fallback);
  }

  return scaleVector(resolved, 1 / length);
}

function distanceSquared(left, right) {
  const dx = toFiniteNumber(left && left.x, 0) - toFiniteNumber(right && right.x, 0);
  const dy = toFiniteNumber(left && left.y, 0) - toFiniteNumber(right && right.y, 0);
  const dz = toFiniteNumber(left && left.z, 0) - toFiniteNumber(right && right.z, 0);
  return (dx ** 2) + (dy ** 2) + (dz ** 2);
}

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function buildConcordResponseOriginAnchor(scene, offenderEntity) {
  const offenderPosition = cloneVector(offenderEntity && offenderEntity.position);
  const fallbackDirection = normalizeVector(
    offenderEntity && offenderEntity.direction,
    { x: 1, y: 0, z: 0 },
  );
  const fallbackOffsetDirection = normalizeVector(
    scaleVector(fallbackDirection, -1),
    { x: -1, y: 0, z: 0 },
  );
  const fallbackPosition = addVectors(
    offenderPosition,
    scaleVector(
      fallbackOffsetDirection,
      CONCORD_RESPONSE_WARP_ORIGIN_MIN_DISTANCE_METERS,
    ),
  );
  if (!scene || !offenderEntity) {
    return {
      position: fallbackPosition,
      direction: normalizeVector(
        subtractVectors(offenderPosition, fallbackPosition),
        fallbackDirection,
      ),
    };
  }

  const originAnchor = findSafeWarpOriginAnchor(scene, offenderEntity, {
    direction: fallbackOffsetDirection,
    clearanceMeters: CONCORD_RESPONSE_WARP_ORIGIN_CLEARANCE_METERS,
    minDistanceMeters: CONCORD_RESPONSE_WARP_ORIGIN_MIN_DISTANCE_METERS,
    maxDistanceMeters: CONCORD_RESPONSE_WARP_ORIGIN_MAX_DISTANCE_METERS,
    stepMeters: CONCORD_RESPONSE_WARP_ORIGIN_SEARCH_STEP_METERS,
  });
  return {
    position: cloneVector(originAnchor && originAnchor.position, fallbackPosition),
    direction: normalizeVector(
      subtractVectors(
        offenderPosition,
        cloneVector(originAnchor && originAnchor.position, fallbackPosition),
      ),
      fallbackDirection,
    ),
  };
}

function buildDefaultCharacterState(characterID) {
  return {
    characterID: toPositiveInt(characterID, 0),
    safetyLevel: SAFETY_LEVEL_FULL,
    weaponTimerExpiresAtMs: 0,
    pvpTimerExpiresAtMs: 0,
    npcTimerExpiresAtMs: 0,
    criminalTimerExpiresAtMs: 0,
    disapprovalTimerExpiresAtMs: 0,
    criminal: false,
    suspect: false,
    lastKnownSystemID: 0,
    lastCriminalAtMs: 0,
    penaltyContributionVersion: PENALTY_CONTRIBUTION_VERSION,
    nonTheftPenalty: {
      criminalTimerExpiresAtMs: 0,
      criminal: false,
      suspect: false,
    },
    containerTheftReceipts: {},
  };
}

function normalizeNonTheftPenalty(value) {
  const source = value && typeof value === "object" ? value : {};
  const criminal = source.criminal === true;
  const suspect = !criminal && source.suspect === true;
  return {
    criminalTimerExpiresAtMs:
      criminal || suspect
        ? Math.max(
            0,
            Math.trunc(
              toFiniteNumber(source.criminalTimerExpiresAtMs, 0),
            ),
          )
        : 0,
    criminal,
    suspect,
  };
}

function normalizeContainerTheftReceipts(value) {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
  const normalized = {};
  for (const [rawReceiptID, rawReceipt] of Object.entries(source)) {
    const receiptID = String(rawReceiptID || "").trim().slice(0, 160);
    if (!receiptID || !rawReceipt || typeof rawReceipt !== "object") {
      continue;
    }
    const expiresAtMs = Math.max(
      0,
      Math.trunc(toFiniteNumber(rawReceipt.expiresAtMs, 0)),
    );
    if (expiresAtMs <= 0) {
      continue;
    }
    normalized[receiptID] = {
      receiptID,
      characterID: toPositiveInt(rawReceipt.characterID, 0),
      state:
        rawReceipt.state === THEFT_RECEIPT_STATE_COMMITTED
          ? THEFT_RECEIPT_STATE_COMMITTED
          : THEFT_RECEIPT_STATE_PREPARED,
      createdAtMs: Math.max(
        0,
        Math.trunc(toFiniteNumber(rawReceipt.createdAtMs, 0)),
      ),
      expiresAtMs,
      containerOwnerCharacterID: toPositiveInt(
        rawReceipt.containerOwnerCharacterID,
        0,
      ),
      protectedPropertyCorporationID: toPositiveInt(
        rawReceipt.protectedPropertyCorporationID,
        0,
      ),
    };
  }
  return normalized;
}

function recomputeCharacterPenaltyState(state) {
  if (!state || typeof state !== "object") {
    return state;
  }
  state.penaltyContributionVersion = PENALTY_CONTRIBUTION_VERSION;
  state.nonTheftPenalty = normalizeNonTheftPenalty(state.nonTheftPenalty);
  state.containerTheftReceipts = normalizeContainerTheftReceipts(
    state.containerTheftReceipts,
  );

  const base = state.nonTheftPenalty;
  if (base.criminal && base.criminalTimerExpiresAtMs > 0) {
    state.criminalTimerExpiresAtMs = base.criminalTimerExpiresAtMs;
    state.criminal = true;
    state.suspect = false;
    return state;
  }

  let suspectTimerExpiresAtMs =
    base.suspect ? base.criminalTimerExpiresAtMs : 0;
  for (const receipt of Object.values(state.containerTheftReceipts)) {
    suspectTimerExpiresAtMs = Math.max(
      suspectTimerExpiresAtMs,
      toFiniteNumber(receipt && receipt.expiresAtMs, 0),
    );
  }
  state.criminalTimerExpiresAtMs = suspectTimerExpiresAtMs;
  state.criminal = false;
  state.suspect = suspectTimerExpiresAtMs > 0;
  return state;
}

function setNonTheftPenalty(state, kind, expiresAtMs, options = {}) {
  if (!state || typeof state !== "object") {
    return state;
  }
  const normalizedKind = kind === "criminal"
    ? "criminal"
    : kind === "suspect"
      ? "suspect"
      : "none";
  const currentBase = normalizeNonTheftPenalty(state.nonTheftPenalty);
  const currentBaseExpiresAtMs = currentBase.criminalTimerExpiresAtMs;
  const requestedExpiresAtMs = Math.max(
    0,
    Math.trunc(toFiniteNumber(expiresAtMs, 0)),
  );
  const resolvedExpiresAtMs = options.exact === true
    ? requestedExpiresAtMs
    : Math.max(currentBaseExpiresAtMs, requestedExpiresAtMs);
  state.nonTheftPenalty = {
    criminalTimerExpiresAtMs:
      normalizedKind === "none" ? 0 : resolvedExpiresAtMs,
    criminal: normalizedKind === "criminal" && resolvedExpiresAtMs > 0,
    suspect: normalizedKind === "suspect" && resolvedExpiresAtMs > 0,
  };
  return recomputeCharacterPenaltyState(state);
}

function replaceCharacterState(target, source) {
  for (const key of Object.keys(target || {})) {
    delete target[key];
  }
  Object.assign(target, cloneValue(source));
  return target;
}

function rollbackRejectedCharacterStateMutation(state, previousState) {
  replaceCharacterState(state, previousState);
  // A failed flush may still have dirtied the game-store cache. Restage the
  // acknowledged value so a later unrelated flush cannot publish the rejected
  // mutation. If this retry also fails, the caller still fails closed and the
  // authoritative in-memory state remains the prior value.
  crimewatchRuntimeState.upsertCharacterState(previousState);
}

function normalizeStoredCharacterState(record, characterID) {
  const normalizedCharacterID = toPositiveInt(
    characterID,
    toPositiveInt(record && record.characterID, 0),
  );
  if (!normalizedCharacterID || !record || typeof record !== "object") {
    return null;
  }

  const normalized = buildDefaultCharacterState(normalizedCharacterID);
  normalized.safetyLevel = normalizeSafetyLevel(record.safetyLevel);
  for (const field of [
    "weaponTimerExpiresAtMs",
    "pvpTimerExpiresAtMs",
    "npcTimerExpiresAtMs",
    "criminalTimerExpiresAtMs",
    "disapprovalTimerExpiresAtMs",
    "lastCriminalAtMs",
  ]) {
    normalized[field] = Math.max(
      0,
      Math.trunc(toFiniteNumber(record[field], 0)),
    );
  }
  normalized.lastKnownSystemID = toPositiveInt(record.lastKnownSystemID, 0);
  const drop = record.securityStatusDrop;
  if (drop && Number.isFinite(Number(drop.previousSecurityStatus)) &&
      Number.isFinite(Number(drop.nextSecurityStatus)) &&
      Number(drop.nextSecurityStatus) < Number(drop.previousSecurityStatus) &&
      Number(drop.atMs) >= 0 && Number(drop.expiresAtMs) > Number(drop.atMs) &&
      toPositiveInt(drop.systemID, 0)) {
    normalized.securityStatusDrop = {
      atMs: Math.trunc(Number(drop.atMs)),
      expiresAtMs: Math.min(Math.trunc(Number(drop.expiresAtMs)), Math.trunc(Number(drop.atMs)) + WEAPON_TIMER_DURATION_MS),
      systemID: toPositiveInt(drop.systemID, 0),
      targetKey: String(drop.targetKey || ""),
      previousSecurityStatus: clampSecurityStatus(drop.previousSecurityStatus),
      nextSecurityStatus: clampSecurityStatus(drop.nextSecurityStatus),
    };
  }
  normalized.criminal = record.criminal === true;
  normalized.suspect = !normalized.criminal && record.suspect === true;
  if (
    toInt(record.penaltyContributionVersion, 0) ===
    PENALTY_CONTRIBUTION_VERSION
  ) {
    normalized.nonTheftPenalty = normalizeNonTheftPenalty(
      record.nonTheftPenalty,
    );
    normalized.containerTheftReceipts = normalizeContainerTheftReceipts(
      record.containerTheftReceipts,
    );
  } else {
    // Legacy rows have only the aggregate penalty fields. Treat that timer as
    // a non-theft contribution during migration: compensation must never erase
    // a penalty whose provenance predates operation-scoped receipts.
    normalized.nonTheftPenalty = normalizeNonTheftPenalty({
      criminalTimerExpiresAtMs: normalized.criminalTimerExpiresAtMs,
      criminal: normalized.criminal,
      suspect: normalized.suspect,
    });
    normalized.containerTheftReceipts = {};
  }
  recomputeCharacterPenaltyState(normalized);
  return normalized;
}

function hydrateCharacterState(characterID) {
  const normalizedCharacterID = toPositiveInt(characterID, 0);
  if (!normalizedCharacterID) {
    return null;
  }
  if (characterCrimewatchState.has(normalizedCharacterID)) {
    return characterCrimewatchState.get(normalizedCharacterID);
  }

  const storedState = normalizeStoredCharacterState(
    crimewatchRuntimeState.getCharacterState(normalizedCharacterID),
    normalizedCharacterID,
  );
  if (storedState) {
    characterCrimewatchState.set(normalizedCharacterID, storedState);
  }
  return storedState;
}

function hydrateAllStoredCharacterStates() {
  for (const storedRecord of crimewatchRuntimeState.listCharacterStates()) {
    const normalized = normalizeStoredCharacterState(storedRecord);
    if (
      normalized &&
      !characterCrimewatchState.has(normalized.characterID)
    ) {
      characterCrimewatchState.set(normalized.characterID, normalized);
    }
  }
}

function isLegalCorporationPropertyFriendlyFire(
  attackerCharacterID,
  targetCorporationID,
  nowMs,
) {
  try {
    const corporationState = getCorporationStateService();
    if (
      !corporationState ||
      typeof corporationState.isCharacterCorporationFriendlyFireLegal !==
        "function"
    ) {
      return false;
    }
    return Boolean(
      corporationState.isCharacterCorporationFriendlyFireLegal(
        attackerCharacterID,
        targetCorporationID,
        { nowMs },
      ),
    );
  } catch (error) {
    log.debug(`[Crimewatch] corporation property friendly fire check for attacker=${attackerCharacterID} corporation=${targetCorporationID} failed: ${error && error.message}`);
    return false;
  }
}

function persistCharacterState(state) {
  const normalized = normalizeStoredCharacterState(
    state,
    state && state.characterID,
  );
  if (!normalized) {
    return { success: false, errorMsg: "INVALID_CHARACTER_STATE" };
  }
  return crimewatchRuntimeState.upsertCharacterState(normalized);
}

function finalizeCharacterStateMutation(state, result) {
  const persistenceResult = persistCharacterState(state);
  if (!persistenceResult || persistenceResult.success !== true) {
    return {
      success: false,
      errorMsg: "CRIMEWATCH_STATE_PERSIST_FAILED",
      data: {
        ...(result && result.data ? result.data : {}),
        persistenceError:
          persistenceResult && persistenceResult.errorMsg
            ? persistenceResult.errorMsg
            : "WRITE_ERROR",
      },
    };
  }
  require("../ship/safeLogoffRuntime").handleCrimewatchStateChanged(state);
  return result;
}

function normalizeLimitedEngagementPair(firstCharacterID, secondCharacterID) {
  const first = toPositiveInt(firstCharacterID, 0);
  const second = toPositiveInt(secondCharacterID, 0);
  if (!first || !second || first === second) {
    return null;
  }
  return first < second
    ? [first, second]
    : [second, first];
}

function normalizeLimitedEngagementNow(value, fallback = Date.now()) {
  const resolvedValue = value === null || value === undefined
    ? fallback
    : value;
  return Math.max(
    0,
    Math.trunc(toFiniteNumber(resolvedValue, fallback)),
  );
}

function findLegalWarAggressionAgainstCorporation(
  attackerCharacterID,
  targetCorporationID,
  nowMs,
) {
  const warRuntime = getWarRuntimeStateService();
  if (
    !warRuntime ||
    typeof warRuntime.findActiveWarBetweenCharacterAndCorporation !==
      "function"
  ) {
    return null;
  }
  return warRuntime.findActiveWarBetweenCharacterAndCorporation(
    attackerCharacterID,
    targetCorporationID,
    { nowMs },
  );
}

function buildLimitedEngagementKey(firstCharacterID, secondCharacterID) {
  const pair = normalizeLimitedEngagementPair(
    firstCharacterID,
    secondCharacterID,
  );
  return pair ? `${pair[0]}:${pair[1]}` : "";
}

function normalizeStoredLimitedEngagement(record) {
  const pair = normalizeLimitedEngagementPair(
    record && record.firstCharacterID,
    record && record.secondCharacterID,
  );
  if (!pair || !record || typeof record !== "object") {
    return null;
  }

  const expiresAtMs = Math.max(
    0,
    Math.trunc(toFiniteNumber(record.expiresAtMs, 0)),
  );
  if (!expiresAtMs) {
    return null;
  }
  const refreshedAtMs = Math.max(
    0,
    Math.trunc(toFiniteNumber(record.refreshedAtMs, 0)),
  );
  const createdAtMs = Math.max(
    0,
    Math.trunc(toFiniteNumber(
      record.createdAtMs,
      refreshedAtMs || Math.max(0, expiresAtMs - LIMITED_ENGAGEMENT_DURATION_MS),
    )),
  );
  return {
    firstCharacterID: pair[0],
    secondCharacterID: pair[1],
    createdAtMs,
    refreshedAtMs: refreshedAtMs || createdAtMs,
    expiresAtMs,
    reason: String(record.reason || "COMBAT").trim() || "COMBAT",
  };
}

function hydrateLimitedEngagement(firstCharacterID, secondCharacterID) {
  const key = buildLimitedEngagementKey(firstCharacterID, secondCharacterID);
  if (!key) {
    return null;
  }
  if (hydratedLimitedEngagementKeys.has(key)) {
    return limitedEngagements.get(key) || null;
  }

  hydratedLimitedEngagementKeys.add(key);
  const stored = normalizeStoredLimitedEngagement(
    crimewatchRuntimeState.getLimitedEngagement(
      firstCharacterID,
      secondCharacterID,
    ),
  );
  if (stored) {
    limitedEngagements.set(key, stored);
  }
  return stored;
}

function hydrateAllLimitedEngagements() {
  if (allLimitedEngagementsHydrated) {
    return;
  }
  for (const storedRecord of crimewatchRuntimeState.listLimitedEngagements()) {
    const normalized = normalizeStoredLimitedEngagement(storedRecord);
    if (!normalized) {
      continue;
    }
    const key = buildLimitedEngagementKey(
      normalized.firstCharacterID,
      normalized.secondCharacterID,
    );
    hydratedLimitedEngagementKeys.add(key);
    if (!limitedEngagements.has(key)) {
      limitedEngagements.set(key, normalized);
    }
  }
  allLimitedEngagementsHydrated = true;
}

function removeLimitedEngagement(firstCharacterID, secondCharacterID) {
  const key = buildLimitedEngagementKey(firstCharacterID, secondCharacterID);
  if (!key) {
    return { success: false, errorMsg: "INVALID_LIMITED_ENGAGEMENT" };
  }
  limitedEngagements.delete(key);
  hydratedLimitedEngagementKeys.add(key);
  ongoingLimitedEngagementKeys.delete(key);
  const removeResult = crimewatchRuntimeState.removeLimitedEngagement(
    firstCharacterID,
    secondCharacterID,
  );
  notifyLimitedEngagementEnded(firstCharacterID, secondCharacterID);
  return removeResult;
}

function getLimitedEngagement(
  firstCharacterID,
  secondCharacterID,
  now = Date.now(),
) {
  const key = buildLimitedEngagementKey(firstCharacterID, secondCharacterID);
  if (!key) {
    return null;
  }
  const engagement = hydrateLimitedEngagement(
    firstCharacterID,
    secondCharacterID,
  );
  if (!engagement) {
    return null;
  }
  const normalizedNow = normalizeLimitedEngagementNow(now);
  if (engagement.expiresAtMs <= normalizedNow) {
    const removeResult = removeLimitedEngagement(
      firstCharacterID,
      secondCharacterID,
    );
    if (!removeResult || removeResult.success !== true) {
      return null;
    }
    return null;
  }
  return cloneValue(engagement);
}

function hasActiveLimitedEngagement(
  firstCharacterID,
  secondCharacterID,
  now = Date.now(),
) {
  return Boolean(
    getLimitedEngagement(firstCharacterID, secondCharacterID, now),
  );
}

function createOrRefreshLimitedEngagement(
  firstCharacterID,
  secondCharacterID,
  options = {},
) {
  const pair = normalizeLimitedEngagementPair(
    firstCharacterID,
    secondCharacterID,
  );
  if (!pair) {
    return { success: false, errorMsg: "INVALID_LIMITED_ENGAGEMENT" };
  }
  const now = normalizeLimitedEngagementNow(options.now);
  const key = buildLimitedEngagementKey(pair[0], pair[1]);
  const wasHydrated = hydratedLimitedEngagementKeys.has(key);
  const cachedBefore = limitedEngagements.get(key);
  const existing = getLimitedEngagement(pair[0], pair[1], now);
  const refreshedAtMs = existing
    ? Math.max(existing.refreshedAtMs, now)
    : now;
  const engagement = {
    firstCharacterID: pair[0],
    secondCharacterID: pair[1],
    createdAtMs: existing ? existing.createdAtMs : now,
    refreshedAtMs,
    expiresAtMs: Math.max(
      existing ? existing.expiresAtMs : 0,
      refreshedAtMs + LIMITED_ENGAGEMENT_DURATION_MS,
    ),
    reason:
      String(options.reason || (existing && existing.reason) || "COMBAT").trim() ||
      "COMBAT",
  };
  const rollbackDuelCache = () => {
    if (cachedBefore && cachedBefore.expiresAtMs > now) limitedEngagements.set(key, cachedBefore);
    else limitedEngagements.delete(key);
    if (wasHydrated) hydratedLimitedEngagementKeys.add(key);
    else hydratedLimitedEngagementKeys.delete(key);
  };
  // A voluntary duel has not begun until its permission and accepted-outcome
  // receipt commit. Ordinary combat retains its existing permission fallback.
  if (!options.duelReceiptID) {
    limitedEngagements.set(key, engagement);
    hydratedLimitedEngagementKeys.add(key);
  }
  let persistenceResult;
  try {
    persistenceResult = options.duelReceiptID
      ? crimewatchRuntimeState.upsertDuelEngagement(engagement, options.duelReceiptID)
      : crimewatchRuntimeState.upsertLimitedEngagement(engagement);
  } catch (error) {
    if (options.duelReceiptID) rollbackDuelCache();
    throw error;
  }
  if (options.duelReceiptID) {
    if (persistenceResult?.success) {
      limitedEngagements.set(key, engagement);
      hydratedLimitedEngagementKeys.add(key);
    } else rollbackDuelCache();
  }
  if (!options.duelReceiptID || persistenceResult?.success) {
    notifyLimitedEngagementChanged(engagement, !existing);
  }
  if (!persistenceResult || persistenceResult.success !== true) {
    // Ordinary combat keeps permission once hostilities have begun; the failed
    // durable write stays explicit and can be retried by the next refresh.
    return {
      success: false,
      errorMsg: "LIMITED_ENGAGEMENT_PERSIST_FAILED",
      data: {
        engagement: cloneValue(engagement),
        persistenceError:
          persistenceResult && persistenceResult.errorMsg
            ? persistenceResult.errorMsg
            : "WRITE_ERROR",
      },
    };
  }
  return {
    success: true,
    data: {
      applied: true,
      created: !existing,
      engagement: cloneValue(engagement),
    },
  };
}

function refreshLimitedEngagementForCombat(
  firstCharacterID,
  secondCharacterID,
  now = Date.now(),
) {
  const normalizedNow = normalizeLimitedEngagementNow(now);
  const existing = getLimitedEngagement(
    firstCharacterID,
    secondCharacterID,
    normalizedNow,
  );
  if (!existing) {
    return {
      success: true,
      data: { applied: false, reason: "NO_ACTIVE_LIMITED_ENGAGEMENT" },
    };
  }
  return createOrRefreshLimitedEngagement(
    firstCharacterID,
    secondCharacterID,
    {
      now: normalizedNow,
      reason: existing.reason,
    },
  );
}

function refreshLimitedEngagementForCombatEntities(
  attackerEntity,
  targetEntity,
  now = Date.now(),
) {
  attackerEntity = resolveManualStarbaseAggressor(attackerEntity);
  const attackerCharacterID = getEntityCharacterID(attackerEntity);
  const targetCharacterID = getEntityCharacterID(targetEntity);
  if (
    !attackerCharacterID ||
    !targetCharacterID ||
    attackerCharacterID === targetCharacterID
  ) {
    return {
      success: true,
      data: { applied: false, reason: "NON_PLAYER_COMBAT" },
    };
  }
  return refreshLimitedEngagementForCombat(
    attackerCharacterID,
    targetCharacterID,
    now,
  );
}

function pruneExpiredLimitedEngagements(now = Date.now()) {
  hydrateAllLimitedEngagements();
  const normalizedNow = normalizeLimitedEngagementNow(now);
  let removedCount = 0;
  for (const engagement of Array.from(limitedEngagements.values())) {
    if (engagement.expiresAtMs > normalizedNow) {
      continue;
    }
    const removeResult = removeLimitedEngagement(
      engagement.firstCharacterID,
      engagement.secondCharacterID,
    );
    if (removeResult && removeResult.success === true) {
      removedCount += 1;
    }
  }
  return removedCount;
}

function listLimitedEngagementsForCharacter(characterID, now = Date.now()) {
  const normalizedCharacterID = toPositiveInt(characterID, 0);
  if (!normalizedCharacterID) {
    return [];
  }
  hydrateAllLimitedEngagements();
  const normalizedNow = normalizeLimitedEngagementNow(now);
  const result = [];
  for (const engagement of Array.from(limitedEngagements.values())) {
    if (engagement.expiresAtMs <= normalizedNow) {
      removeLimitedEngagement(
        engagement.firstCharacterID,
        engagement.secondCharacterID,
      );
      continue;
    }
    if (
      engagement.firstCharacterID === normalizedCharacterID ||
      engagement.secondCharacterID === normalizedCharacterID
    ) {
      result.push(cloneValue(engagement));
    }
  }
  return result.sort((left, right) =>
    left.expiresAtMs - right.expiresAtMs ||
    left.firstCharacterID - right.firstCharacterID ||
    left.secondCharacterID - right.secondCharacterID);
}

function getLimitedEngagementOtherCharacterID(engagement, characterID) {
  const normalizedCharacterID = toPositiveInt(characterID, 0);
  if (
    !engagement ||
    !normalizedCharacterID ||
    (
      engagement.firstCharacterID !== normalizedCharacterID &&
      engagement.secondCharacterID !== normalizedCharacterID
    )
  ) {
    return 0;
  }
  return engagement.firstCharacterID === normalizedCharacterID
    ? engagement.secondCharacterID
    : engagement.firstCharacterID;
}

function notifyLimitedEngagementChanged(engagement, created) {
  if (!engagement) {
    return 0;
  }
  // While the fight runs the client shows the engagement as ongoing; a
  // refresh must not put a countdown back.
  const key = buildLimitedEngagementKey(
    engagement.firstCharacterID,
    engagement.secondCharacterID,
  );
  if (!created && ongoingLimitedEngagementKeys.has(key)) {
    return 0;
  }
  let notificationCount = 0;
  for (const characterID of [
    engagement.firstCharacterID,
    engagement.secondCharacterID,
  ]) {
    const session = sessionRegistry.findSessionByCharacterID(characterID);
    const otherCharacterID = getLimitedEngagementOtherCharacterID(
      engagement,
      characterID,
    );
    if (
      !session ||
      !otherCharacterID ||
      typeof session.sendNotification !== "function"
    ) {
      continue;
    }
    try {
      session.sendNotification(
        created
          ? "OnCrimewatchEngagementCreated"
          : "OnCrimewatchEngagementStartTimeout",
        "charid",
        [otherCharacterID, buildFiletimeFromExpiryMs(engagement.expiresAtMs)],
      );
      notificationCount += 1;
    } catch (error) {
      void error;
    }
  }
  // Created during a fight that is already running: retail follows Created
  // with StopTimeout (lose 5 ships.lsw).
  if (
    created &&
    !ongoingLimitedEngagementKeys.has(key) &&
    pairHasRunningModuleCombat(engagement.firstCharacterID, engagement.secondCharacterID)
  ) {
    ongoingLimitedEngagementKeys.add(key);
    notificationCount += notifyLimitedEngagementStopTimeout(engagement);
  }
  return notificationCount;
}

function notifyLimitedEngagementStopTimeout(engagement) {
  let notificationCount = 0;
  for (const characterID of [
    engagement.firstCharacterID,
    engagement.secondCharacterID,
  ]) {
    const session = sessionRegistry.findSessionByCharacterID(characterID);
    const otherCharacterID = getLimitedEngagementOtherCharacterID(
      engagement,
      characterID,
    );
    if (
      !session ||
      !otherCharacterID ||
      typeof session.sendNotification !== "function"
    ) {
      continue;
    }
    try {
      session.sendNotification(
        "OnCrimewatchEngagementStopTimeout",
        "charid",
        [otherCharacterID],
      );
      notificationCount += 1;
    } catch (error) {
      void error;
    }
  }
  return notificationCount;
}

function pairHasRunningModuleCombat(firstCharacterID, secondCharacterID) {
  const activities = characterCombatActivities.get(toPositiveInt(firstCharacterID, 0));
  if (!activities) return false;
  const otherCharacterID = toPositiveInt(secondCharacterID, 0);
  for (const activity of activities) {
    if (activity.endedAtMs === null && activity.participants.has(otherCharacterID)) {
      return true;
    }
  }
  return false;
}

function forEachParticipantPair(participants, callback) {
  const characterIDs = [...participants.keys()];
  for (let i = 0; i < characterIDs.length; i += 1) {
    for (let j = i + 1; j < characterIDs.length; j += 1) {
      const key = buildLimitedEngagementKey(characterIDs[i], characterIDs[j]);
      if (key) callback(characterIDs[i], characterIDs[j], key);
    }
  }
}

// A module combat activity began: every engaged pair it covers switches to
// ongoing (StopTimeout) once.
function markLimitedEngagementsOngoingForParticipants(participants, now) {
  forEachParticipantPair(participants, (first, second, key) => {
    if (ongoingLimitedEngagementKeys.has(key)) return;
    const engagement = getLimitedEngagement(first, second, now);
    if (!engagement) return;
    ongoingLimitedEngagementKeys.add(key);
    notifyLimitedEngagementStopTimeout(engagement);
  });
}

// A module combat activity ended: a pair with no other running module
// restarts its countdown from the stop (StartTimeout with the new expiry).
function resumeLimitedEngagementTimeoutsForParticipants(participants, now) {
  forEachParticipantPair(participants, (first, second, key) => {
    if (!ongoingLimitedEngagementKeys.has(key)) return;
    if (pairHasRunningModuleCombat(first, second)) return;
    ongoingLimitedEngagementKeys.delete(key);
    const existing = getLimitedEngagement(first, second, now);
    if (!existing) return;
    createOrRefreshLimitedEngagement(first, second, { now, reason: existing.reason });
  });
}

// The countdown is held while the fight runs, so the record is kept fresh at
// the activity refresh cadence without telling the client anything.
function holdOngoingLimitedEngagementsForParticipants(participants, now) {
  forEachParticipantPair(participants, (first, second, key) => {
    if (!ongoingLimitedEngagementKeys.has(key)) return;
    const existing = getLimitedEngagement(first, second, now);
    if (!existing) return;
    createOrRefreshLimitedEngagement(first, second, { now, reason: existing.reason });
  });
}

function notifyLimitedEngagementEnded(firstCharacterID, secondCharacterID) {
  const pair = normalizeLimitedEngagementPair(
    firstCharacterID,
    secondCharacterID,
  );
  if (!pair) {
    return 0;
  }
  let notificationCount = 0;
  for (const [characterID, otherCharacterID] of [
    [pair[0], pair[1]],
    [pair[1], pair[0]],
  ]) {
    const session = sessionRegistry.findSessionByCharacterID(characterID);
    if (!session || typeof session.sendNotification !== "function") {
      continue;
    }
    try {
      session.sendNotification(
        "OnCrimewatchEngagementEnded",
        "charid",
        [otherCharacterID],
      );
      notificationCount += 1;
    } catch (error) {
      void error;
    }
  }
  return notificationCount;
}

function ensureCharacterState(characterID) {
  const normalizedCharacterID = toPositiveInt(characterID, 0);
  if (!normalizedCharacterID) {
    return null;
  }

  if (
    !characterCrimewatchState.has(normalizedCharacterID) &&
    !hydrateCharacterState(normalizedCharacterID)
  ) {
    characterCrimewatchState.set(
      normalizedCharacterID,
      buildDefaultCharacterState(normalizedCharacterID),
    );
  }

  return characterCrimewatchState.get(normalizedCharacterID);
}

function pruneCharacterState(characterID, now = Date.now()) {
  const normalizedCharacterID = toPositiveInt(characterID, 0);
  const state = hydrateCharacterState(normalizedCharacterID);
  pruneSecurityPenaltyTracker(normalizedCharacterID, now);
  if (!state) {
    return { success: true, changed: false };
  }

  let changed = false;

  if (state.securityStatusDrop && Number(state.securityStatusDrop.expiresAtMs) <= now) {
    delete state.securityStatusDrop;
    changed = true;
  }

  if (toFiniteNumber(state.weaponTimerExpiresAtMs, 0) <= now) {
    changed = state.weaponTimerExpiresAtMs !== 0 || changed;
    state.weaponTimerExpiresAtMs = 0;
  }
  if (toFiniteNumber(state.pvpTimerExpiresAtMs, 0) <= now) {
    changed = state.pvpTimerExpiresAtMs !== 0 || changed;
    state.pvpTimerExpiresAtMs = 0;
  }
  if (toFiniteNumber(state.npcTimerExpiresAtMs, 0) <= now) {
    changed = state.npcTimerExpiresAtMs !== 0 || changed;
    state.npcTimerExpiresAtMs = 0;
  }
  const priorPenaltySnapshot = JSON.stringify({
    criminalTimerExpiresAtMs: state.criminalTimerExpiresAtMs,
    criminal: state.criminal,
    suspect: state.suspect,
    nonTheftPenalty: state.nonTheftPenalty,
    containerTheftReceipts: state.containerTheftReceipts,
  });
  const basePenalty = normalizeNonTheftPenalty(state.nonTheftPenalty);
  state.nonTheftPenalty =
    toFiniteNumber(basePenalty.criminalTimerExpiresAtMs, 0) <= now
      ? normalizeNonTheftPenalty(null)
      : basePenalty;
  const theftReceipts = normalizeContainerTheftReceipts(
    state.containerTheftReceipts,
  );
  for (const [receiptID, receipt] of Object.entries(theftReceipts)) {
    if (toFiniteNumber(receipt && receipt.expiresAtMs, 0) <= now) {
      delete theftReceipts[receiptID];
    }
  }
  state.containerTheftReceipts = theftReceipts;
  recomputeCharacterPenaltyState(state);
  changed =
    JSON.stringify({
      criminalTimerExpiresAtMs: state.criminalTimerExpiresAtMs,
      criminal: state.criminal,
      suspect: state.suspect,
      nonTheftPenalty: state.nonTheftPenalty,
      containerTheftReceipts: state.containerTheftReceipts,
    }) !== priorPenaltySnapshot || changed;
  if (toFiniteNumber(state.disapprovalTimerExpiresAtMs, 0) <= now) {
    changed = state.disapprovalTimerExpiresAtMs !== 0 || changed;
    state.disapprovalTimerExpiresAtMs = 0;
  }

  const shouldKeep =
    state.safetyLevel !== SAFETY_LEVEL_FULL ||
    state.weaponTimerExpiresAtMs > now ||
    state.pvpTimerExpiresAtMs > now ||
    state.npcTimerExpiresAtMs > now ||
    state.criminalTimerExpiresAtMs > now ||
    state.disapprovalTimerExpiresAtMs > now ||
    state.criminal === true ||
    state.suspect === true ||
    Number(state.securityStatusDrop && state.securityStatusDrop.expiresAtMs) > now ||
    Object.keys(state.containerTheftReceipts || {}).length > 0;

  if (!shouldKeep) {
    characterCrimewatchState.delete(normalizedCharacterID);
    // Keep lastBroadcastTimerSnapshots: the client is still showing the timers
    // from the last broadcast, and the scene sync can only send the idle
    // transition by diffing against that baseline. The sync deletes the entry
    // itself once it has told the client everything is idle.
    recentSecurityPenaltyTargets.delete(normalizedCharacterID);
    const removeResult = crimewatchRuntimeState.removeCharacterState(
      normalizedCharacterID,
    );
    return removeResult && removeResult.success === true
      ? { success: true, changed: true, removed: true }
      : removeResult || { success: false, errorMsg: "DELETE_ERROR" };
  }
  if (changed) {
    const persistenceResult = persistCharacterState(state);
    return persistenceResult && persistenceResult.success === true
      ? { success: true, changed: true }
      : persistenceResult || { success: false, errorMsg: "WRITE_ERROR" };
  }
  return { success: true, changed: false };
}

function pruneAllCharacterStates(now = Date.now()) {
  hydrateAllStoredCharacterStates();
  for (const characterID of characterCrimewatchState.keys()) {
    pruneCharacterState(characterID, now);
  }
}

function ensureSystemResponseMap(systemID) {
  const normalizedSystemID = toPositiveInt(systemID, 0);
  if (!normalizedSystemID) {
    return null;
  }

  if (!systemConcordResponses.has(normalizedSystemID)) {
    systemConcordResponses.set(normalizedSystemID, new Map());
  }
  return systemConcordResponses.get(normalizedSystemID);
}

function pruneSystemResponseMap(systemID) {
  const normalizedSystemID = toPositiveInt(systemID, 0);
  const responseMap = systemConcordResponses.get(normalizedSystemID) || null;
  if (responseMap && responseMap.size === 0) {
    systemConcordResponses.delete(normalizedSystemID);
  }
}

function normalizeSafetyLevel(safetyLevel) {
  const numeric = Math.trunc(Number(safetyLevel));
  if (!Number.isFinite(numeric)) {
    return SAFETY_LEVEL_FULL;
  }

  return Math.max(
    SAFETY_LEVEL_NONE,
    Math.min(SAFETY_LEVEL_FULL, numeric),
  );
}

function getConcordResponseDelayMsForSystem(system) {
  const security = Math.round(getSolarSystemPseudoSecurity(system) * 10) / 10;
  if (security >= 0.9) {
    return 6_000;
  }
  if (security >= 0.8) {
    return 7_000;
  }
  if (security >= 0.7) {
    return 10_000;
  }
  if (security >= 0.6) {
    return 14_000;
  }
  if (security >= 0.5) {
    return 19_000;
  }
  return 0;
}

// The published times are when CONCORD first acts on the offender (EVE
// University, CONCORD and Suicide ganking, community averages CCP never confirmed),
// so the responders leave early enough for their first lock to land on that time.
function getConcordResponseDispatchDelayMsForSystem(system) {
  return Math.max(
    0,
    getConcordResponseDelayMsForSystem(system) - CONCORD_RESPONSE_TRAVEL_MS,
  );
}

function isCrimewatchConcordResponseEnabled() {
  return config.crimewatchConcordResponseEnabled !== false;
}

function isCrimewatchConcordPodKillEnabled() {
  return config.crimewatchConcordPodKillEnabled === true;
}

function getEntityActorKind(entity) {
  if (!entity) {
    return null;
  }

  const npcEntityType = String(
    entity.npcEntityType ||
    entity.entityType ||
    "",
  ).trim().toLowerCase();
  if (npcEntityType === ENTITY_TYPE.CONCORD) {
    return ENTITY_TYPE.CONCORD;
  }
  if (npcEntityType) {
    return ENTITY_TYPE.NPC;
  }

  if (resolveEntityPlayerCharacterID(entity) > 0) {
    return "player";
  }

  return null;
}

function resolveEntityPlayerCharacterID(entity) {
  if (!entity) {
    return 0;
  }

  const directCharacterID = toPositiveInt(
    entity.session && (entity.session.characterID || entity.session.charID),
    toPositiveInt(entity.characterID, 0),
  );
  if (directCharacterID > 0) {
    return directCharacterID;
  }

  const ownerID = toPositiveInt(entity.ownerID, 0);
  if (!ownerID) {
    return 0;
  }

  return resolveCharacterRecord(ownerID) ? ownerID : 0;
}

function getEntityCharacterID(entity) {
  if (!entity) {
    return 0;
  }

  const actorKind = getEntityActorKind(entity);
  if (actorKind !== "player") {
    return 0;
  }

  return resolveEntityPlayerCharacterID(entity);
}

function resolveManualStarbaseAggressor(entity) {
  if (!entity || projectedManualStarbaseSources.has(entity) ||
      Number(entity.categoryID) !== 23 ||
      !require("../starbase/starbaseDefenseRuntime").isStarbaseBattery(entity)) return entity;
  const control = require("../starbase/starbaseControlRuntime");
  const observer = control.getStarbaseControlObserver(entity);
  const context = observer && control.getControlledBatteryContext(observer, entity);
  if (!context || context.entity !== entity) return entity;
  // Keep targeting geometry/item custody on the battery and Dogma pilotless.
  // Only aggression sees this authenticated gunner identity. A controlled gun
  // used as a victim must still be corporation property, not the gunner's ship.
  const projected = { ...entity, session: observer, characterID: context.characterID };
  projectedManualStarbaseSources.set(projected, entity);
  return projected;
}

function resolveManualStarbasePilotShip(scene, entity) {
  if (!entity || !projectedManualStarbaseSources.has(entity)) return entity;
  const session = entity.session;
  const shipID = toPositiveInt(session && session._space && session._space.shipID, 0);
  const ship = scene && typeof scene.getEntityByID === "function" && scene.getEntityByID(shipID);
  return ship && getEntityCharacterID(ship) === getEntityCharacterID(entity) ? ship : entity;
}

// Security status lives on the pilot's ship ball. Kill credit can name a drone
// or fighter, which has no session; move the live update to the pilot's ship
// so the slim item, the ship attribute and the pilot's own status all change.
function resolveSecurityStatusShipEntity(scene, entity, session) {
  const resolved = resolveManualStarbasePilotShip(scene, entity);
  if (!resolved || resolved.session || !session) return resolved;
  const shipID = toPositiveInt(session._space && session._space.shipID, 0);
  const ship = shipID > 0 && scene && typeof scene.getEntityByID === "function"
    ? scene.getEntityByID(shipID)
    : null;
  return ship && ship.session === session ? ship : resolved;
}

function roundSecurityStatus(value) {
  return Number(
    toFiniteNumber(value, 0).toFixed(SECURITY_STATUS_ROUND_DIGITS),
  );
}

function clampSecurityStatus(value) {
  return roundSecurityStatus(
    Math.max(
      SECURITY_STATUS_MIN,
      Math.min(SECURITY_STATUS_MAX, toFiniteNumber(value, 0)),
    ),
  );
}

function isCapsuleEntity(entity) {
  return toPositiveInt(entity && entity.groupID, 0) === GROUP_CAPSULE;
}

function isNpcAuthorityStructure(entity) {
  const groupID = toPositiveInt(entity && (entity.groupID ?? entity.slimGroupID), 0);
  const ownerID = toPositiveInt(entity && entity.ownerID, 0);
  // Matches the client's illegalTargetNpcOwnedGroups and IsSystemOrNPC.
  // A player-owned outpost or structure keeps its existing property rules.
  return (groupID === GROUP_STATION || groupID === GROUP_STARGATE) &&
    ownerID > 0 && ownerID < MIN_PLAYER_OWNER_ID &&
    getEntityCharacterID(entity) === 0;
}

function getNpcAuthorityAggressionConsequence(scene, entity) {
  if (!isHighSecuritySystem(scene && scene.system) && !isLowSecuritySystem(scene && scene.system)) {
    return "none";
  }
  return isHighSecuritySystem(scene.system) || Number(entity.ownerID) === CONCORD_CORPORATION_ID
    ? "criminal"
    : "suspect";
}

function isPersonalDeployableEntity(entity) {
  const categoryID = toPositiveInt(
    entity && (entity.categoryID ?? entity.slimCategoryID),
    0,
  );
  const groupID = toPositiveInt(
    entity && (entity.groupID ?? entity.slimGroupID),
    0,
  );
  return (
    categoryID === CATEGORY_DEPLOYABLE ||
    groupID === GROUP_MOBILE_DEPOT ||
    groupID === GROUP_MOBILE_TRACTOR_UNIT ||
    groupID === GROUP_ORBITAL_CONSTRUCTION_PLATFORM
  );
}

function getCharacterSecurityStatus(characterID, fallback = 0) {
  const record = characterID > 0 ? resolveCharacterRecord(characterID) || null : null;
  return clampSecurityStatus(
    record && (record.securityStatus ?? record.securityRating) !== undefined
      ? record.securityStatus ?? record.securityRating
      : fallback,
  );
}

function getEntitySecurityStatus(entity, fallback = 0) {
  const characterID = getEntityCharacterID(entity);
  if (characterID > 0) {
    const record = resolveCharacterRecord(characterID) || null;
    if (record) {
      return clampSecurityStatus(record.securityStatus ?? record.securityRating ?? fallback);
    }
  }

  return clampSecurityStatus(
    entity && (entity.securityStatus ?? entity.securityRating) !== undefined
      ? entity.securityStatus ?? entity.securityRating
      : fallback,
  );
}

function isOutlawSecurityStatus(value) {
  // The client classifies global outlaw targets from the one-decimal security
  // presentation, where -4.95 rounds to -5.0.
  return Number(toFiniteNumber(value, 0).toFixed(1)) <= OUTLAW_SECURITY_STATUS;
}

function isCharacterOutlaw(characterID) {
  const normalizedCharacterID = toPositiveInt(characterID, 0);
  return normalizedCharacterID > 0 && isOutlawSecurityStatus(
    getCharacterSecurityStatus(normalizedCharacterID, 0),
  );
}

function isPlayerEntityOutlaw(entity) {
  return getEntityCharacterID(entity) > 0 && isOutlawSecurityStatus(
    getEntitySecurityStatus(entity, 0),
  );
}

function setCharacterSecurityStatus(
  characterID,
  nextSecurityStatus,
  options = {},
) {
  const normalizedCharacterID = toPositiveInt(characterID, 0);
  if (!normalizedCharacterID) {
    return {
      success: false,
      errorMsg: "CHARACTER_NOT_FOUND",
    };
  }

  const characterRecord = resolveCharacterRecord(normalizedCharacterID) || null;
  if (!characterRecord) {
    return {
      success: false,
      errorMsg: "CHARACTER_NOT_FOUND",
    };
  }

  const previousSecurityStatus = getCharacterSecurityStatus(normalizedCharacterID, 0);
  const clampedSecurityStatus = clampSecurityStatus(nextSecurityStatus);
  const updateResult = updateCharacterStateRecord(normalizedCharacterID, (record) => ({
    ...record,
    securityStatus: clampedSecurityStatus,
    securityRating: clampedSecurityStatus,
  }));
  if (!updateResult.success) {
    return {
      success: false,
      errorMsg: updateResult.errorMsg || "WRITE_ERROR",
    };
  }

  const liveEntity = resolveSecurityStatusShipEntity(
    options.scene || null,
    options.entity || null,
    options.session || null,
  );
  const syncResult = synchronizeLiveSecurityStatus(
    options.scene || null,
    liveEntity,
    previousSecurityStatus,
    clampedSecurityStatus,
    options.now,
  );

  // The live path only reaches the entity's own session. When the entity has
  // none (a drone or fighter kill whose pilot ship could not be found), the
  // pilot still has to hear about the change: the client caches its own
  // security status until this notification or a relog.
  if (
    options.session &&
    syncResult.selfStatusNotified !== true &&
    (!liveEntity || liveEntity.session !== options.session)
  ) {
    notifyOwnSecurityStatusUpdate(
      options.session,
      clampedSecurityStatus,
      previousSecurityStatus,
    );
  }

  return {
    success: true,
    data: {
      characterID: normalizedCharacterID,
      previousSecurityStatus,
      securityStatus: clampedSecurityStatus,
      securityRating: clampedSecurityStatus,
      slimRecipients: toPositiveInt(syncResult && syncResult.slimRecipients, 0),
      attributeNotified: Boolean(syncResult && syncResult.attributeNotified),
      selfStatusNotified: Boolean(syncResult && syncResult.selfStatusNotified),
    },
  };
}

function getSecurityPenaltyTracker(characterID) {
  const normalizedCharacterID = toPositiveInt(characterID, 0);
  if (!normalizedCharacterID) {
    return null;
  }

  if (!recentSecurityPenaltyTargets.has(normalizedCharacterID)) {
    recentSecurityPenaltyTargets.set(normalizedCharacterID, new Map());
  }
  return recentSecurityPenaltyTargets.get(normalizedCharacterID);
}

function pruneSecurityPenaltyTracker(characterID, now = Date.now()) {
  const normalizedCharacterID = toPositiveInt(characterID, 0);
  const tracker = recentSecurityPenaltyTargets.get(normalizedCharacterID) || null;
  if (!tracker) {
    return;
  }

  for (const [targetKey, expiresAtMs] of tracker.entries()) {
    if (toFiniteNumber(expiresAtMs, 0) <= now) {
      tracker.delete(targetKey);
    }
  }

  if (tracker.size === 0) {
    recentSecurityPenaltyTargets.delete(normalizedCharacterID);
  }
}

function getSecurityPenaltyTargetKey(targetEntity) {
  const targetEntityID = toPositiveInt(targetEntity && targetEntity.itemID, 0);
  if (!targetEntityID) {
    return null;
  }

  return `${targetEntityID}:${isCapsuleEntity(targetEntity) ? "capsule" : "ship"}`;
}

function hasRecentSecurityPenaltyTarget(characterID, targetKey, now = Date.now()) {
  pruneSecurityPenaltyTracker(characterID, now);
  const tracker = recentSecurityPenaltyTargets.get(toPositiveInt(characterID, 0)) || null;
  if (!tracker || !targetKey) {
    return false;
  }

  return toFiniteNumber(tracker.get(targetKey), 0) > now;
}

function rememberRecentSecurityPenaltyTarget(characterID, targetKey, expiresAtMs) {
  const tracker = getSecurityPenaltyTracker(characterID);
  if (!tracker || !targetKey) {
    return false;
  }

  tracker.set(
    targetKey,
    Math.max(0, Math.trunc(toFiniteNumber(expiresAtMs, Date.now()))),
  );
  return true;
}

function resolveSessionCharacterID(session) {
  return toPositiveInt(
    session && (session.characterID || session.charID || session.charid),
    0,
  );
}

function resolveSessionSystemID(session) {
  return toPositiveInt(
    session && (
      (session._space && session._space.systemID) ||
      session.solarsystemid2 ||
      session.solarsystemid
    ),
    0,
  );
}

function getCharacterCrimewatchState(characterID, now = Date.now()) {
  const normalizedCharacterID = toPositiveInt(characterID, 0);
  if (!normalizedCharacterID) {
    return null;
  }

  pruneCharacterState(normalizedCharacterID, now);
  const state = characterCrimewatchState.get(normalizedCharacterID) || null;
  return state ? cloneValue(state) : null;
}

function isCharacterCriminal(characterID, now = Date.now()) {
  const state = getCharacterCrimewatchState(characterID, now);
  return Boolean(
    state &&
    state.criminal === true &&
    toFiniteNumber(state.criminalTimerExpiresAtMs, 0) > now
  );
}

function isCharacterSuspect(characterID, now = Date.now()) {
  const state = getCharacterCrimewatchState(characterID, now);
  return Boolean(
    state &&
    state.suspect === true &&
    state.criminal !== true &&
    toFiniteNumber(state.criminalTimerExpiresAtMs, 0) > now
  );
}

function getSafetyLevel(characterID) {
  const state = ensureCharacterState(characterID);
  return state ? normalizeSafetyLevel(state.safetyLevel) : SAFETY_LEVEL_FULL;
}

function setSafetyLevel(characterID, safetyLevel) {
  const state = ensureCharacterState(characterID);
  if (!state) {
    return {
      success: false,
      errorMsg: "CHARACTER_NOT_FOUND",
    };
  }

  const previousState = cloneValue(state);
  state.safetyLevel = normalizeSafetyLevel(safetyLevel);
  const result = finalizeCharacterStateMutation(state, {
    success: true,
    data: {
      characterID: state.characterID,
      safetyLevel: state.safetyLevel,
    },
  });
  if (!result.success) {
    Object.assign(state, previousState);
    // A failed synchronous flush can leave the gameStore cache dirty even
    // though the durable boundary was not acknowledged. Stage the prior value
    // again so a later retry cannot silently lower safety after this call was
    // rejected.
    crimewatchRuntimeState.upsertCharacterState(previousState);
  }
  return result;
}

function evaluateContainerTheft(
  scene,
  thiefCharacterID,
  containerOwnerCharacterID,
  now = Date.now(),
  options = {},
) {
  const normalizedThiefCharacterID = toPositiveInt(thiefCharacterID, 0);
  const normalizedOwnerID = toPositiveInt(
    containerOwnerCharacterID,
    0,
  );
  const protectedPropertyCorporationID =
    resolveProtectedPlayerCorporationID(
      normalizedOwnerID,
      options && options.protectedPropertyCorporationID,
    );
  const normalizedOwnerCharacterID =
    protectedPropertyCorporationID > 0 ? 0 : normalizedOwnerID;
  if (!normalizedThiefCharacterID) {
    return {
      success: false,
      errorMsg: "CHARACTER_NOT_FOUND",
    };
  }

  const empireSpace =
    isHighSecuritySystem(scene && scene.system) ||
    isLowSecuritySystem(scene && scene.system);
  const ownerIsLegalTarget = protectedPropertyCorporationID > 0
    ? isCharacterInCorporation(
      normalizedThiefCharacterID,
      protectedPropertyCorporationID,
    ) || Boolean(
      findLegalWarAggressionAgainstCorporation(
        normalizedThiefCharacterID,
        protectedPropertyCorporationID,
        now,
      ),
    )
    : normalizedOwnerCharacterID <= 0 ||
      normalizedOwnerCharacterID === normalizedThiefCharacterID ||
      isCharacterCriminal(normalizedOwnerCharacterID, now) ||
      isCharacterSuspect(normalizedOwnerCharacterID, now) ||
      isCharacterOutlaw(normalizedOwnerCharacterID) ||
      hasActiveLimitedEngagement(
        normalizedThiefCharacterID,
        normalizedOwnerCharacterID,
        now,
      ) ||
      Boolean(
        normalizedOwnerCharacterID > 0 &&
        findLegalWarAggression(
          normalizedThiefCharacterID,
          normalizedOwnerCharacterID,
          now,
        ),
      );
  const requiresSuspectTimer = empireSpace && !ownerIsLegalTarget;
  const safetyLevel = getSafetyLevel(normalizedThiefCharacterID);

  return {
    success: !requiresSuspectTimer || safetyLevel <= SAFETY_LEVEL_PARTIAL,
    errorMsg:
      requiresSuspectTimer && safetyLevel > SAFETY_LEVEL_PARTIAL
        ? "SafetyActivated"
        : null,
    data: {
      empireSpace,
      ownerIsLegalTarget,
      requiresSuspectTimer,
      safetyLevel,
      thiefCharacterID: normalizedThiefCharacterID,
      containerOwnerCharacterID: normalizedOwnerCharacterID,
      protectedPropertyCorporationID,
    },
  };
}

function recordContainerTheft(
  scene,
  session,
  containerOwnerCharacterID,
  now = Date.now(),
  options = {},
) {
  const thiefCharacterID = resolveSessionCharacterID(session);
  const evaluation = evaluateContainerTheft(
    scene,
    thiefCharacterID,
    containerOwnerCharacterID,
    now,
    options,
  );
  if (!evaluation.success) {
    return evaluation;
  }
  if (!evaluation.data.requiresSuspectTimer) {
    return {
      success: true,
      data: {
        ...evaluation.data,
        applied: false,
        reason: evaluation.data.empireSpace
          ? "LEGAL_TARGET"
          : "NOT_EMPIRE_SPACE",
      },
    };
  }

  // The aggregate flag can still reflect an expired durable contribution when
  // this is the first mutation since its deadline. Prune before preparing the
  // receipt so an expired criminal base cannot mask the new suspect timer in
  // either memory or the row persisted below.
  const pruneResult = pruneCharacterState(thiefCharacterID, now);
  if (!pruneResult || pruneResult.success !== true) {
    return {
      success: false,
      errorMsg: "CRIMEWATCH_STATE_PERSIST_FAILED",
      data: {
        ...evaluation.data,
        persistenceError:
          pruneResult && pruneResult.errorMsg
            ? pruneResult.errorMsg
            : "WRITE_ERROR",
      },
    };
  }

  const state = ensureCharacterState(thiefCharacterID);
  if (!state) {
    return {
      success: false,
      errorMsg: "CHARACTER_NOT_FOUND",
    };
  }
  if (
    state.criminal === true &&
    toFiniteNumber(state.criminalTimerExpiresAtMs, 0) > now
  ) {
    return {
      success: true,
      data: {
        ...evaluation.data,
        applied: false,
        reason: "ALREADY_CRIMINAL",
        criminalTimerExpiresAtMs: state.criminalTimerExpiresAtMs,
      },
    };
  }

  const receiptID = String(
    options && options.receiptID || crypto.randomUUID(),
  ).trim().slice(0, 160);
  if (!receiptID) {
    return {
      success: false,
      errorMsg: "INVALID_THEFT_RECEIPT",
    };
  }

  const previousState = cloneValue(state);
  state.containerTheftReceipts = normalizeContainerTheftReceipts(
    state.containerTheftReceipts,
  );
  const existingReceipt = state.containerTheftReceipts[receiptID] || null;
  if (existingReceipt) {
    return {
      success: true,
      data: {
        ...evaluation.data,
        applied: false,
        reason: "THEFT_RECEIPT_ALREADY_EXISTS",
        suspectTimerExpiresAtMs: state.criminalTimerExpiresAtMs,
        theftReceipt: cloneValue(existingReceipt),
      },
    };
  }

  const theftReceipt = {
    receiptID,
    characterID: thiefCharacterID,
    state: THEFT_RECEIPT_STATE_PREPARED,
    createdAtMs: Math.max(0, Math.trunc(toFiniteNumber(now, Date.now()))),
    expiresAtMs:
      Math.max(0, Math.trunc(toFiniteNumber(now, Date.now()))) +
      CRIMINAL_TIMER_DURATION_MS,
    containerOwnerCharacterID: toPositiveInt(
      evaluation.data.containerOwnerCharacterID,
      0,
    ),
    protectedPropertyCorporationID: toPositiveInt(
      evaluation.data.protectedPropertyCorporationID,
      0,
    ),
  };
  state.containerTheftReceipts[receiptID] = theftReceipt;
  recomputeCharacterPenaltyState(state);
  state.lastKnownSystemID = toPositiveInt(scene && scene.systemID, 0);

  const result = finalizeCharacterStateMutation(state, {
    success: true,
    data: {
      ...evaluation.data,
      applied: true,
      reason: "CONTAINER_THEFT",
      suspectTimerExpiresAtMs: state.criminalTimerExpiresAtMs,
      theftReceipt: cloneValue(theftReceipt),
    },
  });
  if (!result.success) {
    rollbackRejectedCharacterStateMutation(state, previousState);
    return result;
  }

  synchronizeSessionTimerNotifications(scene, session, now);
  synchronizeSystemFlagNotifications(scene, now);

  return result;
}

function resolveContainerTheftReceipt(receipt) {
  const source = receipt && typeof receipt === "object" ? receipt : {};
  const receiptID = String(source.receiptID || "").trim().slice(0, 160);
  const characterID = toPositiveInt(
    source.characterID || source.thiefCharacterID,
    0,
  );
  return receiptID && characterID
    ? { receiptID, characterID }
    : null;
}

function resolveProtectedPlayerCorporationID(ownerID, candidateID) {
  const normalizedOwnerID = toPositiveInt(ownerID, 0);
  const corporationID = toPositiveInt(candidateID, 0);
  if (!corporationID || corporationID !== normalizedOwnerID) {
    return 0;
  }
  try {
    const corporationState = getCorporationStateService();
    if (
      !corporationState ||
      typeof corporationState.isNpcCorporationID !== "function" ||
      corporationState.isNpcCorporationID(corporationID)
    ) {
      return 0;
    }
    return corporationID;
  } catch (error) {
    // Marker recognition is distinct from permission authority. A server-
    // stamped, owner-matching non-NPC corporation marker must not collapse to
    // public debris merely because corporation state is unavailable; callers
    // will then fail closed on friendly-fire/war grants.
    return corporationID;
  }
}

function resolveEntityProtectedPropertyCorporationID(entity) {
  if (!entity) {
    return 0;
  }
  if (Number(entity.categoryID) === 23 && Number(entity.groupID) !== 411) {
    const item = require("../starbase/starbaseCombatRuntime").resolveSpaceItem(entity);
    return item ? resolveProtectedPlayerCorporationID(item.ownerID, item.ownerID) : 0;
  }
  if ([CATEGORY_ORBITAL, CATEGORY_STRUCTURE].includes(Number(entity.categoryID)) &&
      getEntityCharacterID(entity) === 0) {
    return resolveProtectedPlayerCorporationID(entity.ownerID, entity.ownerID);
  }
  return resolveProtectedPlayerCorporationID(
    entity.ownerID,
    entity.protectedPropertyCorporationID,
  );
}

function entityHasProtectedPropertyCorporationMarker(entity) {
  return Boolean(
    entity &&
    (
      (Number(entity.categoryID) === 23 && Number(entity.groupID) !== 411) ||
      entity.protectedPropertyCorporationMarkerPresent === true ||
      toPositiveInt(entity.protectedPropertyCorporationID, 0) > 0
    )
  );
}

function entityHasInvalidProtectedPropertyCorporationMarker(entity) {
  return Boolean(
    entityHasProtectedPropertyCorporationMarker(entity) &&
    resolveEntityProtectedPropertyCorporationID(entity) <= 0
  );
}

function isCharacterInCorporation(characterID, corporationID) {
  const record = resolveCharacterRecord(characterID);
  const normalizedCorporationID = toPositiveInt(corporationID, 0);
  if (
    !record ||
    normalizedCorporationID <= 0 ||
    toPositiveInt(record.corporationID, 0) !== normalizedCorporationID
  ) {
    return false;
  }
  try {
    const corporationState = getCorporationStateService();
    if (
      !corporationState ||
      typeof corporationState.getCorporationRecord !== "function" ||
      typeof corporationState.isNpcCorporationID !== "function" ||
      corporationState.isNpcCorporationID(normalizedCorporationID)
    ) {
      return false;
    }
    const corporation = corporationState.getCorporationRecord(
      normalizedCorporationID,
    );
    return Boolean(
      corporation && corporation.isNPC === false && !corporation.deleted,
    );
  } catch (error) {
    // ignored: an unreadable corporation record is not a player corporation (false)
    return false;
  }
}

function mutateContainerTheftReceipt(
  scene,
  session,
  receipt,
  action,
  now = Date.now(),
) {
  const resolvedReceipt = resolveContainerTheftReceipt(receipt);
  const sessionCharacterID = resolveSessionCharacterID(session);
  if (
    !resolvedReceipt ||
    !sessionCharacterID ||
    resolvedReceipt.characterID !== sessionCharacterID
  ) {
    return {
      success: false,
      errorMsg: "INVALID_THEFT_RECEIPT",
    };
  }

  const state = ensureCharacterState(resolvedReceipt.characterID);
  if (!state) {
    return { success: false, errorMsg: "CHARACTER_NOT_FOUND" };
  }
  state.containerTheftReceipts = normalizeContainerTheftReceipts(
    state.containerTheftReceipts,
  );
  const storedReceipt =
    state.containerTheftReceipts[resolvedReceipt.receiptID] || null;
  if (!storedReceipt) {
    return {
      success: false,
      errorMsg: "THEFT_RECEIPT_NOT_FOUND",
    };
  }

  if (action === "commit") {
    if (storedReceipt.state === THEFT_RECEIPT_STATE_COMMITTED) {
      return {
        success: true,
        data: {
          applied: false,
          reason: "THEFT_RECEIPT_ALREADY_COMMITTED",
          theftReceipt: cloneValue(storedReceipt),
        },
      };
    }
  } else if (action === "compensate") {
    if (storedReceipt.state === THEFT_RECEIPT_STATE_COMMITTED) {
      return {
        success: false,
        errorMsg: "THEFT_RECEIPT_ALREADY_COMMITTED",
      };
    }
  } else {
    return { success: false, errorMsg: "INVALID_THEFT_RECEIPT_ACTION" };
  }

  const previousState = cloneValue(state);
  if (action === "commit") {
    state.containerTheftReceipts[resolvedReceipt.receiptID] = {
      ...storedReceipt,
      state: THEFT_RECEIPT_STATE_COMMITTED,
    };
  } else {
    delete state.containerTheftReceipts[resolvedReceipt.receiptID];
  }
  recomputeCharacterPenaltyState(state);

  const persistenceResult = finalizeCharacterStateMutation(state, {
    success: true,
    data: {
      applied: true,
      reason:
        action === "commit"
          ? "THEFT_RECEIPT_COMMITTED"
          : "THEFT_RECEIPT_COMPENSATED",
      theftReceipt: cloneValue(storedReceipt),
      suspectTimerExpiresAtMs: state.criminalTimerExpiresAtMs,
    },
  });
  if (!persistenceResult.success) {
    // Commit failure leaves the prepared contribution authoritative; failed
    // compensation does the same. Both outcomes fail closed without erasing
    // the timer after custody may already have crossed its commit boundary.
    rollbackRejectedCharacterStateMutation(state, previousState);
    return persistenceResult;
  }

  synchronizeSessionTimerNotifications(scene, session, now);
  synchronizeSystemFlagNotifications(scene, now);
  if (action === "compensate") {
    // The compensation itself is already durably acknowledged above. Removing
    // an otherwise-default row is only storage cleanup; a cleanup failure must
    // not turn a completed compensation into a non-retryable false failure.
    pruneCharacterState(
      resolvedReceipt.characterID,
      now,
    );
  }
  return persistenceResult;
}

function commitContainerTheft(
  scene,
  session,
  receipt,
  now = Date.now(),
) {
  return mutateContainerTheftReceipt(
    scene,
    session,
    receipt,
    "commit",
    now,
  );
}

function compensateContainerTheft(
  scene,
  session,
  receipt,
  now = Date.now(),
) {
  return mutateContainerTheftReceipt(
    scene,
    session,
    receipt,
    "compensate",
    now,
  );
}

function buildFiletimeFromExpiryMs(expiresAtMs) {
  return buildFiletimeLong(BigInt(Math.trunc(expiresAtMs)) * 10000n + 116444736000000000n);
}

function buildSecurityStatusPenaltyResult({
  applied = false,
  reason = "NOT_APPLIED",
  characterID = 0,
  systemSecurity = 0,
  targetKind = "ship",
  previousSecurityStatus = 0,
  nextSecurityStatus = previousSecurityStatus,
  targetSecurityStatus = 0,
  modification = 0,
} = {}) {
  return {
    applied,
    reason,
    characterID: toPositiveInt(characterID, 0),
    targetKind,
    systemSecurity: roundNumber(toFiniteNumber(systemSecurity, 0), 6),
    previousSecurityStatus: clampSecurityStatus(previousSecurityStatus),
    nextSecurityStatus: clampSecurityStatus(nextSecurityStatus),
    deltaSecurityStatus: roundSecurityStatus(
      clampSecurityStatus(nextSecurityStatus) -
        clampSecurityStatus(previousSecurityStatus),
    ),
    targetSecurityStatus: clampSecurityStatus(targetSecurityStatus),
    modificationPercent: roundNumber(toFiniteNumber(modification, 0) * 100, 6),
  };
}

function buildSecurityStatusAttributeChange(characterID, itemID, nextValue, previousValue, whenMs) {
  // TQ parity: singular inner tuple tag + trailing time.
  const when = buildFiletimeFromExpiryMs(whenMs);
  return [
    "OnModuleAttributeChange",
    toPositiveInt(characterID, 0),
    toPositiveInt(itemID, 0),
    ATTRIBUTE_PILOT_SECURITY_STATUS,
    when,
    clampSecurityStatus(nextValue),
    clampSecurityStatus(previousValue),
    when,
  ];
}

function notifySecurityStatusAttributeChange(
  session,
  characterID,
  itemID,
  nextValue,
  previousValue,
  whenMs,
) {
  if (
    !session ||
    typeof session.sendNotification !== "function" ||
    toPositiveInt(itemID, 0) <= 0 ||
    Number(clampSecurityStatus(nextValue)) ===
      Number(clampSecurityStatus(previousValue))
  ) {
    return false;
  }

  queueDogmaEvent(session, "OnModuleAttributeChanges", [{
    type: "list",
    items: [
      buildSecurityStatusAttributeChange(
        characterID,
        itemID,
        nextValue,
        previousValue,
        whenMs,
      ),
    ],
  }]);
  return true;
}

function notifyOwnSecurityStatusUpdate(session, nextValue, previousValue) {
  if (
    !session ||
    typeof session.sendNotification !== "function" ||
    Number(clampSecurityStatus(nextValue)) ===
      Number(clampSecurityStatus(previousValue))
  ) {
    return false;
  }

  session.sendNotification("OnSecurityStatusUpdate", "charid", [
    clampSecurityStatus(nextValue),
  ]);
  return true;
}

function synchronizeLiveSecurityStatus(
  scene,
  entity,
  previousSecurityStatus,
  nextSecurityStatus,
  now = Date.now(),
) {
  entity = resolveManualStarbasePilotShip(scene, entity);
  if (
    !scene ||
    !entity ||
    Number(clampSecurityStatus(previousSecurityStatus)) ===
      Number(clampSecurityStatus(nextSecurityStatus))
  ) {
    return {
      slimRecipients: 0,
      attributeNotified: false,
      selfStatusNotified: false,
    };
  }

  entity.securityStatus = clampSecurityStatus(nextSecurityStatus);
  let slimRecipients = 0;

  for (const session of getSceneSessions(scene)) {
    if (
      session !== entity.session &&
      typeof scene.canSessionSeeDynamicEntity === "function" &&
      !scene.canSessionSeeDynamicEntity(session, entity)
    ) {
      continue;
    }
    if (typeof scene.sendSlimItemChangesToSession === "function") {
      scene.sendSlimItemChangesToSession(session, [entity]);
      slimRecipients += 1;
    }
  }

  const characterID = getEntityCharacterID(entity);
  const attributeNotified = notifySecurityStatusAttributeChange(
    entity.session,
    characterID,
    entity.itemID,
    nextSecurityStatus,
    previousSecurityStatus,
    Math.max(0, Math.trunc(toFiniteNumber(now, Date.now()))),
  );
  const selfStatusNotified = notifyOwnSecurityStatusUpdate(
    entity.session,
    nextSecurityStatus,
    previousSecurityStatus,
  );

  return {
    slimRecipients,
    attributeNotified,
    selfStatusNotified,
  };
}

function persistSecurityStatusDrop(scene, characterID, receipt) {
  // Real scenes have an authoritative inventory index. No local tower means
  // no sentry can consume this short-lived evidence. Keep the existing path
  // for callers without a complete scene, and for towers whose policy may change.
  if (scene.dynamicEntities instanceof Map) {
    try {
      if (!require("../inventory/itemStore").hasStarbaseItems({
        systemID: receipt.systemID, groupID: 365,
      })) return;
    } catch (error) {
      log.warn(`[Crimewatch] POS presence lookup failed for system=${receipt.systemID}: ${error.message}`);
    }
  }
  const state = ensureCharacterState(characterID);
  const previousDrop = state.securityStatusDrop;
  state.securityStatusDrop = receipt;
  try {
    const result = persistCharacterState(state);
    if (result && result.success) return;
  } catch (_) {
    // ignored: optional POS evidence must not interrupt security or kill-right effects.
  }
  if (previousDrop) state.securityStatusDrop = previousDrop;
  else delete state.securityStatusDrop;
  try {
    // Restage the acknowledged state if a rejected write dirtied the cache.
    persistCharacterState(state);
  } catch (_) {
    // ignored: the acknowledged in-memory value is already restored.
  }
  log.warn(`[Crimewatch] Security-drop receipt persistence failed for character=${characterID}`);
}

function applySecurityStatusPenaltyForAggression(
  scene,
  attackerEntity,
  targetEntity,
  now = Date.now(),
) {
  if (!scene || !attackerEntity || !targetEntity) {
    return {
      success: false,
      errorMsg: "ENTITY_NOT_FOUND",
    };
  }

  if (
    getEntityActorKind(attackerEntity) !== "player" ||
    (getEntityActorKind(targetEntity) !== "player" && !isNpcAuthorityStructure(targetEntity))
  ) {
    return {
      success: true,
      data: buildSecurityStatusPenaltyResult({
        applied: false,
        reason: "NON_PLAYER_COMBAT",
      }),
    };
  }

  const attackerCharacterID = getEntityCharacterID(attackerEntity);
  const targetCharacterID = getEntityCharacterID(targetEntity);
  if (
    !attackerCharacterID ||
    (!targetCharacterID && !isNpcAuthorityStructure(targetEntity)) ||
    attackerCharacterID === targetCharacterID
  ) {
    return {
      success: true,
      data: buildSecurityStatusPenaltyResult({
        applied: false,
        reason: "FRIENDLY_OR_SELF",
        characterID: attackerCharacterID,
      }),
    };
  }

  const systemSecurity = getSolarSystemPseudoSecurity(scene.system);
  if (systemSecurity <= 0) {
    return {
      success: true,
      data: buildSecurityStatusPenaltyResult({
        applied: false,
        reason: "NOT_EMPIRE_SPACE",
        characterID: attackerCharacterID,
      }),
    };
  }

  const attackerRecord = resolveCharacterRecord(attackerCharacterID) || null;
  if (!attackerRecord) {
    return {
      success: true,
      data: buildSecurityStatusPenaltyResult({
        applied: false,
        reason: "CHARACTER_RECORD_NOT_FOUND",
        characterID: attackerCharacterID,
      }),
    };
  }

  const targetKind = isNpcAuthorityStructure(targetEntity)
    ? (Number(targetEntity.groupID ?? targetEntity.slimGroupID) === GROUP_STATION ? "station" : "stargate")
    : isCapsuleEntity(targetEntity) ? "capsule" : "ship";
  const targetKey = getSecurityPenaltyTargetKey(targetEntity);
  const previousSecurityStatus = getCharacterSecurityStatus(attackerCharacterID, 0);
  const targetSecurityStatus = getEntitySecurityStatus(targetEntity, 0);
  if (targetKey && hasRecentSecurityPenaltyTarget(attackerCharacterID, targetKey, now)) {
    return {
      success: true,
      data: buildSecurityStatusPenaltyResult({
        applied: false,
        reason: "DUPLICATE_TARGET",
        characterID: attackerCharacterID,
        previousSecurityStatus,
        nextSecurityStatus: previousSecurityStatus,
        targetSecurityStatus,
        systemSecurity,
        targetKind,
      }),
    };
  }

  const modificationBase = targetKind === "capsule"
    ? SECURITY_STATUS_CAPSULE_AGGRESSION_MODIFIER
    : SECURITY_STATUS_SHIP_AGGRESSION_MODIFIER;
  const modification =
    modificationBase *
    systemSecurity *
    (1 + ((targetSecurityStatus - previousSecurityStatus) / 100));
  const nextSecurityStatus = clampSecurityStatus(
    // Retail penalties are a fraction of the remaining distance to -10.
    // CONCORD.zip's consecutive negative statuses distinguish this from 10-s.
    previousSecurityStatus + ((10 + previousSecurityStatus) * modification),
  );

  if (Number(nextSecurityStatus) === Number(previousSecurityStatus)) {
    // Nothing is written at the floor, so there is nothing to retry. Open the
    // duplicate window here too, so repeat shots at this target stay cheap.
    if (targetKey) {
      rememberRecentSecurityPenaltyTarget(
        attackerCharacterID,
        targetKey,
        now + SECURITY_STATUS_DUPLICATE_WINDOW_MS,
      );
    }
    return {
      success: true,
      data: buildSecurityStatusPenaltyResult({
        applied: false,
        reason: "SECURITY_STATUS_FLOOR_REACHED",
        characterID: attackerCharacterID,
        systemSecurity,
        targetKind,
        previousSecurityStatus,
        nextSecurityStatus,
        targetSecurityStatus,
        modification,
      }),
    };
  }

  const updateResult = updateCharacterStateRecord(attackerCharacterID, (record) => ({
    ...record,
    securityStatus: nextSecurityStatus,
    securityRating: nextSecurityStatus,
  }));
  if (!updateResult.success) {
    return {
      success: false,
      errorMsg: updateResult.errorMsg || "WRITE_ERROR",
    };
  }

  // A failed security write must remain retryable. Once it succeeds, optional
  // receipt failures must not let a retry apply the same penalty again.
  if (targetKey) {
    rememberRecentSecurityPenaltyTarget(
      attackerCharacterID,
      targetKey,
      now + SECURITY_STATUS_DUPLICATE_WINDOW_MS,
    );
  }

  const syncResult = synchronizeLiveSecurityStatus(
    scene,
    attackerEntity,
    previousSecurityStatus,
    nextSecurityStatus,
    now,
  );

  // POS statusDrop policy consumes an actual security penalty, never a generic
  // suspect/criminal timer. Keep the receipt for the existing weapon interval.
  persistSecurityStatusDrop(scene, attackerCharacterID, {
    atMs: now, expiresAtMs: now + WEAPON_TIMER_DURATION_MS,
    systemID: toPositiveInt(scene && scene.systemID, 0), targetKey,
    previousSecurityStatus, nextSecurityStatus,
  });

  return {
    success: true,
    data: {
      ...buildSecurityStatusPenaltyResult({
        applied: true,
        reason: "APPLIED",
        characterID: attackerCharacterID,
        systemSecurity,
        targetKind,
        previousSecurityStatus,
        nextSecurityStatus,
        targetSecurityStatus,
        modification,
      }),
      slimRecipients: toPositiveInt(syncResult && syncResult.slimRecipients, 0),
      attributeNotified: Boolean(syncResult && syncResult.attributeNotified),
      selfStatusNotified: Boolean(syncResult && syncResult.selfStatusNotified),
    },
  };
}

function hasActiveModuleCombatTimer(characterID, kind) {
  const activities = characterCombatActivities.get(characterID);
  return Boolean(activities && [...activities].some((activity) =>
    activity.endedAtMs === null && activity.participants.get(characterID).kinds.has(kind)));
}

function buildTimerTuple(stateCode, expiresAtMs, now = Date.now(), active = false) {
  if (active) {
    return [stateCode + 1, null];
  }
  const normalizedExpiry = Math.max(0, Math.trunc(toFiniteNumber(expiresAtMs, 0)));
  if (normalizedExpiry <= now) {
    return [stateCode, null];
  }

  return [
    stateCode + 2,
    buildFiletimeFromExpiryMs(normalizedExpiry),
  ];
}

function buildWeaponTimerTuple(state, now = Date.now()) {
  return buildTimerTuple(
    WEAPONS_TIMER_STATE_IDLE,
    state && state.weaponTimerExpiresAtMs,
    now,
    hasActiveModuleCombatTimer(state && state.characterID, "weapons"),
  );
}

function buildPvpTimerTuple(state, now = Date.now()) {
  return buildTimerTuple(
    PVP_TIMER_STATE_IDLE,
    state && state.pvpTimerExpiresAtMs,
    now,
    hasActiveModuleCombatTimer(state && state.characterID, "pvp"),
  );
}

function buildNpcTimerTuple(state, now = Date.now()) {
  return buildTimerTuple(
    NPC_TIMER_STATE_IDLE,
    state && state.npcTimerExpiresAtMs,
    now,
    hasActiveModuleCombatTimer(state && state.characterID, "npc"),
  );
}

function buildCriminalTimerTuple(state, now = Date.now()) {
  const normalizedState = state || buildDefaultCharacterState(0);
  const normalizedExpiry = Math.max(
    0,
    Math.trunc(toFiniteNumber(normalizedState.criminalTimerExpiresAtMs, 0)),
  );
  if (normalizedState.criminal &&
      hasActiveModuleCombatTimer(normalizedState.characterID, "criminal")) {
    return [CRIMINAL_TIMER_STATE_ACTIVE_CRIMINAL, null];
  }
  if (normalizedState.suspect &&
      hasActiveModuleCombatTimer(normalizedState.characterID, "suspect")) {
    return [CRIMINAL_TIMER_STATE_ACTIVE_SUSPECT, null];
  }
  if (
    normalizedExpiry <= now ||
    (!normalizedState.criminal && !normalizedState.suspect)
  ) {
    return [CRIMINAL_TIMER_STATE_IDLE, null];
  }

  return [
    normalizedState.criminal
      ? CRIMINAL_TIMER_STATE_TIMER_CRIMINAL
      : CRIMINAL_TIMER_STATE_TIMER_SUSPECT,
    buildFiletimeFromExpiryMs(normalizedExpiry),
  ];
}

function buildDisapprovalTimerTuple(state, now = Date.now()) {
  return buildTimerTuple(
    DISAPPROVAL_TIMER_STATE_IDLE,
    state && state.disapprovalTimerExpiresAtMs,
    now,
  );
}

function buildCombatTimerTuplesFromState(state, now = Date.now()) {
  return [
    buildWeaponTimerTuple(state, now),
    buildPvpTimerTuple(state, now),
    buildNpcTimerTuple(state, now),
    buildCriminalTimerTuple(state, now),
    buildDisapprovalTimerTuple(state, now),
  ];
}

function buildFlaggedCharacterSnapshot(systemID, now = Date.now()) {
  hydrateAllStoredCharacterStates();
  const normalizedSystemID = toPositiveInt(systemID, 0);
  const criminals = [];
  const suspects = [];

  for (const state of characterCrimewatchState.values()) {
    if (
      normalizedSystemID > 0 &&
      toPositiveInt(state.lastKnownSystemID, 0) !== normalizedSystemID
    ) {
      continue;
    }
    if (
      state.criminal === true &&
      toFiniteNumber(state.criminalTimerExpiresAtMs, 0) > now
    ) {
      criminals.push(state.characterID);
    } else if (
      state.suspect === true &&
      toFiniteNumber(state.criminalTimerExpiresAtMs, 0) > now
    ) {
      suspects.push(state.characterID);
    }
  }

  criminals.sort((left, right) => left - right);
  suspects.sort((left, right) => left - right);
  return { criminals, suspects };
}

function buildDisapprovalSnapshot(systemID, now = Date.now()) {
  hydrateAllStoredCharacterStates();
  const normalizedSystemID = toPositiveInt(systemID, 0);
  const disapproved = [];

  for (const state of characterCrimewatchState.values()) {
    if (
      normalizedSystemID > 0 &&
      toPositiveInt(state.lastKnownSystemID, 0) !== normalizedSystemID
    ) {
      continue;
    }
    if (toFiniteNumber(state.disapprovalTimerExpiresAtMs, 0) > now) {
      disapproved.push(state.characterID);
    }
  }

  disapproved.sort((left, right) => left - right);
  return { disapproved };
}

function buildFlaggedCharactersForSession(session, now = Date.now()) {
  const snapshot = buildFlaggedCharacterSnapshot(
    resolveSessionSystemID(session),
    now,
  );
  return [
    buildPythonSet(snapshot.criminals),
    buildPythonSet(snapshot.suspects),
  ];
}

function buildClientStatesForSession(session, now = Date.now()) {
  const characterID = resolveSessionCharacterID(session);
  const state = getCharacterCrimewatchState(characterID, now) ||
    buildDefaultCharacterState(characterID);
  const engagementEntries = listLimitedEngagementsForCharacter(
    characterID,
    now,
  ).map((engagement) => [
    getLimitedEngagementOtherCharacterID(engagement, characterID),
    ongoingLimitedEngagementKeys.has(buildLimitedEngagementKey(
      engagement.firstCharacterID,
      engagement.secondCharacterID,
    ))
      ? LIMITED_ENGAGEMENT_TIMEOUT_ONGOING
      : buildFiletimeFromExpiryMs(engagement.expiresAtMs),
  ]);

  return [
    buildCombatTimerTuplesFromState(state, now),
    buildDict(engagementEntries),
    buildFlaggedCharactersForSession(session, now),
    normalizeSafetyLevel(state.safetyLevel),
  ];
}

function buildComparableTupleKey(tuple) {
  if (!Array.isArray(tuple)) {
    return "invalid";
  }

  const stateCode = Number(tuple[0]) || 0;
  const expiryValue =
    tuple[1] &&
    typeof tuple[1] === "object" &&
    Object.prototype.hasOwnProperty.call(tuple[1], "value")
      ? String(tuple[1].value)
      : "";
  return `${stateCode}:${expiryValue}`;
}

function arraysEqual(left, right) {
  if (left === right) {
    return true;
  }
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function getSceneSessions(scene) {
  if (!(scene && scene.sessions instanceof Map)) {
    return [];
  }
  const sessions = [];
  for (const session of scene.sessions.values()) {
    if (session && typeof session.sendNotification === "function") {
      sessions.push(session);
    }
  }
  return sessions;
}

function buildKillRightCreatedPayload(record) {
  return [
    toPositiveInt(record && record.killRightID, 0),
    toPositiveInt(record && record.fromID, 0),
    toPositiveInt(record && record.toID, 0),
    buildFiletimeLong(record && record.expiryTime),
  ];
}

function notifyKillRightCreated(scene, attackerEntity, targetEntity, record) {
  if (!record) {
    return 0;
  }

  const affectedCharacters = new Set([
    toPositiveInt(record.fromID, 0),
    toPositiveInt(record.toID, 0),
  ].filter((characterID) => characterID > 0));
  if (affectedCharacters.size === 0) {
    return 0;
  }

  const sessions = new Set(getSceneSessions(scene));
  if (
    attackerEntity &&
    attackerEntity.session &&
    typeof attackerEntity.session.sendNotification === "function"
  ) {
    sessions.add(attackerEntity.session);
  }
  if (
    targetEntity &&
    targetEntity.session &&
    typeof targetEntity.session.sendNotification === "function"
  ) {
    sessions.add(targetEntity.session);
  }
  // A podded victim may already be in another scene; the kill-rights panel of
  // both characters must still update.
  for (const characterID of affectedCharacters) {
    const session = sessionRegistry.findSessionByCharacterID(characterID);
    if (session && typeof session.sendNotification === "function") {
      sessions.add(session);
    }
  }

  let notificationCount = 0;
  const payload = buildKillRightCreatedPayload(record);
  for (const session of sessions) {
    const characterID = resolveSessionCharacterID(session);
    if (!affectedCharacters.has(characterID)) {
      continue;
    }
    // Retail: idtype charid in every capture.
    session.sendNotification("OnKillRightCreated", "charid", payload);
    notificationCount += 1;
  }

  return notificationCount;
}

function createKillRightForCriminalAggression(scene, attackerEntity, targetEntity, now) {
  attackerEntity = resolveManualStarbaseAggressor(attackerEntity);
  if (
    !targetEntity ||
    getEntityActorKind(attackerEntity) !== "player" ||
    getEntityActorKind(targetEntity) !== "player"
  ) {
    return {
      created: false,
      reason: "NO_PLAYER_VICTIM",
    };
  }

  const attackerCharacterID = getEntityCharacterID(attackerEntity);
  const targetCharacterID = getEntityCharacterID(targetEntity);
  if (
    !attackerCharacterID ||
    !targetCharacterID ||
    attackerCharacterID === targetCharacterID
  ) {
    return {
      created: false,
      reason: "FRIENDLY_OR_SELF",
    };
  }

  const killRightState = getKillRightStateService();
  if (
    !killRightState ||
    typeof killRightState.createKillRightForCriminalAggression !== "function"
  ) {
    return {
      created: false,
      reason: "KILL_RIGHT_STATE_UNAVAILABLE",
    };
  }

  const createResult = killRightState.createKillRightForCriminalAggression({
    fromID: targetCharacterID,
    toID: attackerCharacterID,
    nowMs: now,
  });
  if (!createResult || !createResult.success || !createResult.data) {
    return {
      created: false,
      reason: createResult && createResult.errorMsg
        ? createResult.errorMsg
        : "KILL_RIGHT_CREATE_FAILED",
    };
  }

  const notificationCount = createResult.created === true
    ? notifyKillRightCreated(scene, attackerEntity, targetEntity, createResult.data)
    : 0;

  if (createResult.created === true) {
    // KillRightEarned (117): persist the center row telling the victim
    // (fromID) they earned a kill right against the aggressor (toID).
    getKillRightNotificationsService().notifyKillRightEarned({
      ownerID: createResult.data.fromID,
      targetID: createResult.data.toID,
    });
  }

  return {
    created: createResult.created === true,
    killRightID: toPositiveInt(createResult.data.killRightID, 0),
    fromID: toPositiveInt(createResult.data.fromID, 0),
    toID: toPositiveInt(createResult.data.toID, 0),
    expiryTime: String(createResult.data.expiryTime || ""),
    notificationCount,
  };
}

function buildTimerBroadcastSnapshot(characterID, now = Date.now()) {
  const state = getCharacterCrimewatchState(characterID, now) ||
    buildDefaultCharacterState(characterID);
  return {
    weapons: buildWeaponTimerTuple(state, now),
    pvp: buildPvpTimerTuple(state, now),
    npc: buildNpcTimerTuple(state, now),
    criminal: buildCriminalTimerTuple(state, now),
    disapproval: buildDisapprovalTimerTuple(state, now),
  };
}

function sendTimerNotificationIfChanged(
  session,
  notificationName,
  previousTuple,
  nextTuple,
) {
  if (buildComparableTupleKey(previousTuple) === buildComparableTupleKey(nextTuple)) {
    return;
  }

  session.sendNotification(notificationName, "charid", [
    nextTuple[0],
    nextTuple[1],
  ]);
}

function synchronizeSessionTimerNotifications(scene, session, now = Date.now()) {
  if (!session) {
    return;
  }

  const characterID = resolveSessionCharacterID(session);
  if (!characterID) {
    return;
  }

  const snapshot = buildTimerBroadcastSnapshot(characterID, now);
  const previous = lastBroadcastTimerSnapshots.get(characterID) || {
    weapons: [WEAPONS_TIMER_STATE_IDLE, null],
    pvp: [PVP_TIMER_STATE_IDLE, null],
    npc: [NPC_TIMER_STATE_IDLE, null],
    criminal: [CRIMINAL_TIMER_STATE_IDLE, null],
    disapproval: [DISAPPROVAL_TIMER_STATE_IDLE, null],
  };

  sendTimerNotificationIfChanged(
    session,
    "OnWeaponsTimerUpdate",
    previous.weapons,
    snapshot.weapons,
  );
  sendTimerNotificationIfChanged(
    session,
    "OnPvpTimerUpdate",
    previous.pvp,
    snapshot.pvp,
  );
  sendTimerNotificationIfChanged(
    session,
    "OnNpcTimerUpdate",
    previous.npc,
    snapshot.npc,
  );
  sendTimerNotificationIfChanged(
    session,
    "OnCriminalTimerUpdate",
    previous.criminal,
    snapshot.criminal,
  );
  sendTimerNotificationIfChanged(
    session,
    "OnDisapprovalTimerUpdate",
    previous.disapproval,
    snapshot.disapproval,
  );

  // A fully idle snapshot needs no baseline: an absent entry diffs as idle.
  // Dropping it here is also what lets pruneCharacterState remove a character
  // without leaking one snapshot per character that ever carried a timer.
  if (
    snapshot.weapons[0] === WEAPONS_TIMER_STATE_IDLE &&
    snapshot.pvp[0] === PVP_TIMER_STATE_IDLE &&
    snapshot.npc[0] === NPC_TIMER_STATE_IDLE &&
    snapshot.criminal[0] === CRIMINAL_TIMER_STATE_IDLE &&
    snapshot.disapproval[0] === DISAPPROVAL_TIMER_STATE_IDLE
  ) {
    lastBroadcastTimerSnapshots.delete(characterID);
  } else {
    lastBroadcastTimerSnapshots.set(characterID, snapshot);
  }
}

function diffArray(previousItems, nextItems) {
  const previousSet = new Set(Array.isArray(previousItems) ? previousItems : []);
  const nextSet = new Set(Array.isArray(nextItems) ? nextItems : []);
  return {
    removed: [...previousSet]
      .filter((item) => !nextSet.has(item))
      .sort((left, right) => left - right),
    added: [...nextSet]
      .filter((item) => !previousSet.has(item))
      .sort((left, right) => left - right),
  };
}

// What OnSystemCriminalFlagUpdates carries: those no longer flagged, the new
// suspects and the new criminals, each a Python set, as Tranquility's are:
//
//   OnSystemCriminalFlagUpdates ,*args= (set([]), set([2123487805]), set([]))
//
// (A plain array is marshalled as a tuple.)
function buildSystemCriminalFlagUpdatePayload(newIdles, newSuspects, newCriminals) {
  return [
    buildPythonSet(newIdles),
    buildPythonSet(newSuspects),
    buildPythonSet(newCriminals),
  ];
}

function synchronizeSystemFlagNotifications(scene, now = Date.now()) {
  if (!scene) {
    return;
  }

  const systemID = toPositiveInt(scene.systemID, 0);
  const snapshot = buildFlaggedCharacterSnapshot(systemID, now);
  const previous = lastBroadcastFlagSnapshots.get(systemID) || {
    criminals: [],
    suspects: [],
  };
  const criminalDiff = diffArray(previous.criminals, snapshot.criminals);
  const suspectDiff = diffArray(previous.suspects, snapshot.suspects);
  const newIdles = [...new Set([
    ...criminalDiff.removed,
    ...suspectDiff.removed,
  ])].sort((left, right) => left - right);

  if (
    newIdles.length > 0 ||
    suspectDiff.added.length > 0 ||
    criminalDiff.added.length > 0
  ) {
    for (const session of getSceneSessions(scene)) {
      session.sendNotification(
        "OnSystemCriminalFlagUpdates",
        "solarsystemid2",
        buildSystemCriminalFlagUpdatePayload(
          newIdles,
          suspectDiff.added,
          criminalDiff.added,
        ),
      );
    }
  }

  lastBroadcastFlagSnapshots.set(systemID, snapshot);
}

function synchronizeSystemDisapprovalNotifications(scene, now = Date.now()) {
  if (!scene) {
    return;
  }

  const systemID = toPositiveInt(scene.systemID, 0);
  const snapshot = buildDisapprovalSnapshot(systemID, now);
  const previous = lastBroadcastDisapprovalSnapshots.get(systemID) || {
    disapproved: [],
  };
  const diff = diffArray(previous.disapproved, snapshot.disapproved);
  if (diff.removed.length > 0 || diff.added.length > 0) {
    for (const session of getSceneSessions(scene)) {
      session.sendNotification("OnSystemDisapprovalFlagUpdates", "clientID", [
        diff.removed,
        diff.added,
      ]);
    }
  }

  lastBroadcastDisapprovalSnapshots.set(systemID, snapshot);
}

// Timers keep running while a pilot is docked, and the client only learns that
// one ended from its On*TimerUpdate (crimewatchSvc keeps the last state it was
// sent until then). A pilot who docked with a live criminal timer otherwise
// stayed "criminal" in the client forever: UndockCriminalConfirm on every
// undock long after the timer ended (real client, Perimeter, 2026-11-07).
function synchronizeUnplacedSessionTimerNotifications(now = Date.now()) {
  for (const characterID of [...lastBroadcastTimerSnapshots.keys()]) {
    const session = sessionRegistry.findSessionByCharacterID(characterID);
    if (session && !session._space && typeof session.sendNotification === "function") {
      synchronizeSessionTimerNotifications(null, session, now);
    }
  }
}

function synchronizeSceneClientState(scene, now = Date.now()) {
  if (!scene) {
    return;
  }

  for (const session of getSceneSessions(scene)) {
    synchronizeSessionTimerNotifications(scene, session, now);
  }
  synchronizeUnplacedSessionTimerNotifications(now);
  synchronizeSystemFlagNotifications(scene, now);
  synchronizeSystemDisapprovalNotifications(scene, now);
}

function ensureConcordResponseRecord(scene, attackerEntity, targetEntity, now) {
  const responseMap = ensureSystemResponseMap(scene && scene.systemID);
  if (!responseMap) {
    return null;
  }

  const offenderEntityID = toPositiveInt(attackerEntity && attackerEntity.itemID, 0);
  if (!offenderEntityID) {
    return null;
  }

  if (!responseMap.has(offenderEntityID)) {
    responseMap.set(offenderEntityID, {
      systemID: toPositiveInt(scene && scene.systemID, 0),
      offenderEntityID,
      offenderCharacterID: getEntityCharacterID(attackerEntity),
      victimEntityID: toPositiveInt(
        (targetEntity && targetEntity.itemID) ||
          (attackerEntity && attackerEntity.itemID),
        0,
      ),
      dueAtMs: now + getConcordResponseDispatchDelayMsForSystem(scene && scene.system),
      lastOffenseAtMs: now,
      respondedAtMs: 0,
      responderEntityIDs: [],
      ingressCompleteAtMs: 0,
      nextRetaskAtMs: 0,
      completionClearAtMs: 0,
      capsuleTargeted: false,
    });
  }

  const response = responseMap.get(offenderEntityID);
  response.systemID = toPositiveInt(scene && scene.systemID, response.systemID);
  response.offenderCharacterID = getEntityCharacterID(attackerEntity);
  response.victimEntityID = toPositiveInt(
    (targetEntity && targetEntity.itemID) ||
      (attackerEntity && attackerEntity.itemID),
    response.victimEntityID,
  );
  response.lastOffenseAtMs = now;
  response.completionClearAtMs = Math.max(
    0,
    Math.trunc(toFiniteNumber(response.completionClearAtMs, 0)),
  );
  response.ingressCompleteAtMs = Math.max(
    0,
    Math.trunc(toFiniteNumber(response.ingressCompleteAtMs, 0)),
  );
  response.capsuleTargeted = response.capsuleTargeted === true;
  if (toFiniteNumber(response.respondedAtMs, 0) <= 0) {
    response.dueAtMs = Math.min(
      Math.max(now, toFiniteNumber(response.dueAtMs, now)),
      now + getConcordResponseDispatchDelayMsForSystem(scene && scene.system),
    );
  }
  return response;
}

function scheduleConcordResponse(scene, offenderEntity, now = Date.now(), targetEntity = null) {
  offenderEntity = resolveManualStarbasePilotShip(scene, resolveManualStarbaseAggressor(offenderEntity));
  if (
    !scene ||
    !offenderEntity ||
    !isHighSecuritySystem(scene.system) ||
    !isCrimewatchConcordResponseEnabled()
  ) {
    return null;
  }

  return ensureConcordResponseRecord(
    scene,
    offenderEntity,
    targetEntity || offenderEntity,
    now,
  );
}

function resolveLimitedEngagementLegalAggression(
  attackerCharacterID,
  targetCharacterID,
  now,
  targetEntity = null,
) {
  if (!attackerCharacterID || !targetCharacterID) {
    return null;
  }

  let reason = null;
  if (hasActiveLimitedEngagement(attackerCharacterID, targetCharacterID, now)) {
    reason = "LIMITED_ENGAGEMENT";
  } else if (isCharacterCriminal(targetCharacterID, now)) {
    reason = "TARGET_ALREADY_CRIMINAL";
  } else if (isCharacterSuspect(targetCharacterID, now)) {
    reason = "TARGET_ALREADY_SUSPECT";
  } else if (isPlayerEntityOutlaw(targetEntity)) {
    reason = "TARGET_OUTLAW";
  }
  if (!reason) {
    return null;
  }

  const engagementResult = createOrRefreshLimitedEngagement(
    attackerCharacterID,
    targetCharacterID,
    { now, reason },
  );
  const engagement = engagementResult && engagementResult.data
    ? engagementResult.data.engagement || null
    : null;
  return {
    reason,
    engagement,
    persistenceError:
      engagementResult && engagementResult.success !== true
        ? engagementResult.errorMsg || "LIMITED_ENGAGEMENT_PERSIST_FAILED"
        : null,
  };
}

/**
 * Pure safety/consequence decision for a targeted offensive action. Loot
 * access is deliberately absent: fleet/corporation permission to take from a
 * can or wreck is not permission to damage it.
 */
function evaluateOffensiveAggression(
  scene,
  attackerEntity,
  targetEntity,
  now = Date.now(),
) {
  attackerEntity = resolveManualStarbaseAggressor(attackerEntity);
  if (!scene || !attackerEntity || !targetEntity) {
    return {
      success: false,
      errorMsg: "ENTITY_NOT_FOUND",
    };
  }

  const normalizedNow = Math.max(
    0,
    Math.trunc(toFiniteNumber(now, Date.now())),
  );
  if (entityHasInvalidProtectedPropertyCorporationMarker(targetEntity)) {
    return {
      success: false,
      errorMsg: "PROPERTY_AUTHORITY_INVALID",
      data: {
        evaluatedAtMs: normalizedNow,
        attackerCharacterID: getEntityCharacterID(attackerEntity),
        attackerEntityID: toPositiveInt(attackerEntity.itemID, 0),
        targetCharacterID: getEntityCharacterID(targetEntity),
        targetProtectedPropertyCorporationID: 0,
        targetEntityID: toPositiveInt(targetEntity.itemID, 0),
        legal: false,
        reason: "INVALID_PROPERTY_AUTHORITY",
        consequence: "blocked",
      },
    };
  }
  const attackerCharacterID = getEntityCharacterID(attackerEntity);
  const targetCharacterID = getEntityCharacterID(targetEntity);
  const targetProtectedPropertyCorporationID =
    resolveEntityProtectedPropertyCorporationID(targetEntity);
  const targetIsPlayerProperty =
    targetCharacterID > 0 || targetProtectedPropertyCorporationID > 0;
  const targetIsPersonalDeployable = isPersonalDeployableEntity(targetEntity);
  const targetIsOutlaw =
    targetCharacterID > 0 && isPlayerEntityOutlaw(targetEntity);
  const safetyLevel = attackerCharacterID > 0
    ? getSafetyLevel(attackerCharacterID)
    : SAFETY_LEVEL_FULL;

  let reason = "NON_PLAYER_COMBAT";
  let consequence = "none";
  let requiredSafetyLevel = SAFETY_LEVEL_FULL;
  let legal = true;

  if (attackerCharacterID > 0 && isNpcAuthorityStructure(targetEntity)) {
    consequence = getNpcAuthorityAggressionConsequence(scene, targetEntity);
    if (consequence !== "none") {
      legal = false;
      requiredSafetyLevel = consequence === "criminal" ? SAFETY_LEVEL_NONE : SAFETY_LEVEL_PARTIAL;
      reason = consequence === "criminal" ? "CRIMINAL_AUTHORITY_AGGRESSION" : "LOWSEC_AUTHORITY_AGGRESSION";
    } else {
      reason = "NOT_EMPIRE_SPACE";
    }
  } else if (
    attackerCharacterID > 0 &&
    targetIsPlayerProperty &&
    (targetCharacterID <= 0 || attackerCharacterID !== targetCharacterID)
  ) {
    if (
      targetCharacterID > 0 &&
      hasActiveLimitedEngagement(
        attackerCharacterID,
        targetCharacterID,
        normalizedNow,
      )
    ) {
      reason = "LIMITED_ENGAGEMENT";
    } else if (
      targetCharacterID > 0 &&
      isCharacterCriminal(targetCharacterID, normalizedNow)
    ) {
      reason = "TARGET_ALREADY_CRIMINAL";
    } else if (
      targetCharacterID > 0 &&
      isCharacterSuspect(targetCharacterID, normalizedNow)
    ) {
      reason = "TARGET_ALREADY_SUSPECT";
    } else if (targetIsOutlaw) {
      reason = "TARGET_OUTLAW";
    } else {
      const legalWar = targetProtectedPropertyCorporationID > 0
        ? findLegalWarAggressionAgainstCorporation(
          attackerCharacterID,
          targetProtectedPropertyCorporationID,
          normalizedNow,
        )
        : findLegalWarAggression(
          attackerCharacterID,
          targetCharacterID,
          normalizedNow,
        );
      if (legalWar) {
        reason = "LEGAL_WAR_AGGRESSION";
      } else if (
        targetProtectedPropertyCorporationID > 0
          ? isLegalCorporationPropertyFriendlyFire(
            attackerCharacterID,
            targetProtectedPropertyCorporationID,
            normalizedNow,
          )
          : isLegalCorporationFriendlyFire(
            attackerCharacterID,
            targetCharacterID,
            normalizedNow,
          )
      ) {
        reason = "LEGAL_CORP_FRIENDLY_FIRE";
      } else if (isHighSecuritySystem(scene.system)) {
        legal = false;
        if (targetIsPersonalDeployable) {
          consequence = "suspect";
          requiredSafetyLevel = SAFETY_LEVEL_PARTIAL;
          reason = "HIGHSEC_PERSONAL_DEPLOYABLE_AGGRESSION";
        } else {
          consequence = "criminal";
          requiredSafetyLevel = SAFETY_LEVEL_NONE;
          reason = "HIGHSEC_PLAYER_AGGRESSION";
        }
      } else if (isLowSecuritySystem(scene.system)) {
        legal = false;
        if (isCapsuleEntity(targetEntity)) {
          consequence = "criminal";
          requiredSafetyLevel = SAFETY_LEVEL_NONE;
          reason = "LOWSEC_CAPSULE_AGGRESSION";
        } else {
          consequence = "suspect";
          requiredSafetyLevel = SAFETY_LEVEL_PARTIAL;
          reason = "LOWSEC_SHIP_AGGRESSION";
        }
      } else {
        reason = "NOT_EMPIRE_SPACE";
      }
    }
  } else if (
    attackerCharacterID > 0 &&
    targetCharacterID === attackerCharacterID
  ) {
    reason = "FRIENDLY_OR_SELF";
  }

  const safetyAllows = safetyLevel <= requiredSafetyLevel;
  return {
    success: safetyAllows,
    errorMsg: safetyAllows ? null : "SafetyActivated",
    data: {
      evaluatedAtMs: normalizedNow,
      attackerCharacterID,
      attackerEntityID: toPositiveInt(attackerEntity.itemID, 0),
      targetCharacterID,
      targetProtectedPropertyCorporationID,
      targetEntityID: toPositiveInt(targetEntity.itemID, 0),
      targetIsPersonalDeployable,
      targetIsOutlaw,
      legal,
      reason,
      consequence,
      requiredSafetyLevel,
      safetyLevel,
    },
  };
}

function buildLimitedEngagementLegalAggressionResult(
  legalAggression,
  state,
  attackerCharacterID,
) {
  return {
    success: true,
    data: {
      applied: false,
      reason: legalAggression.reason,
      characterID: attackerCharacterID,
      weaponTimerExpiresAtMs: state.weaponTimerExpiresAtMs,
      pvpTimerExpiresAtMs: state.pvpTimerExpiresAtMs,
      limitedEngagement: legalAggression.engagement,
      limitedEngagementPersistenceError: legalAggression.persistenceError,
    },
  };
}

function triggerHighSecCriminalOffense(scene, attackerEntity, options = {}) {
  attackerEntity = resolveManualStarbaseAggressor(attackerEntity);
  const now = Math.max(
    0,
    Math.trunc(toFiniteNumber(options.now, Date.now())),
  );
  const targetEntity = options.targetEntity || null;
  const securityPenaltyTargetEntity =
    options.securityPenaltyTargetEntity || targetEntity || null;

  if (!scene || !attackerEntity) {
    return {
      success: false,
      errorMsg: "ENTITY_NOT_FOUND",
    };
  }

  if (getEntityActorKind(attackerEntity) !== "player") {
    return {
      success: true,
      data: {
        applied: false,
        reason: "NON_PLAYER_ATTACKER",
      },
    };
  }

  const attackerCharacterID = getEntityCharacterID(attackerEntity);
  if (!attackerCharacterID) {
    return {
      success: false,
      errorMsg: "CHARACTER_NOT_FOUND",
    };
  }
  const targetCharacterID = targetEntity ? getEntityCharacterID(targetEntity) : 0;

  const state = ensureCharacterState(attackerCharacterID);
  if (!state) {
    return {
      success: false,
      errorMsg: "CHARACTER_NOT_FOUND",
    };
  }

  state.weaponTimerExpiresAtMs = Math.max(
    toFiniteNumber(state.weaponTimerExpiresAtMs, 0),
    now + WEAPON_TIMER_DURATION_MS,
  );
  state.pvpTimerExpiresAtMs = Math.max(
    toFiniteNumber(state.pvpTimerExpiresAtMs, 0),
    now + PVP_TIMER_DURATION_MS,
  );
  state.lastKnownSystemID = toPositiveInt(scene.systemID, 0);

  const combatTimerPersistence = finalizeCharacterStateMutation(state, {
    success: true,
    data: { characterID: attackerCharacterID },
  });
  if (!combatTimerPersistence.success) {
    return combatTimerPersistence;
  }

  const limitedEngagementLegalAggression =
    resolveLimitedEngagementLegalAggression(
      attackerCharacterID,
      targetCharacterID,
      now,
      targetEntity,
    );
  if (limitedEngagementLegalAggression) {
    return buildLimitedEngagementLegalAggressionResult(
      limitedEngagementLegalAggression,
      state,
      attackerCharacterID,
    );
  }

  const legalWar = findLegalWarAggression(
    attackerCharacterID,
    targetCharacterID,
    now,
  );
  if (legalWar) {
    return {
      success: true,
      data: {
        applied: false,
        reason: "LEGAL_WAR_AGGRESSION",
        characterID: attackerCharacterID,
        warID: Number(legalWar.warID || 0),
        weaponTimerExpiresAtMs: state.weaponTimerExpiresAtMs,
        pvpTimerExpiresAtMs: state.pvpTimerExpiresAtMs,
      },
    };
  }

  if (!isHighSecuritySystem(scene.system)) {
    if (!isLowSecuritySystem(scene.system) || !isCapsuleEntity(targetEntity)) {
      return {
        success: true,
        data: {
          applied: false,
          reason: "NOT_HIGHSEC",
          characterID: attackerCharacterID,
          weaponTimerExpiresAtMs: state.weaponTimerExpiresAtMs,
          pvpTimerExpiresAtMs: state.pvpTimerExpiresAtMs,
        },
      };
    }

    if (isCharacterCriminal(targetCharacterID, now)) {
      return {
        success: true,
        data: {
          applied: false,
          reason: "TARGET_ALREADY_CRIMINAL",
          characterID: attackerCharacterID,
          weaponTimerExpiresAtMs: state.weaponTimerExpiresAtMs,
          pvpTimerExpiresAtMs: state.pvpTimerExpiresAtMs,
        },
      };
    }

    if (isCharacterSuspect(targetCharacterID, now)) {
      return {
        success: true,
        data: {
          applied: false,
          reason: "TARGET_ALREADY_SUSPECT",
          characterID: attackerCharacterID,
          weaponTimerExpiresAtMs: state.weaponTimerExpiresAtMs,
          pvpTimerExpiresAtMs: state.pvpTimerExpiresAtMs,
        },
      };
    }

    setNonTheftPenalty(
      state,
      "criminal",
      now + CRIMINAL_TIMER_DURATION_MS,
    );
    state.lastCriminalAtMs = now;

    const persistenceResult = finalizeCharacterStateMutation(state, {
      success: true,
      data: { characterID: attackerCharacterID },
    });
    if (!persistenceResult.success) {
      return persistenceResult;
    }

    const securityStatusPenalty = applySecurityStatusPenaltyForAggression(
      scene,
      attackerEntity,
      targetEntity,
      now,
    );
    const killRight = createKillRightForCriminalAggression(
      scene,
      attackerEntity,
      targetEntity,
      now,
    );

    return {
      success: true,
      data: {
        applied: true,
        reason: "LOWSEC_CAPSULE_AGGRESSION",
        characterID: attackerCharacterID,
        systemID: scene.systemID,
        criminalTimerExpiresAtMs: state.criminalTimerExpiresAtMs,
        weaponTimerExpiresAtMs: state.weaponTimerExpiresAtMs,
        pvpTimerExpiresAtMs: state.pvpTimerExpiresAtMs,
        concordResponseDueAtMs: 0,
        securityStatusPenalty:
          securityStatusPenalty && securityStatusPenalty.data
            ? securityStatusPenalty.data
            : buildSecurityStatusPenaltyResult({
              applied: false,
              reason:
                securityStatusPenalty && securityStatusPenalty.errorMsg
                  ? securityStatusPenalty.errorMsg
                  : "NOT_APPLIED",
              characterID: attackerCharacterID,
            }),
        killRight,
      },
    };
  }

  setNonTheftPenalty(
    state,
    "criminal",
    now + CRIMINAL_TIMER_DURATION_MS,
  );
  state.lastCriminalAtMs = now;

  const persistenceResult = finalizeCharacterStateMutation(state, {
    success: true,
    data: { characterID: attackerCharacterID },
  });
  if (!persistenceResult.success) {
    return persistenceResult;
  }

  const response = scheduleConcordResponse(
    scene,
    attackerEntity,
    now,
    targetEntity,
  );
  const securityStatusPenalty = securityPenaltyTargetEntity
    ? applySecurityStatusPenaltyForAggression(
      scene,
      attackerEntity,
      securityPenaltyTargetEntity,
      now,
    )
    : {
      success: true,
      data: buildSecurityStatusPenaltyResult({
        applied: false,
        reason: "NO_TARGET_ENTITY",
        characterID: attackerCharacterID,
      }),
    };
  const killRight = createKillRightForCriminalAggression(
    scene,
    attackerEntity,
    targetEntity,
    now,
  );

  return {
    success: true,
    data: {
      applied: true,
      reason: String(options.reason || "CRIMINAL_OFFENSE").trim() || "CRIMINAL_OFFENSE",
      characterID: attackerCharacterID,
      systemID: scene.systemID,
      criminalTimerExpiresAtMs: state.criminalTimerExpiresAtMs,
      weaponTimerExpiresAtMs: state.weaponTimerExpiresAtMs,
      pvpTimerExpiresAtMs: state.pvpTimerExpiresAtMs,
      concordResponseDueAtMs: response ? response.dueAtMs : 0,
      securityStatusPenalty:
        securityStatusPenalty && securityStatusPenalty.data
          ? securityStatusPenalty.data
          : buildSecurityStatusPenaltyResult({
            applied: false,
            reason:
              securityStatusPenalty && securityStatusPenalty.errorMsg
                ? securityStatusPenalty.errorMsg
                : "NOT_APPLIED",
            characterID: attackerCharacterID,
          }),
      killRight,
    },
  };
}

function buildModuleCombatParticipants(sourceEntity, targetEntity, aggressionResult) {
  const actor = resolveManualStarbaseAggressor(sourceEntity);
  const sourceKind = getEntityActorKind(actor);
  const targetKind = getEntityActorKind(targetEntity);
  const participants = new Map();
  const add = (entity, kinds) => {
    const characterID = getEntityCharacterID(entity);
    if (!characterID) return;
    participants.set(characterID, { entity, kinds: new Set(kinds) });
  };
  const sourceNpc = sourceKind === ENTITY_TYPE.NPC || sourceKind === ENTITY_TYPE.CONCORD;
  const targetNpc = targetKind === ENTITY_TYPE.NPC || targetKind === ENTITY_TYPE.CONCORD;
  if (sourceKind === "player" && (targetNpc || isNpcAuthorityStructure(targetEntity))) {
    add(actor, ["npc"]);
  } else if (sourceNpc && targetKind === "player") {
    add(targetEntity, ["npc"]);
  } else if (sourceKind === "player" &&
      (targetKind === "player" || resolveEntityProtectedPropertyCorporationID(targetEntity) > 0) &&
      getEntityCharacterID(actor) !== getEntityCharacterID(targetEntity)) {
    add(actor, ["weapons", "pvp"]);
    add(targetEntity, ["pvp"]);
  }
  const reason = aggressionResult && aggressionResult.data && aggressionResult.data.reason;
  const penalty = {
    HIGHSEC_PLAYER_AGGRESSION: "criminal",
    LOWSEC_CAPSULE_AGGRESSION: "criminal",
    LOWSEC_SHIP_AGGRESSION: "suspect",
    HIGHSEC_PERSONAL_DEPLOYABLE_AGGRESSION: "suspect",
    CRIMINAL_AUTHORITY_AGGRESSION: "criminal",
    LOWSEC_AUTHORITY_AGGRESSION: "suspect",
  }[reason];
  const actorParticipant = participants.get(getEntityCharacterID(actor));
  if (penalty && actorParticipant) actorParticipant.kinds.add(penalty);
  return participants;
}

function extendModuleCombatTimers(scene, participants, now, notify = true) {
  let success = true;
  for (const [characterID, { entity, kinds }] of participants) {
    const state = ensureCharacterState(characterID);
    if (!state) continue;
    const previous = cloneValue(state);
    for (const [kind, field, duration] of [
      ["weapons", "weaponTimerExpiresAtMs", WEAPON_TIMER_DURATION_MS],
      ["pvp", "pvpTimerExpiresAtMs", PVP_TIMER_DURATION_MS],
      ["npc", "npcTimerExpiresAtMs", NPC_TIMER_DURATION_MS],
    ]) {
      if (kinds.has(kind)) state[field] = Math.max(state[field], now + duration);
    }
    if (kinds.has("criminal")) {
      setNonTheftPenalty(state, "criminal", now + CRIMINAL_TIMER_DURATION_MS);
    } else if (kinds.has("suspect") &&
        (!state.criminal || state.criminalTimerExpiresAtMs <= now)) {
      setNonTheftPenalty(state, "suspect", now + CRIMINAL_TIMER_DURATION_MS);
    }
    state.lastKnownSystemID = toPositiveInt(scene && scene.systemID, state.lastKnownSystemID);
    if (JSON.stringify(previous) !== JSON.stringify(state)) {
      const result = finalizeCharacterStateMutation(state, { success: true });
      if (!result.success) {
        rollbackRejectedCharacterStateMutation(state, previous);
        success = false;
        log.warn(`[Crimewatch] Combat timer refresh failed for character=${characterID}`);
        continue;
      }
    }
    if (notify && entity.session) {
      try { synchronizeSessionTimerNotifications(scene, entity.session, now); }
      catch (error) { log.debug(`[Crimewatch] Combat timer delivery failed: ${error.message}`); }
    }
  }
  return success;
}

function removeModuleCombatActivity(effectState, activity) {
  moduleCombatActivities.delete(effectState);
  for (const characterID of activity.participants.keys()) {
    const activities = characterCombatActivities.get(characterID);
    if (!activities) continue;
    activities.delete(activity);
    if (activities.size === 0) characterCombatActivities.delete(characterID);
  }
}

// The retail 101/201/301/302/401 states have no expiry. Hold them for the
// committed offensive module's lifetime, including a requested final cycle.
function beginModuleCombatActivity(scene, sourceEntity, targetEntity, effectState, now,
  aggressionResult = null) {
  if (!effectState || moduleCombatActivities.has(effectState)) return;
  const participants = buildModuleCombatParticipants(sourceEntity, targetEntity, aggressionResult);
  if (participants.size === 0) return;
  const activity = { scene, sourceEntity, targetEntity, participants,
    endedAtMs: null, lastRefreshAtMs: now };
  moduleCombatActivities.set(effectState, activity);
  for (const characterID of participants.keys()) {
    if (!characterCombatActivities.has(characterID)) characterCombatActivities.set(characterID, new Set());
    characterCombatActivities.get(characterID).add(activity);
  }
  if (!extendModuleCombatTimers(scene, participants, now)) activity.lastRefreshAtMs = -Infinity;
  markLimitedEngagementsOngoingForParticipants(participants, now);
}

function endModuleCombatActivity(effectState, now) {
  const activity = moduleCombatActivities.get(effectState);
  if (!activity) return;
  activity.endedAtMs ??= now;
  if (extendModuleCombatTimers(activity.scene, activity.participants, activity.endedAtMs)) {
    removeModuleCombatActivity(effectState, activity);
  }
  resumeLimitedEngagementTimeoutsForParticipants(activity.participants, activity.endedAtMs);
}

// A disposed scene never ticks again, so its activities are ended here: the
// pilots' countdowns start from the disposal, and none is left showing an
// active timer until a restart.
function disposeSceneCombatActivities(scene, now = Date.now()) {
  for (const [effectState, activity] of [...moduleCombatActivities]) {
    if (activity.scene !== scene) continue;
    endModuleCombatActivity(effectState, now);
    removeModuleCombatActivity(effectState, activity);
  }
}

function refreshModuleCombatActivities(scene, now) {
  for (const [effectState, activity] of moduleCombatActivities) {
    if (activity.scene !== scene) continue;
    const { sourceEntity, targetEntity } = activity;
    if (activity.endedAtMs !== null ||
        sourceEntity.activeModuleEffects?.get(effectState.moduleID) !== effectState ||
        scene.getEntityByID(sourceEntity.itemID) !== sourceEntity ||
        scene.getEntityByID(targetEntity.itemID) !== targetEntity) {
      endModuleCombatActivity(effectState, now);
      continue;
    }
    // Avoid a durable write on every subsecond simulation step. The live
    // source is checked on every step; countdowns are committed again at stop.
    if (now - activity.lastRefreshAtMs >= 1_000 &&
        extendModuleCombatTimers(scene, activity.participants, now)) {
      activity.lastRefreshAtMs = now;
      holdOngoingLimitedEngagementsForParticipants(activity.participants, now);
    }
  }
}

function recordPvpActivity(scene, actorEntity, now = Date.now()) {
  const characterID = getEntityCharacterID(actorEntity);
  const state = characterID && ensureCharacterState(characterID);
  if (!state) return { success: false, errorMsg: "CHARACTER_NOT_FOUND" };
  const previous = cloneValue(state);
  state.pvpTimerExpiresAtMs = Math.max(Number(state.pvpTimerExpiresAtMs) || 0,
    Number(now) + PVP_TIMER_DURATION_MS);
  state.lastKnownSystemID = toPositiveInt(scene && scene.systemID, state.lastKnownSystemID);
  const result = finalizeCharacterStateMutation(state, {
    success: true, data: { characterID, pvpTimerExpiresAtMs: state.pvpTimerExpiresAtMs },
  });
  if (!result.success) {
    rollbackRejectedCharacterStateMutation(state, previous);
    return result;
  }
  if (actorEntity.session) {
    try { synchronizeSessionTimerNotifications(scene, actorEntity.session, now); }
    catch (_) { /* The normal scene sync retries committed timer presentation. */ }
  }
  return result;
}

function recordWeaponTimer(scene, actorEntity, now = Date.now(), options = {}) {
  actorEntity = resolveManualStarbaseAggressor(actorEntity);
  if (!actorEntity) {
    return {
      success: false,
      errorMsg: "ENTITY_NOT_FOUND",
    };
  }

  const characterID = getEntityCharacterID(actorEntity);
  if (!characterID) {
    return {
      success: false,
      errorMsg: "CHARACTER_NOT_FOUND",
    };
  }
  if (options.dryRun === true) {
    return {
      success: true,
      data: {
        applied: false,
        characterID,
        dryRun: true,
      },
    };
  }

  const state = ensureCharacterState(characterID);
  if (!state) {
    return {
      success: false,
      errorMsg: "CHARACTER_NOT_FOUND",
    };
  }

  const normalizedNow = Math.max(0, Math.trunc(toFiniteNumber(now, Date.now())));
  const previousExpiresAtMs = Math.max(
    0,
    toFiniteNumber(state.weaponTimerExpiresAtMs, 0),
  );
  state.weaponTimerExpiresAtMs = Math.max(
    previousExpiresAtMs,
    normalizedNow + WEAPON_TIMER_DURATION_MS,
  );
  state.lastKnownSystemID = toPositiveInt(
    scene && scene.systemID,
    toPositiveInt(state.lastKnownSystemID, 0),
  );

  const persistenceResult = finalizeCharacterStateMutation(state, {
    success: true,
    data: {
      applied: true,
      characterID,
      previousWeaponTimerExpiresAtMs: previousExpiresAtMs,
      weaponTimerExpiresAtMs: state.weaponTimerExpiresAtMs,
    },
  });
  if (!persistenceResult.success) {
    return persistenceResult;
  }

  let notificationError = null;
  if (actorEntity.session) {
    try {
      synchronizeSessionTimerNotifications(
        scene || null,
        actorEntity.session,
        normalizedNow,
      );
    } catch (error) {
      // Timer state is authoritative and already committed. A failed client
      // notification is retried by the normal Crimewatch scene sync and must
      // not make the caller treat the mandatory timer as absent.
      notificationError = String(error && error.message || error || "UNKNOWN_ERROR");
    }
  }

  return {
    success: true,
    data: {
      applied: true,
      characterID,
      previousWeaponTimerExpiresAtMs: previousExpiresAtMs,
      weaponTimerExpiresAtMs: state.weaponTimerExpiresAtMs,
      notificationError,
    },
  };
}

function setCharacterCrimewatchDebugState(characterID, updates = {}, options = {}) {
  const state = ensureCharacterState(characterID);
  if (!state) {
    return {
      success: false,
      errorMsg: "CHARACTER_NOT_FOUND",
    };
  }

  const now = Math.max(0, Math.trunc(toFiniteNumber(options.now, Date.now())));
  const numericSystemID = toPositiveInt(
    options.systemID,
    toPositiveInt(state.lastKnownSystemID, 0),
  );
  const previousState = cloneValue(state);

  if (Object.prototype.hasOwnProperty.call(updates, "safetyLevel")) {
    state.safetyLevel = normalizeSafetyLevel(updates.safetyLevel);
  }

  if (updates.clearTimers === true || updates.clearAll === true) {
    state.weaponTimerExpiresAtMs = 0;
    state.pvpTimerExpiresAtMs = 0;
    state.npcTimerExpiresAtMs = 0;
    state.disapprovalTimerExpiresAtMs = 0;
    state.nonTheftPenalty = normalizeNonTheftPenalty(null);
    state.containerTheftReceipts = {};
    recomputeCharacterPenaltyState(state);
  }

  if (Object.prototype.hasOwnProperty.call(updates, "weaponTimerMs")) {
    const durationMs = Math.max(0, Math.trunc(toFiniteNumber(updates.weaponTimerMs, 0)));
    state.weaponTimerExpiresAtMs = durationMs > 0 ? now + durationMs : 0;
  }
  if (Object.prototype.hasOwnProperty.call(updates, "pvpTimerMs")) {
    const durationMs = Math.max(0, Math.trunc(toFiniteNumber(updates.pvpTimerMs, 0)));
    state.pvpTimerExpiresAtMs = durationMs > 0 ? now + durationMs : 0;
  }
  if (Object.prototype.hasOwnProperty.call(updates, "npcTimerMs")) {
    const durationMs = Math.max(0, Math.trunc(toFiniteNumber(updates.npcTimerMs, 0)));
    state.npcTimerExpiresAtMs = durationMs > 0 ? now + durationMs : 0;
  }
  if (Object.prototype.hasOwnProperty.call(updates, "disapprovalTimerMs")) {
    const durationMs = Math.max(0, Math.trunc(toFiniteNumber(updates.disapprovalTimerMs, 0)));
    state.disapprovalTimerExpiresAtMs = durationMs > 0 ? now + durationMs : 0;
  }

  let basePenalty = normalizeNonTheftPenalty(state.nonTheftPenalty);
  let penaltyKind = basePenalty.criminal
    ? "criminal"
    : basePenalty.suspect
      ? "suspect"
      : "none";
  let penaltyExpiresAtMs = basePenalty.criminalTimerExpiresAtMs;
  let penaltyDurationWasExplicit = false;
  if (Object.prototype.hasOwnProperty.call(updates, "criminalTimerMs")) {
    penaltyDurationWasExplicit = true;
    const durationMs = Math.max(0, Math.trunc(toFiniteNumber(updates.criminalTimerMs, 0)));
    penaltyExpiresAtMs = durationMs > 0 ? now + durationMs : 0;
  }

  if (Object.prototype.hasOwnProperty.call(updates, "criminal")) {
    if (updates.criminal) {
      penaltyKind = "criminal";
      if (
        !penaltyDurationWasExplicit &&
        penaltyExpiresAtMs <= now
      ) {
        penaltyExpiresAtMs = Math.max(
          penaltyExpiresAtMs,
          now + CRIMINAL_TIMER_DURATION_MS,
        );
      }
      state.lastCriminalAtMs = now;
    } else if (!updates.suspect && penaltyKind === "criminal") {
      penaltyKind = "none";
      penaltyExpiresAtMs = 0;
    }
  }

  if (Object.prototype.hasOwnProperty.call(updates, "suspect")) {
    if (updates.suspect) {
      penaltyKind = "suspect";
      if (
        !penaltyDurationWasExplicit &&
        penaltyExpiresAtMs <= now
      ) {
        penaltyExpiresAtMs = Math.max(
          penaltyExpiresAtMs,
          now + CRIMINAL_TIMER_DURATION_MS,
        );
      }
    } else if (!updates.criminal && penaltyKind === "suspect") {
      penaltyKind = "none";
      penaltyExpiresAtMs = 0;
    }
  }

  // `/cwatch criminal off` and `/cwatch suspect off` explicitly clear the
  // visible penalty, including operation-scoped theft contributions. Other
  // debug and gameplay writers continue to mutate only the independent base.
  if (
    updates.criminal === false &&
    updates.suspect === false &&
    penaltyDurationWasExplicit &&
    penaltyExpiresAtMs <= now
  ) {
    state.containerTheftReceipts = {};
  }

  setNonTheftPenalty(
    state,
    penaltyKind,
    penaltyExpiresAtMs,
    { exact: true },
  );

  if (numericSystemID > 0) {
    state.lastKnownSystemID = numericSystemID;
  }

  const persistenceResult = finalizeCharacterStateMutation(state, {
    success: true,
    data: { characterID: state.characterID },
  });
  if (!persistenceResult.success) {
    rollbackRejectedCharacterStateMutation(state, previousState);
    return persistenceResult;
  }
  const pruneResult = pruneCharacterState(state.characterID, now);
  if (!pruneResult || pruneResult.success !== true) {
    return {
      success: false,
      errorMsg: "CRIMEWATCH_STATE_PERSIST_FAILED",
      data: {
        characterID: state.characterID,
        persistenceError:
          pruneResult && pruneResult.errorMsg
            ? pruneResult.errorMsg
            : "WRITE_ERROR",
      },
    };
  }

  if (
    updates.refreshConcord === true &&
    state.criminal === true &&
    toFiniteNumber(state.criminalTimerExpiresAtMs, 0) > now &&
    options.scene &&
    options.offenderEntity
  ) {
    scheduleConcordResponse(
      options.scene,
      options.offenderEntity,
      now,
      options.targetEntity || null,
    );
  }

  return {
    success: true,
    data: getCharacterCrimewatchState(state.characterID, now) ||
      buildDefaultCharacterState(state.characterID),
  };
}

function recordHomefrontIntrusion(characterID, systemID, now = Date.now()) {
  // Reuse the ordinary independent suspect timer; no theft contribution,
  // criminal response, standings change or limited engagement is created.
  const current = getCharacterCrimewatchState(characterID, now);
  if (current?.criminal) return { success: true, data: current };
  return setCharacterCrimewatchDebugState(
    characterID,
    {
      suspect: true,
      criminalTimerMs: CRIMINAL_TIMER_DURATION_MS,
    },
    { systemID, now },
  );
}

function recordNpcAuthorityAggression(scene, attackerEntity, targetEntity, now) {
  const characterID = getEntityCharacterID(attackerEntity);
  const state = ensureCharacterState(characterID);
  if (!state) return { success: false, errorMsg: "CHARACTER_NOT_FOUND" };
  const previousState = cloneValue(state);
  const consequence = getNpcAuthorityAggressionConsequence(scene, targetEntity);
  state.npcTimerExpiresAtMs = Math.max(state.npcTimerExpiresAtMs, now + NPC_TIMER_DURATION_MS);
  state.lastKnownSystemID = toPositiveInt(scene.systemID, state.lastKnownSystemID);
  if (consequence === "criminal" ||
      (consequence === "suspect" && (!state.criminal || state.criminalTimerExpiresAtMs <= now))) {
    setNonTheftPenalty(state, consequence, now + CRIMINAL_TIMER_DURATION_MS);
  }
  if (consequence === "criminal") state.lastCriminalAtMs = now;
  const persistenceResult = finalizeCharacterStateMutation(state, { success: true });
  if (!persistenceResult.success) {
    rollbackRejectedCharacterStateMutation(state, previousState);
    return persistenceResult;
  }
  const response = consequence === "criminal"
    ? scheduleConcordResponse(scene, attackerEntity, now, targetEntity)
    : null;
  const securityStatusPenalty = consequence === "none"
    ? { data: { applied: false, reason: "NOT_EMPIRE_SPACE" } }
    : applySecurityStatusPenaltyForAggression(scene, attackerEntity, targetEntity, now);
  return {
    success: true,
    data: {
      applied: consequence !== "none",
      reason: consequence === "criminal"
        ? "CRIMINAL_AUTHORITY_AGGRESSION"
        : consequence === "suspect" ? "LOWSEC_AUTHORITY_AGGRESSION" : "NOT_EMPIRE_SPACE",
      characterID,
      systemID: scene.systemID,
      npcTimerExpiresAtMs: state.npcTimerExpiresAtMs,
      criminalTimerExpiresAtMs: state.criminalTimerExpiresAtMs,
      concordResponseDueAtMs: response ? response.dueAtMs : 0,
      securityStatusPenalty: securityStatusPenalty.data || {
        applied: false, reason: securityStatusPenalty.errorMsg || "NOT_APPLIED",
      },
      killRight: { created: false, reason: "NO_PLAYER_VICTIM" },
    },
  };
}

function recordHighSecCriminalAggression(scene, attackerEntity, targetEntity, now = Date.now()) {
  attackerEntity = resolveManualStarbaseAggressor(attackerEntity);
  if (!scene || !attackerEntity || !targetEntity) {
    return {
      success: false,
      errorMsg: "ENTITY_NOT_FOUND",
    };
  }

  if (entityHasInvalidProtectedPropertyCorporationMarker(targetEntity)) {
    return {
      success: false,
      errorMsg: "PROPERTY_AUTHORITY_INVALID",
      data: {
        applied: false,
        reason: "INVALID_PROPERTY_AUTHORITY",
      },
    };
  }

  if (getEntityActorKind(attackerEntity) === "player" && isNpcAuthorityStructure(targetEntity)) {
    return recordNpcAuthorityAggression(scene, attackerEntity, targetEntity, now);
  }
  const targetProtectedPropertyCorporationID =
    resolveEntityProtectedPropertyCorporationID(targetEntity);
  const npcParticipants = buildModuleCombatParticipants(attackerEntity, targetEntity, null);
  if ([...npcParticipants.values()].some(({ kinds }) => kinds.has("npc")) &&
      !extendModuleCombatTimers(scene, npcParticipants, now, false)) {
    return { success: false, errorMsg: "CRIMEWATCH_STATE_PERSIST_FAILED" };
  }
  if (
    getEntityActorKind(attackerEntity) !== "player" ||
    (
      getEntityActorKind(targetEntity) !== "player" &&
      targetProtectedPropertyCorporationID <= 0
    )
  ) {
    return {
      success: true,
      data: {
        applied: false,
        reason: "NON_PLAYER_COMBAT",
      },
    };
  }

  const attackerCharacterID = getEntityCharacterID(attackerEntity);
  const targetCharacterID = getEntityCharacterID(targetEntity);
  if (
    !attackerCharacterID ||
    (!targetCharacterID && !targetProtectedPropertyCorporationID) ||
    attackerCharacterID === targetCharacterID
  ) {
    return {
      success: true,
      data: {
        applied: false,
        reason: "FRIENDLY_OR_SELF",
      },
    };
  }

  const state = ensureCharacterState(attackerCharacterID);
  if (!state) {
    return {
      success: false,
      errorMsg: "CHARACTER_NOT_FOUND",
    };
  }

  state.weaponTimerExpiresAtMs = Math.max(
    toFiniteNumber(state.weaponTimerExpiresAtMs, 0),
    now + WEAPON_TIMER_DURATION_MS,
  );
  state.pvpTimerExpiresAtMs = Math.max(
    toFiniteNumber(state.pvpTimerExpiresAtMs, 0),
    now + PVP_TIMER_DURATION_MS,
  );
  state.lastKnownSystemID = toPositiveInt(scene.systemID, 0);

  const combatTimerPersistence = finalizeCharacterStateMutation(state, {
    success: true,
    data: { characterID: attackerCharacterID },
  });
  if (!combatTimerPersistence.success) {
    return combatTimerPersistence;
  }

  const limitedEngagementLegalAggression =
    resolveLimitedEngagementLegalAggression(
      attackerCharacterID,
      targetCharacterID,
      now,
      targetEntity,
    );
  if (limitedEngagementLegalAggression) {
    return buildLimitedEngagementLegalAggressionResult(
      limitedEngagementLegalAggression,
      state,
      attackerCharacterID,
    );
  }

  const buildLegalCorporationFriendlyFireResult = () => ({
    success: true,
    data: {
      applied: false,
      reason: "LEGAL_CORP_FRIENDLY_FIRE",
      characterID: attackerCharacterID,
      weaponTimerExpiresAtMs: state.weaponTimerExpiresAtMs,
      pvpTimerExpiresAtMs: state.pvpTimerExpiresAtMs,
    },
  });
  const isLegalFriendlyFire = () =>
    targetProtectedPropertyCorporationID > 0
      ? isLegalCorporationPropertyFriendlyFire(
        attackerCharacterID,
        targetProtectedPropertyCorporationID,
        now,
      )
      : isLegalCorporationFriendlyFire(
        attackerCharacterID,
        targetCharacterID,
        now,
      );

  if (!isHighSecuritySystem(scene.system)) {
    if (isLowSecuritySystem(scene.system)) {
      const legalPropertyWar = targetProtectedPropertyCorporationID > 0
        ? findLegalWarAggressionAgainstCorporation(
          attackerCharacterID,
          targetProtectedPropertyCorporationID,
          now,
        )
        : null;
      if (legalPropertyWar) {
        return {
          success: true,
          data: {
            applied: false,
            reason: "LEGAL_WAR_AGGRESSION",
            characterID: attackerCharacterID,
            warID: Number(legalPropertyWar.warID || 0),
            weaponTimerExpiresAtMs: state.weaponTimerExpiresAtMs,
            pvpTimerExpiresAtMs: state.pvpTimerExpiresAtMs,
          },
        };
      }
      if (isCapsuleEntity(targetEntity)) {
        if (isLegalFriendlyFire()) {
          return buildLegalCorporationFriendlyFireResult();
        }
        return triggerHighSecCriminalOffense(
          scene,
          attackerEntity,
          {
            now,
            reason: "LOWSEC_CAPSULE_AGGRESSION",
            targetEntity,
            securityPenaltyTargetEntity: targetEntity,
          },
        );
      }

      if (isCharacterCriminal(targetCharacterID, now)) {
        return {
          success: true,
          data: {
            applied: false,
            reason: "TARGET_ALREADY_CRIMINAL",
            characterID: attackerCharacterID,
            weaponTimerExpiresAtMs: state.weaponTimerExpiresAtMs,
            pvpTimerExpiresAtMs: state.pvpTimerExpiresAtMs,
          },
        };
      }

      if (isCharacterSuspect(targetCharacterID, now)) {
        return {
          success: true,
          data: {
            applied: false,
            reason: "TARGET_ALREADY_SUSPECT",
            characterID: attackerCharacterID,
            weaponTimerExpiresAtMs: state.weaponTimerExpiresAtMs,
            pvpTimerExpiresAtMs: state.pvpTimerExpiresAtMs,
          },
        };
      }

      if (isLegalFriendlyFire()) {
        return buildLegalCorporationFriendlyFireResult();
      }

      setNonTheftPenalty(
        state,
        "suspect",
        now + CRIMINAL_TIMER_DURATION_MS,
      );

      const persistenceResult = finalizeCharacterStateMutation(state, {
        success: true,
        data: {
          applied: true,
          reason: "LOWSEC_SHIP_AGGRESSION",
          characterID: attackerCharacterID,
          systemID: scene.systemID,
          suspectTimerExpiresAtMs: state.criminalTimerExpiresAtMs,
          weaponTimerExpiresAtMs: state.weaponTimerExpiresAtMs,
          pvpTimerExpiresAtMs: state.pvpTimerExpiresAtMs,
        },
      });
      if (!persistenceResult.success) return persistenceResult;
      const securityStatusPenalty = applySecurityStatusPenaltyForAggression(
        scene, attackerEntity, targetEntity, now,
      );
      persistenceResult.data.securityStatusPenalty = securityStatusPenalty.data || {
        applied: false,
        reason: securityStatusPenalty.errorMsg || "NOT_APPLIED",
      };
      return persistenceResult;
    }

    return {
      success: true,
      data: {
        applied: false,
        reason: "NOT_HIGHSEC",
        characterID: attackerCharacterID,
        weaponTimerExpiresAtMs: state.weaponTimerExpiresAtMs,
        pvpTimerExpiresAtMs: state.pvpTimerExpiresAtMs,
      },
    };
  }

  if (isCharacterCriminal(targetCharacterID, now)) {
    return {
      success: true,
      data: {
        applied: false,
        reason: "TARGET_ALREADY_CRIMINAL",
        characterID: attackerCharacterID,
        weaponTimerExpiresAtMs: state.weaponTimerExpiresAtMs,
        pvpTimerExpiresAtMs: state.pvpTimerExpiresAtMs,
      },
    };
  }

  if (isCharacterSuspect(targetCharacterID, now)) {
    return {
      success: true,
      data: {
        applied: false,
        reason: "TARGET_ALREADY_SUSPECT",
        characterID: attackerCharacterID,
        weaponTimerExpiresAtMs: state.weaponTimerExpiresAtMs,
        pvpTimerExpiresAtMs: state.pvpTimerExpiresAtMs,
      },
    };
  }

  if (isLegalFriendlyFire()) {
    return buildLegalCorporationFriendlyFireResult();
  }

  const legalWar = targetProtectedPropertyCorporationID > 0
    ? findLegalWarAggressionAgainstCorporation(
      attackerCharacterID,
      targetProtectedPropertyCorporationID,
      now,
    )
    : findLegalWarAggression(
      attackerCharacterID,
      targetCharacterID,
      now,
    );
  if (legalWar) {
    return {
      success: true,
      data: {
        applied: false,
        reason: "LEGAL_WAR_AGGRESSION",
        characterID: attackerCharacterID,
        warID: Number(legalWar.warID || 0),
        weaponTimerExpiresAtMs: state.weaponTimerExpiresAtMs,
        pvpTimerExpiresAtMs: state.pvpTimerExpiresAtMs,
      },
    };
  }

  // Personal deployables are intentionally destructible in high security
  // space. Starting combat with one is a suspect action, not a criminal act:
  // no CONCORD response, security-status penalty, kill right, or criminal
  // timer is created. Ordinary player ships, capsules, cans, and wrecks retain
  // the criminal path below.
  if (isPersonalDeployableEntity(targetEntity)) {
    if (
      state.criminal === true &&
      toFiniteNumber(state.criminalTimerExpiresAtMs, 0) > now
    ) {
      return {
        success: true,
        data: {
          applied: false,
          reason: "ALREADY_CRIMINAL",
          characterID: attackerCharacterID,
          criminalTimerExpiresAtMs: state.criminalTimerExpiresAtMs,
          weaponTimerExpiresAtMs: state.weaponTimerExpiresAtMs,
          pvpTimerExpiresAtMs: state.pvpTimerExpiresAtMs,
        },
      };
    }
    setNonTheftPenalty(
      state,
      "suspect",
      now + CRIMINAL_TIMER_DURATION_MS,
    );
    return finalizeCharacterStateMutation(state, {
      success: true,
      data: {
        applied: true,
        reason: "HIGHSEC_PERSONAL_DEPLOYABLE_AGGRESSION",
        characterID: attackerCharacterID,
        systemID: scene.systemID,
        suspectTimerExpiresAtMs: state.criminalTimerExpiresAtMs,
        weaponTimerExpiresAtMs: state.weaponTimerExpiresAtMs,
        pvpTimerExpiresAtMs: state.pvpTimerExpiresAtMs,
      },
    });
  }

  return triggerHighSecCriminalOffense(
    scene,
    attackerEntity,
    {
      now,
      reason: "HIGHSEC_PLAYER_AGGRESSION",
      targetEntity,
      securityPenaltyTargetEntity: targetEntity,
    },
  );
}

function getActiveResponderEntityIDs(scene, response) {
  const currentIDs = Array.isArray(response && response.responderEntityIDs)
    ? response.responderEntityIDs
    : [];
  return currentIDs.filter((entityID) => Boolean(scene && scene.getEntityByID(entityID)));
}

function buildConcordArrivalPoint(offenderEntity, index = 0, total = 1) {
  const center = cloneVector(offenderEntity && offenderEntity.position);
  const divisor = Math.max(1, toPositiveInt(total, 1));
  const angle = ((Math.PI * 2) / divisor) * Math.max(0, index);
  return {
    x: center.x + (Math.cos(angle) * CONCORD_RESPONSE_ARRIVAL_RING_METERS),
    y: center.y,
    z: center.z + (Math.sin(angle) * CONCORD_RESPONSE_ARRIVAL_RING_METERS),
  };
}

function clearConcordResponders(scene, responderEntityIDs) {
  if (!scene || !Array.isArray(responderEntityIDs) || responderEntityIDs.length === 0) {
    return 0;
  }

  let clearedCount = 0;
  for (const responderEntityID of responderEntityIDs) {
    const destroyResult = getNpcRuntime().despawn(
      responderEntityID,
      {
        removeContents: true,
      },
    );
    if (destroyResult && destroyResult.success) {
      clearedCount += 1;
    }
  }
  return clearedCount;
}

function stopResponders(scene, responderEntityIDs) {
  if (
    !scene ||
    !Array.isArray(responderEntityIDs) ||
    responderEntityIDs.length === 0
  ) {
    return 0;
  }

  let stoppedCount = 0;
  for (const responderEntityID of responderEntityIDs) {
    const responderEntity = scene.getEntityByID(responderEntityID);
    if (!responderEntity) {
      continue;
    }

    const needsAuthoritativeParkRefresh =
      responderEntity.mode !== "STOP" ||
      magnitude(responderEntity.velocity) > 0.1 ||
      responderEntity.mode === "WARP" ||
      toPositiveInt(responderEntity.targetEntityID, 0) > 0 ||
      toFiniteNumber(responderEntity.followRange, 0) > 0 ||
      toFiniteNumber(responderEntity.orbitDistance, 0) > 0;

    if (needsAuthoritativeParkRefresh) {
      // Crime-scene cleanup happens after different responders have reached
      // different movement phases. A plain STOP leaves clients extrapolating
      // from their own last-known movement history, which can desync one
      // responder into "flying off forever" for a single observer. Re-anchor
      // moving responders onto one authoritative parked position first so every
      // client collapses to the same on-grid state before the controller idles.
      const parkedPosition =
        responderEntity.mode === "WARP" &&
        Number(responderEntity.effectStamp) >= 0
          ? cloneVector(
              responderEntity.targetPoint,
              responderEntity.position,
            )
          : cloneVector(responderEntity.position);
      scene.teleportDynamicEntityToPoint(
        responderEntity,
        parkedPosition,
        {
          direction: responderEntity.direction,
          refreshOwnerSession: false,
        },
      );
    }

    const orderResult = getNpcRuntime().stop(responderEntityID, {
      wakeController: true,
    });
    if (orderResult && orderResult.success) {
      stoppedCount += 1;
    }
  }
  return stoppedCount;
}

function spawnConcordResponders(scene, offenderEntity, response) {
  if (!scene || !offenderEntity || !response) {
    return {
      responderEntityIDs: [],
      ingressCompleteAtMs: 0,
    };
  }

  const responseOriginAnchor = buildConcordResponseOriginAnchor(
    scene,
    offenderEntity,
  );
  const spawnResult = getNpcRuntime().spawnGroupInSystem(scene.systemID, {
    entityScopeMetadata: buildChildEntityScopeMetadata(offenderEntity),
    entityType: ENTITY_TYPE.CONCORD,
    runtimeKind: "nativeCombat",
    spawnGroupQuery: CONCORD_RESPONSE_SPAWN_GROUP_ID,
    anchorDescriptor: {
      kind: "coordinates",
      position: responseOriginAnchor.position,
      direction: responseOriginAnchor.direction,
      name: "Crimewatch CONCORD Response Origin",
    },
    preferredTargetID: offenderEntity.itemID,
    behaviorOverrides: {
      autoAggro: false,
      autoActivateWeapons: true,
      returnToHomeWhenIdle: false,
      leashRangeMeters: 0,
      allowPodKill: isCrimewatchConcordPodKillEnabled(),
    },
    transient: true,
    broadcast: false,
    skipInitialBehaviorTick: true,
    spawnDistanceMeters: CONCORD_RESPONSE_WARP_ORIGIN_LOCAL_SPAWN_DISTANCE_METERS,
    spreadMeters: CONCORD_RESPONSE_WARP_ORIGIN_LOCAL_SPAWN_SPREAD_METERS,
  });
  if (
    !spawnResult.success ||
    !spawnResult.data ||
    !Array.isArray(spawnResult.data.spawned)
  ) {
    return {
      responderEntityIDs: [],
      ingressCompleteAtMs: 0,
    };
  }

  const totalSpawned = spawnResult.data.spawned.length;
  const warpRequests = [];
  spawnResult.data.spawned.forEach((entry, index) => {
    const entity = entry && entry.entity;
    const entityID = toPositiveInt(entity && entity.itemID, 0);
    if (!entity || !entityID) {
      return;
    }

    const arrivalPoint = buildConcordArrivalPoint(
      offenderEntity,
      index,
      totalSpawned,
    );
    warpRequests.push({
      entityID,
      point: arrivalPoint,
      options: {
        forceImmediateStart: true,
        broadcastWarpStartToVisibleSessions: true,
        targetEntityID: offenderEntity.itemID,
        warpSpeedAU: CONCORD_RESPONSE_WARP_SPEED_AU,
        ingressDurationMs: CONCORD_RESPONSE_INGRESS_DURATION_MS,
      },
    });
  });

  const warpBatchResult = getNpcRuntime().warpBatchToPoints(warpRequests, {
    groupWake: true,
  });
  if (!warpBatchResult || !warpBatchResult.success || !warpBatchResult.data) {
    return {
      responderEntityIDs: [],
      ingressCompleteAtMs: 0,
    };
  }

  const groupedWakeAtMs = Math.max(
    0,
    Math.trunc(toFiniteNumber(warpBatchResult.data.commonWakeAtMs, 0)),
  );
  for (const resultEntry of warpBatchResult.data.results) {
    const responderEntityID = toPositiveInt(resultEntry && resultEntry.entityID, 0);
    if (!responderEntityID) {
      continue;
    }
    // Carry the real Crimewatch attack order through the managed warp so the
    // controller lands with the correct target/weapon policy already staged.
    // We immediately re-schedule the wake because issueAttackOrder normally
    // wakes now, but that would recreate the same-tick warp-complete snap race.
    getNpcRuntime().issueAttackOrder(
      responderEntityID,
      offenderEntity.itemID,
      {
        allowWeapons: true,
        keepLock: true,
        allowPodKill: isCrimewatchConcordPodKillEnabled(),
      },
    );
    getNpcRuntime().scheduleNpcController(responderEntityID, groupedWakeAtMs);
  }

  return {
    responderEntityIDs: warpBatchResult.data.results
      .map((entry) => toPositiveInt(entry && entry.entityID, 0))
      .filter((entityID) => entityID > 0),
    ingressCompleteAtMs: groupedWakeAtMs,
  };
}

// targetDroneBandwidthMultiplier (3661) takes the target's drone bandwidth to 0 once
// a ship carrying it has the lock: its drones leave its control and none can launch.
function suppressOffenderDrones(scene, offenderEntity, responderEntityIDs) {
  if (offenderEntity.droneBandwidthSuppressed === true) {
    return;
  }
  const { typeHasEffectName } = require(path.join(__dirname, "../fitting/liveFittingState"));
  const suppressed = responderEntityIDs.some((responderEntityID) => {
    const responder = scene.getEntityByID(responderEntityID);
    return responder &&
      typeHasEffectName(responder.typeID, "targetDroneBandwidthMultiplier") &&
      scene.getTargetsForEntity(responder).includes(offenderEntity.itemID);
  });
  if (suppressed) {
    offenderEntity.droneBandwidthSuppressed = true;
    require(path.join(__dirname, "../drone/droneRuntime")).handleControllerLost(scene, offenderEntity);
  }
}

// A spawn whose offender is no longer a ship it can act on: each spawn handles
// one offender at a time, so only such a spawn is free for the next one.
function findIdleConcordSpawn(scene, responseMap, response, offenderEntity) {
  const idle = [...responseMap.values()].filter((other) => {
    if (other === response || getActiveResponderEntityIDs(scene, other).length === 0) {
      return false;
    }
    const target = resolveCurrentOffenderEntity(
      scene,
      toPositiveInt(other.offenderCharacterID, 0),
      toPositiveInt(other.offenderEntityID, 0),
    );
    return !target || (isCapsuleEntity(target) && !isCrimewatchConcordPodKillEnabled());
  });
  if (idle.length === 0) {
    return null;
  }
  const rows = idle.map((other) => ({
    response: other,
    distanceMeters: Math.min(...getActiveResponderEntityIDs(scene, other).map((entityID) => {
      const responder = scene.getEntityByID(entityID);
      return magnitude(subtractVectors(responder.position, offenderEntity.position));
    })),
  }));
  return rows.sort((left, right) => left.distanceMeters - right.distanceMeters)[0];
}

function retaskResponders(scene, offenderEntityID, responderEntityIDs, options = {}) {
  if (
    !scene ||
    !offenderEntityID ||
    !Array.isArray(responderEntityIDs) ||
    responderEntityIDs.length === 0
  ) {
    return 0;
  }

  const allowPodKill = options.allowPodKill === true;
  let retaskedCount = 0;
  for (const responderEntityID of responderEntityIDs) {
    const responderEntity = scene.getEntityByID(responderEntityID);
    if (!responderEntity) {
      continue;
    }
    const orderResult = getNpcRuntime().issueAttackOrder(
      responderEntityID,
      offenderEntityID,
      {
        allowWeapons: true,
        keepLock: true,
        allowPodKill,
      },
    );
    if (orderResult && orderResult.success) {
      retaskedCount += 1;
    }
  }

  return retaskedCount;
}

function resolveCurrentOffenderEntity(scene, offenderCharacterID, fallbackEntityID = 0) {
  if (!scene) {
    return null;
  }

  const liveSession =
    offenderCharacterID > 0
      ? sessionRegistry.findSessionByCharacterID(offenderCharacterID)
      : null;
  if (
    liveSession &&
    liveSession._space &&
    toPositiveInt(liveSession._space.systemID, 0) === toPositiveInt(scene.systemID, 0)
  ) {
    const sessionEntity = scene.getEntityByID(
      toPositiveInt(liveSession._space.shipID, 0),
    );
    if (sessionEntity) {
      return sessionEntity;
    }
  }

  if (offenderCharacterID > 0) {
    for (const entity of scene.dynamicEntities.values()) {
      if (
        toPositiveInt(entity && entity.pilotCharacterID, 0) === offenderCharacterID ||
        getEntityCharacterID(entity) === offenderCharacterID
      ) {
        return entity;
      }
    }
  }

  return scene.getEntityByID(toPositiveInt(fallbackEntityID, 0));
}

function restoreConcordResponsesForActiveCriminals(scene, now = Date.now()) {
  const systemID = toPositiveInt(scene && scene.systemID, 0);
  if (!scene || !systemID || !isHighSecuritySystem(scene.system)) {
    return 0;
  }

  let restoredCount = 0;
  for (const state of characterCrimewatchState.values()) {
    if (
      state.criminal !== true ||
      toFiniteNumber(state.criminalTimerExpiresAtMs, 0) <= now ||
      toPositiveInt(state.lastKnownSystemID, 0) !== systemID
    ) {
      continue;
    }

    const characterID = toPositiveInt(state.characterID, 0);
    const existingResponseMap = systemConcordResponses.get(systemID) || null;
    if (
      existingResponseMap &&
      [...existingResponseMap.values()].some(
        (response) =>
          toPositiveInt(response && response.offenderCharacterID, 0) ===
          characterID,
      )
    ) {
      continue;
    }

    const offenderEntity = resolveCurrentOffenderEntity(scene, characterID, 0);
    const directEntityCharacterID = toPositiveInt(
      offenderEntity && offenderEntity.session && (
        offenderEntity.session.characterID || offenderEntity.session.charID
      ),
      toPositiveInt(
        offenderEntity && (
          offenderEntity.pilotCharacterID || offenderEntity.characterID
        ),
        0,
      ),
    );
    // An owned wreck or deployable can resolve through ownerID as a player.
    // CONCORD recovery must only reacquire the pilot's live ship/capsule.
    if (!offenderEntity || directEntityCharacterID !== characterID) {
      continue;
    }

    const response = scheduleConcordResponse(
      scene,
      offenderEntity,
      now,
      offenderEntity,
    );
    if (!response) {
      continue;
    }
    const originalDueAtMs =
      toFiniteNumber(state.lastCriminalAtMs, 0) +
      getConcordResponseDispatchDelayMsForSystem(scene.system);
    if (originalDueAtMs > 0) {
      response.dueAtMs = Math.min(
        toFiniteNumber(response.dueAtMs, now),
        Math.max(now, originalDueAtMs),
      );
    }
    restoredCount += 1;
  }
  return restoredCount;
}

function tickScene(scene, now = Date.now()) {
  if (!scene) {
    return;
  }

  refreshModuleCombatActivities(scene, now);
  pruneAllCharacterStates(now);
  pruneExpiredLimitedEngagements(now);
  synchronizeSceneClientState(scene, now);

  if (!isHighSecuritySystem(scene.system)) {
    return;
  }

  if (!isCrimewatchConcordResponseEnabled()) {
    const disabledResponseMap = systemConcordResponses.get(toPositiveInt(scene.systemID, 0)) || null;
    if (disabledResponseMap) {
      for (const response of disabledResponseMap.values()) {
        clearConcordResponders(scene, response && response.responderEntityIDs);
      }
    }
    systemConcordResponses.delete(toPositiveInt(scene.systemID, 0));
    pruneSystemResponseMap(scene.systemID);
    return;
  }

  restoreConcordResponsesForActiveCriminals(scene, now);

  const responseMap = systemConcordResponses.get(toPositiveInt(scene.systemID, 0)) || null;
  if (!responseMap || responseMap.size === 0) {
    pruneSystemResponseMap(scene.systemID);
    return;
  }

  for (const [offenderEntityID, response] of responseMap.entries()) {
    const allowConcordPodKill = isCrimewatchConcordPodKillEnabled();
    const offenderCharacterID = toPositiveInt(response && response.offenderCharacterID, 0);
    const criminalActive = offenderCharacterID > 0 && isCharacterCriminal(offenderCharacterID, now);
    if (!criminalActive) {
      clearConcordResponders(scene, response && response.responderEntityIDs);
      responseMap.delete(offenderEntityID);
      continue;
    }

    const offenderEntity = resolveCurrentOffenderEntity(
      scene,
      offenderCharacterID,
      offenderEntityID,
    );
    response.responderEntityIDs = getActiveResponderEntityIDs(scene, response);
    if (
      offenderEntity &&
      response.responderEntityIDs.length === 0 &&
      toFiniteNumber(response.respondedAtMs, 0) <= 0 &&
      !(isCapsuleEntity(offenderEntity) && !allowConcordPodKill)
    ) {
      const idleSpawn = findIdleConcordSpawn(scene, responseMap, response, offenderEntity);
      if (idleSpawn && idleSpawn.distanceMeters <= CONCORD_RESPONSE_IDLE_SPAWN_RANGE_METERS) {
        response.responderEntityIDs = getActiveResponderEntityIDs(scene, idleSpawn.response);
        idleSpawn.response.responderEntityIDs = [];
        response.respondedAtMs = now;
        response.currentTargetEntityID = offenderEntity.itemID;
        retaskResponders(scene, offenderEntity.itemID, response.responderEntityIDs, {
          allowPodKill: allowConcordPodKill,
        });
        response.nextRetaskAtMs = now + CONCORD_RESPONSE_RETASK_INTERVAL_MS;
        continue;
      }
      if (idleSpawn && toFiniteNumber(response.dueAtMs, 0) <= now) {
        clearConcordResponders(scene, idleSpawn.response.responderEntityIDs);
        idleSpawn.response.responderEntityIDs = [];
        response.dueAtMs = now + CONCORD_RESPONSE_IDLE_SPAWN_RELOCATE_MS;
        continue;
      }
    }
    if (
      toFiniteNumber(response.respondedAtMs, 0) <= 0 &&
      toFiniteNumber(response.dueAtMs, 0) > now
    ) {
      continue;
    }

    if (!offenderEntity) {
      if (response.responderEntityIDs.length > 0) {
        stopResponders(scene, response.responderEntityIDs);
        if (allowConcordPodKill && response.capsuleTargeted === true) {
          if (toFiniteNumber(response.completionClearAtMs, 0) <= 0) {
            response.completionClearAtMs = now + CONCORD_RESPONSE_COMPLETION_CLEAR_MS;
          }
          if (toFiniteNumber(response.completionClearAtMs, 0) <= now) {
            clearConcordResponders(scene, response.responderEntityIDs);
            responseMap.delete(offenderEntityID);
            continue;
          }
        } else {
          response.completionClearAtMs = 0;
        }
      }
      response.ingressCompleteAtMs = 0;
      response.nextRetaskAtMs = now + CONCORD_RESPONSE_RETASK_INTERVAL_MS;
      continue;
    }

    if (response.responderEntityIDs.length === 0) {
      const spawnResult = spawnConcordResponders(
        scene,
        offenderEntity,
        response,
      );
      response.responderEntityIDs = Array.isArray(spawnResult && spawnResult.responderEntityIDs)
        ? spawnResult.responderEntityIDs
        : [];
      response.ingressCompleteAtMs = Math.max(
        0,
        Math.trunc(toFiniteNumber(spawnResult && spawnResult.ingressCompleteAtMs, 0)),
      );
      if (response.responderEntityIDs.length === 0) {
        response.dueAtMs = now + 1_000;
        response.ingressCompleteAtMs = 0;
        continue;
      }
      response.currentTargetEntityID = offenderEntity.itemID;
      response.completionClearAtMs = 0;
      response.capsuleTargeted = isCapsuleEntity(offenderEntity);
      if (!(response.capsuleTargeted && !allowConcordPodKill)) {
        // Seed the shared attack order immediately so the grouped wake coming
        // out of warp already knows which offender to chase. Without this,
        // responders wake with a blank controller state and only get their
        // target on a later Crimewatch retask tick.
        retaskResponders(scene, offenderEntity.itemID, response.responderEntityIDs, {
          allowPodKill: allowConcordPodKill,
        });
        const wakeAtMs = Math.max(
          now,
          toFiniteNumber(response.ingressCompleteAtMs, now),
        );
        for (const responderEntityID of response.responderEntityIDs) {
          getNpcRuntime().scheduleNpcController(responderEntityID, wakeAtMs);
        }
      }
      response.respondedAtMs = now;
      response.nextRetaskAtMs = now + CONCORD_RESPONSE_RETASK_INTERVAL_MS;
      continue;
    }

    if (toFiniteNumber(response.nextRetaskAtMs, 0) > now) {
      continue;
    }

    // The warp's estimate includes the deceleration curve's long tail, about 8 s
    // after the ship has really stopped. Acting on the estimate left the whole
    // response parked on grid, so it ends when the last responder lands.
    if (toFiniteNumber(response.ingressCompleteAtMs, 0) > now) {
      if (response.responderEntityIDs.some((responderEntityID) => (
        scene.getEntityByID(responderEntityID)?.mode === "WARP"
      ))) {
        response.nextRetaskAtMs = now + CONCORD_RESPONSE_RETASK_INTERVAL_MS;
        continue;
      }
      for (const responderEntityID of response.responderEntityIDs) {
        getNpcRuntime().scheduleNpcController(responderEntityID, now);
      }
    }

    response.currentTargetEntityID = offenderEntity.itemID;
    response.ingressCompleteAtMs = 0;
    response.completionClearAtMs = 0;
    if (isCapsuleEntity(offenderEntity)) {
      response.capsuleTargeted = true;
      if (!allowConcordPodKill) {
        stopResponders(scene, response.responderEntityIDs);
        response.nextRetaskAtMs = now + CONCORD_RESPONSE_RETASK_INTERVAL_MS;
        continue;
      }
    } else {
      response.capsuleTargeted = false;
    }

    retaskResponders(scene, offenderEntity.itemID, response.responderEntityIDs, {
      allowPodKill: allowConcordPodKill,
    });
    suppressOffenderDrones(scene, offenderEntity, response.responderEntityIDs);
    response.nextRetaskAtMs = now + CONCORD_RESPONSE_RETASK_INTERVAL_MS;
  }

  pruneSystemResponseMap(scene.systemID);
}

function getSceneTickDeadlineMs(scene, now = Date.now()) {
  if (!scene) {
    return null;
  }

  const systemID = toPositiveInt(scene.systemID, 0);
  if (!systemID) {
    return null;
  }

  if (!isHighSecuritySystem(scene.system)) {
    return null;
  }

  const normalizedNow = Math.max(0, Math.trunc(toFiniteNumber(now, Date.now())));
  const responseMap = systemConcordResponses.get(systemID) || null;
  if (!responseMap || responseMap.size === 0) {
    return null;
  }

  if (!isCrimewatchConcordResponseEnabled()) {
    return 0;
  }

  let nextDeadlineMs = null;
  for (const response of responseMap.values()) {
    if (!response || typeof response !== "object") {
      continue;
    }

    const dueAtMs = Math.max(0, Math.trunc(toFiniteNumber(response.dueAtMs, 0)));
    const respondedAtMs = Math.max(0, Math.trunc(toFiniteNumber(response.respondedAtMs, 0)));
    const ingressCompleteAtMs = Math.max(0, Math.trunc(toFiniteNumber(response.ingressCompleteAtMs, 0)));
    const nextRetaskAtMs = Math.max(0, Math.trunc(toFiniteNumber(response.nextRetaskAtMs, 0)));
    const completionClearAtMs = Math.max(0, Math.trunc(toFiniteNumber(response.completionClearAtMs, 0)));

    if (respondedAtMs <= 0 && dueAtMs > 0) {
      nextDeadlineMs =
        nextDeadlineMs === null || dueAtMs < nextDeadlineMs
          ? dueAtMs
          : nextDeadlineMs;
    }
    if (ingressCompleteAtMs > 0) {
      nextDeadlineMs =
        nextDeadlineMs === null || ingressCompleteAtMs < nextDeadlineMs
          ? ingressCompleteAtMs
          : nextDeadlineMs;
    }
    if (nextRetaskAtMs > 0) {
      nextDeadlineMs =
        nextDeadlineMs === null || nextRetaskAtMs < nextDeadlineMs
          ? nextRetaskAtMs
          : nextDeadlineMs;
    }
    if (completionClearAtMs > 0) {
      nextDeadlineMs =
        nextDeadlineMs === null || completionClearAtMs < nextDeadlineMs
          ? completionClearAtMs
          : nextDeadlineMs;
    }
  }

  if (nextDeadlineMs !== null && nextDeadlineMs <= normalizedNow) {
    return 0;
  }

  return nextDeadlineMs;
}

function isCriminallyFlagged(characterID, now = Date.now()) {
  return isCharacterCriminal(characterID, now);
}

function hasActiveWeaponTimer(characterID, now = Date.now()) {
  const normalizedCharacterID = toPositiveInt(characterID, 0);
  if (!normalizedCharacterID) {
    return false;
  }
  const state = getCharacterCrimewatchState(normalizedCharacterID, now);
  return Boolean(
    state && toFiniteNumber(state.weaponTimerExpiresAtMs, 0) > now,
  );
}

function resetCrimewatchRuntimeCacheForTests() {
  moduleCombatActivities.clear();
  characterCombatActivities.clear();
  characterCrimewatchState.clear();
  limitedEngagements.clear();
  ongoingLimitedEngagementKeys.clear();
  hydratedLimitedEngagementKeys.clear();
  allLimitedEngagementsHydrated = false;
  systemConcordResponses.clear();
  lastBroadcastTimerSnapshots.clear();
  lastBroadcastFlagSnapshots.clear();
  lastBroadcastDisapprovalSnapshots.clear();
  recentSecurityPenaltyTargets.clear();
}

function clearAllCrimewatchState() {
  resetCrimewatchRuntimeCacheForTests();
  return crimewatchRuntimeState.clearAll();
}

module.exports = {
  recordHomefrontIntrusion,
  SECURITY_STATUS_MIN,
  SECURITY_STATUS_MAX,
  SAFETY_LEVEL_NONE,
  SAFETY_LEVEL_PARTIAL,
  SAFETY_LEVEL_FULL,
  WEAPONS_TIMER_STATE_IDLE,
  WEAPONS_TIMER_STATE_ACTIVE,
  WEAPONS_TIMER_STATE_TIMER,
  PVP_TIMER_STATE_IDLE,
  PVP_TIMER_STATE_ACTIVE,
  PVP_TIMER_STATE_TIMER,
  CRIMINAL_TIMER_STATE_IDLE,
  CRIMINAL_TIMER_STATE_ACTIVE_CRIMINAL,
  CRIMINAL_TIMER_STATE_ACTIVE_SUSPECT,
  CRIMINAL_TIMER_STATE_TIMER_CRIMINAL,
  CRIMINAL_TIMER_STATE_TIMER_SUSPECT,
  NPC_TIMER_STATE_IDLE,
  NPC_TIMER_STATE_ACTIVE,
  NPC_TIMER_STATE_TIMER,
  DISAPPROVAL_TIMER_STATE_IDLE,
  DISAPPROVAL_TIMER_STATE_TIMER,
  WEAPON_TIMER_DURATION_MS,
  PVP_TIMER_DURATION_MS,
  NPC_TIMER_DURATION_MS,
  CRIMINAL_TIMER_DURATION_MS,
  DISAPPROVAL_TIMER_DURATION_MS,
  LIMITED_ENGAGEMENT_DURATION_MS,
  PENALTY_CONTRIBUTION_VERSION,
  buildClientStatesForSession,
  beginModuleCombatActivity,
  disposeSceneCombatActivities,
  endModuleCombatActivity,
  buildSystemCriminalFlagUpdatePayload,
  clearAllCrimewatchState,
  commitContainerTheft,
  compensateContainerTheft,
  createOrRefreshLimitedEngagement,
  createKillRightForCriminalAggression,
  evaluateContainerTheft,
  evaluateOffensiveAggression,
  getCharacterCrimewatchState,
  getCharacterSecurityStatus,
  getConcordResponseDelayMsForSystem,
  getConcordResponseDispatchDelayMsForSystem,
  getLimitedEngagement,
  getSafetyLevel,
  hasActiveLimitedEngagement,
  isHighSecuritySystem,
  isCrimewatchConcordPodKillEnabled,
  isCriminallyFlagged,
  hasActiveWeaponTimer,
  isLegalCorporationFriendlyFire,
  isPersonalDeployableEntity,
  isNpcAuthorityStructure,
  listLimitedEngagementsForCharacter,
  recordWeaponTimer,
  recordPvpActivity,
  recordContainerTheft,
  recordHighSecCriminalAggression,
  refreshLimitedEngagementForCombat,
  refreshLimitedEngagementForCombatEntities,
  resetCrimewatchRuntimeCacheForTests,
  scheduleConcordResponse,
  setCharacterSecurityStatus,
  setCharacterCrimewatchDebugState,
  setSafetyLevel,
  synchronizeSessionTimerNotifications,
  getSceneTickDeadlineMs,
  tickScene,
  triggerHighSecCriminalOffense,
};
