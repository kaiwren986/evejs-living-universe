"use strict";

const {
  cloneValue,
} = require("../../common/clone");

const path = require("path");

const worldData = require(path.join(__dirname, "../../space/worldData"));
const {
  toPublicSolarSystemID,
} = require("../../abyssal").engineSupport.hostLocation;
const {
  currentFileTime,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const {
  getAllianceCorporationIDs,
  getAllianceRecord,
  getCorporationRecord,
} = require(path.join(__dirname, "../corporation/corporationState"));
const {
  getAllianceRuntime,
} = require(path.join(__dirname, "../corporation/corporationRuntimeState"));
const {
  ATTRIBUTE_DEV_INDEX_INDUSTRIAL,
  ATTRIBUTE_DEV_INDEX_MILITARY,
  ATTRIBUTE_DEV_INDEX_SOVEREIGNTY,
  CAPITAL_SYSTEM_CHANGE_DELAY_MS,
  DEV_INDEX_LEVEL_WIDTH,
  STRATEGIC_INDEX_DAY_THRESHOLDS,
  CLAIM_DAYS_TO_SECONDS,
  FILETIME_EPOCH_OFFSET,
  FILETIME_TICKS_PER_MILLISECOND,
  PRIME_TIME_CHANGE_DELAY_MS,
  SOVEREIGNTY_RESET_MARKER,
  STRUCTURE_SCORE_UPDATED,
  TYPE_INFRASTRUCTURE_HUB,
  VULNERABILITY_WINDOW_BASE_HOURS,
} = require(path.join(__dirname, "./sovConstants"));
const {
  buildDefaultSovereigntyTable,
  cloneValue: cloneStoreValue,
  maySovereigntyPersist,
  readSovereigntyTable,
  readSovereigntyTableUpdatedAt,
  writeSovereigntyTable,
} = require(path.join(__dirname, "./sovStore"));
const {
  broadcastSolarSystemDevIndexChanged,
  broadcastSolarSystemSovStructuresUpdated,
  broadcastCapitalSystemChanged,
  broadcastSovereigntyAudioEvent,
  broadcastSovereigntyChanged,
  broadcastSovHubHacked,
} = require(path.join(__dirname, "./sovNotifications"));
const {
  clearAllSovereigntyRelatedStructures,
  clearAllSovereigntyStructureMirrors,
  syncSovereigntyStructureRuntime,
} = require(path.join(__dirname, "./sovSpaceInterop"));

let tableCache = null;
let indexCache = null;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MILITARY_INDEX_TO_BONUS = { 1: 0.6, 2: 1.2, 3: 1.7, 4: 2.1, 5: 2.5 };
const INDUSTRIAL_INDEX_TO_BONUS = { 1: 0.6, 2: 1.2, 3: 1.7, 4: 2.1, 5: 2.5 };
const STRATEGIC_INDEX_TO_BONUS = { 1: 0.4, 2: 0.6, 3: 0.8, 4: 0.9, 5: 1.0 };
const CAPITAL_BONUS = 2.0;
const BASE_BONUS = 1.0;
const MIN_OCCUPANCY_BONUS = 1.0;
const MAX_OCCUPANCY_BONUS = 6.0;
const TYPE_SOVEREIGNTY_COMMAND_NODE = 34832;
const SOVEREIGNTY_COMMAND_NODE_SCORE_DELTA = 0.07;
const MAX_SOVEREIGNTY_COMMAND_NODES_PER_EVENT = 10;
const MAX_SOVEREIGNTY_COMMAND_NODES_PER_SYSTEM = 5;
const MAX_SOVEREIGNTY_COMMAND_NODES_PER_CONSTELLATION = 20;

function valuesEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeInteger(value, fallback = 0) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return fallback;
  }
  return Math.trunc(numericValue);
}

function normalizeNumber(value, fallback = 0) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : fallback;
}

function normalizePositiveInteger(value, fallback = null) {
  const numericValue = normalizeInteger(value, 0);
  return numericValue > 0 ? numericValue : fallback;
}

function normalizeNullablePositiveInteger(value, fallback = null) {
  if (value === null) {
    return null;
  }
  if (value === undefined) {
    return fallback;
  }
  return normalizePositiveInteger(value, fallback);
}

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") {
      return true;
    }
    if (normalized === "false" || normalized === "0") {
      return false;
    }
  }
  return Boolean(value);
}

function normalizeSpacePoint(value, fallback = null) {
  if (!value || typeof value !== "object") {
    return fallback;
  }
  const x = Number(value.x);
  const y = Number(value.y);
  const z = Number(value.z);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    return fallback;
  }
  return { x, y, z };
}

function normalizeFiletimeString(value, fallback = "0") {
  if (typeof value === "string" && value.trim() !== "") {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  return fallback;
}

function normalizeFiletimeBigInt(value, fallback = 0n) {
  try {
    return BigInt(normalizeFiletimeString(value, fallback.toString()));
  } catch (error) {
    return fallback;
  }
}

function filetimeToUnixMs(value, fallback = 0) {
  const filetime = normalizeFiletimeBigInt(value, 0n);
  if (filetime <= FILETIME_EPOCH_OFFSET) {
    return fallback;
  }
  return Number((filetime - FILETIME_EPOCH_OFFSET) / FILETIME_TICKS_PER_MILLISECOND);
}

function unixMsToFiletimeString(value, fallback = "0") {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return fallback;
  }
  return (
    FILETIME_EPOCH_OFFSET +
    BigInt(Math.trunc(numericValue)) * FILETIME_TICKS_PER_MILLISECOND
  ).toString();
}

function addMillisecondsToCurrentFiletime(milliseconds) {
  const numericMilliseconds = Math.max(0, normalizeInteger(milliseconds, 0));
  return (
    currentFileTime() +
    BigInt(numericMilliseconds) * FILETIME_TICKS_PER_MILLISECOND
  ).toString();
}

function normalizePrimeHour(value, fallback = 0) {
  const hour = normalizeInteger(value, fallback);
  if (hour < 0) {
    return 0;
  }
  if (hour > 23) {
    return 23;
  }
  return hour;
}

function compareNumericStringsDescending(left, right) {
  try {
    const leftValue = BigInt(normalizeFiletimeString(left, "0"));
    const rightValue = BigInt(normalizeFiletimeString(right, "0"));
    if (leftValue > rightValue) {
      return -1;
    }
    if (leftValue < rightValue) {
      return 1;
    }
  } catch (error) {
    const leftValue = normalizeTextNumber(left);
    const rightValue = normalizeTextNumber(right);
    if (leftValue > rightValue) {
      return -1;
    }
    if (leftValue < rightValue) {
      return 1;
    }
  }
  return 0;
}

function normalizeTextNumber(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : 0;
}

function normalizeScoresByTeam(value) {
  const normalized = {};
  if (!value || typeof value !== "object") {
    return normalized;
  }
  for (const [teamID, score] of Object.entries(value)) {
    const numericTeamID = normalizeInteger(teamID, 0);
    if (numericTeamID === 0) {
      continue;
    }
    normalized[String(numericTeamID)] = normalizeNumber(score, 0);
  }
  return normalized;
}

function normalizeNullableTeamID(value, fallback = null) {
  if (value === null) {
    return null;
  }
  if (value === undefined) {
    return fallback;
  }
  const teamID = normalizeInteger(value, 0);
  return teamID === 0 ? fallback : teamID;
}

function normalizeCaptureCompletionReceipt(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const captureEpoch = String(value.captureEpoch || "").trim();
  const winnerAllianceID = normalizePositiveInteger(
    value.winnerAllianceID,
    null,
  );
  const executorCorporationID = normalizePositiveInteger(
    value.executorCorporationID,
    null,
  );
  if (!captureEpoch || !winnerAllianceID || !executorCorporationID) {
    return null;
  }
  const status = String(value.status || "prepared").trim().toLowerCase();
  return {
    captureEpoch,
    winnerAllianceID,
    executorCorporationID,
    status: status === "completed" ? "completed" : "prepared",
    preparedAtTime: normalizeFiletimeString(value.preparedAtTime, "0"),
    claimTime: normalizeFiletimeString(
      value.claimTime,
      normalizeFiletimeString(value.preparedAtTime, "0"),
    ),
    completedAtTime: normalizeFiletimeString(value.completedAtTime, "0"),
  };
}

function buildCampaignOutcomeReceiptKey(targetID, campaignEpoch) {
  return `${normalizePositiveInteger(targetID, 0)}:${String(campaignEpoch || "").trim()}`;
}

function normalizeHubLossDropItem(value) {
  const typeID = normalizePositiveInteger(value && value.typeID, null);
  if (!typeID) {
    return null;
  }
  return {
    kind: String(value.kind || ""),
    typeID,
    quantity: Math.max(0, normalizeInteger(value.quantity, 0)),
    dropped: Math.max(0, normalizeInteger(value.dropped, 0)),
    destroyed: Math.max(0, normalizeInteger(value.destroyed, 0)),
    error: value.error ? String(value.error) : null,
  };
}

// What a Hub lost to attackers dropped: the wreck (or container) and every
// stack's roll. Recorded on the outcome receipt so a replay never rolls or
// drops twice.
function normalizeHubLossDrop(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  return {
    seed: String(value.seed || ""),
    containerID: normalizePositiveInteger(value.containerID, null),
    containerTypeID: normalizePositiveInteger(value.containerTypeID, null),
    items: (Array.isArray(value.items) ? value.items : [])
      .map((entry) => normalizeHubLossDropItem(entry))
      .filter(Boolean),
    error: value.error ? String(value.error) : null,
  };
}

function normalizeCampaignOutcomeReceipt(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const targetID = normalizePositiveInteger(value.targetID, null);
  const solarSystemID = normalizePositiveInteger(value.solarSystemID, null);
  const campaignEpoch = String(value.campaignEpoch || "").trim();
  const defenderAllianceID = normalizePositiveInteger(
    value.defenderAllianceID,
    null,
  );
  const result = String(value.result || "").trim().toLowerCase();
  if (
    !targetID ||
    !solarSystemID ||
    !campaignEpoch ||
    !defenderAllianceID ||
    (result !== "attacker" && result !== "defender")
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    targetID,
    solarSystemID,
    campaignEpoch,
    defenderAllianceID,
    result,
    completedAtTime: normalizeFiletimeString(value.completedAtTime, "0"),
    destroyedNotificationDeliveredAtTime: normalizeFiletimeString(
      value.destroyedNotificationDeliveredAtTime,
      "0",
    ),
    nodeIDs: [
      ...new Set(
        (Array.isArray(value.nodeIDs) ? value.nodeIDs : [])
          .map((entry) => normalizePositiveInteger(entry, null))
          .filter(Boolean),
      ),
    ].sort((left, right) => left - right),
    drop: normalizeHubLossDrop(value.drop),
  };
}

function normalizeCampaignOutcomeReceipts(value) {
  const normalized = {};
  if (!value || typeof value !== "object") {
    return normalized;
  }
  for (const receipt of Object.values(value)) {
    const candidate = normalizeCampaignOutcomeReceipt(receipt);
    if (!candidate) {
      continue;
    }
    normalized[
      buildCampaignOutcomeReceiptKey(candidate.targetID, candidate.campaignEpoch)
    ] = candidate;
  }
  return normalized;
}

function normalizeCommandNodeCaptureReceipt(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const sourceSolarSystemID = normalizePositiveInteger(
    value.sourceSolarSystemID,
    null,
  );
  const targetID = normalizePositiveInteger(value.targetID, null);
  const nodeID = normalizePositiveInteger(value.nodeID, null);
  const campaignEpoch = String(value.campaignEpoch || "").trim();
  const winnerAllianceID = normalizePositiveInteger(
    value.winnerAllianceID,
    null,
  );
  const defenderAllianceID = normalizePositiveInteger(
    value.defenderAllianceID,
    null,
  );
  const scoreDelta = normalizeNumber(value.scoreDelta, Number.NaN);
  if (
    !sourceSolarSystemID ||
    !targetID ||
    !nodeID ||
    !campaignEpoch ||
    !winnerAllianceID ||
    !defenderAllianceID ||
    !Number.isFinite(scoreDelta)
  ) {
    return null;
  }
  const result = String(value.result || "").trim().toLowerCase();
  return {
    schemaVersion: 1,
    sourceSolarSystemID,
    targetID,
    campaignEpoch,
    nodeID,
    winnerAllianceID,
    winnerTeamID: normalizeNullableTeamID(value.winnerTeamID, null),
    defenderAllianceID,
    scoreDelta,
    defenderScoreBefore: normalizeNumber(value.defenderScoreBefore, 0),
    defenderScoreAfter: normalizeNumber(value.defenderScoreAfter, 0),
    attackerScoreAfter: normalizeNumber(value.attackerScoreAfter, 0),
    replacementNodeID: normalizeNullablePositiveInteger(
      value.replacementNodeID,
      null,
    ),
    replacementSolarSystemID: normalizeNullablePositiveInteger(
      value.replacementSolarSystemID,
      null,
    ),
    completedAtTime: normalizeFiletimeString(value.completedAtTime, "0"),
    result: result === "attacker" || result === "defender" ? result : null,
  };
}

function normalizeEntosisCapture(value, fallbackEpoch = "") {
  if (!value || typeof value !== "object") {
    return null;
  }
  const rate = normalizeNumber(value.scoringRate, 0);
  const blockedReason = String(value.completionBlockedReason || "").trim();
  return {
    schemaVersion: 1,
    captureEpoch:
      String(value.captureEpoch || fallbackEpoch || "").trim() || null,
    controllingTeamID: normalizeNullableTeamID(
      value.controllingTeamID,
      null,
    ),
    scoringTeamID: normalizeNullableTeamID(
      value.scoringTeamID,
      null,
    ),
    scoreAtLastUpdateTime: Math.max(
      0,
      Math.min(1, normalizeNumber(value.scoreAtLastUpdateTime, 0)),
    ),
    lastUpdatedScoreTime: normalizeFiletimeString(
      value.lastUpdatedScoreTime,
      "0",
    ),
    scoringRate: Number.isFinite(rate) ? rate : 0,
    isBlocked: normalizeBoolean(value.isBlocked, false),
    defenderTeamID: normalizePositiveInteger(value.defenderTeamID, 1),
    completionCandidateAllianceID: normalizeNullablePositiveInteger(
      value.completionCandidateAllianceID,
      null,
    ),
    completionBlockedReason: blockedReason || null,
    completionReceipt: normalizeCaptureCompletionReceipt(
      value.completionReceipt,
    ),
  };
}

function normalizeStructureRecord(value = {}, solarSystemID, fallbackAllianceID, fallbackCorporationID) {
  const typeID = normalizePositiveInteger(value.typeID, null);
  const itemID = normalizePositiveInteger(value.itemID || value.structureID, null);
  if (!typeID || !itemID) {
    return null;
  }
  const devFlags =
    value.devFlags && typeof value.devFlags === "object"
      ? cloneValue(value.devFlags)
      : {};
  const isExplicitNeutralHub = Boolean(
    devFlags.sovereigntyCaptured !== true &&
      (
        devFlags.sovereigntyNeutralHub === true ||
        (
          typeID === TYPE_INFRASTRUCTURE_HUB &&
          normalizePositiveInteger(value.ownerID, null) === 1000132 &&
          normalizePositiveInteger(value.corporationID, null) === 1000132 &&
          normalizePositiveInteger(value.allianceID, null) == null
        )
      ),
  );
  const corporationID = isExplicitNeutralHub
    ? normalizePositiveInteger(value.corporationID, 1000132)
    : normalizePositiveInteger(value.corporationID, fallbackCorporationID);
  const allianceID = isExplicitNeutralHub
    ? null
    : normalizePositiveInteger(value.allianceID, fallbackAllianceID);
  const captureEpoch = String(
    devFlags.sovereigntyCaptureEpoch || "",
  ).trim();
  return {
    itemID,
    typeID,
    name: String(value.name || "").trim() || null,
    solarSystemID,
    ownerID: isExplicitNeutralHub
      ? normalizePositiveInteger(value.ownerID, 1000132)
      : normalizePositiveInteger(value.ownerID, corporationID),
    corporationID,
    allianceID,
    defenseMultiplier: normalizeNumber(value.defenseMultiplier, 1),
    campaignEventType: normalizeInteger(value.campaignEventType, 0),
    campaignStartTime: normalizeFiletimeString(value.campaignStartTime, "0"),
    campaignOccupancyLevel: normalizeNumber(value.campaignOccupancyLevel, 1),
    campaignScoresByTeam: normalizeScoresByTeam(value.campaignScoresByTeam),
    campaignSourceInfo:
      Array.isArray(value.campaignSourceInfo) && value.campaignSourceInfo.length >= 4
        ? value.campaignSourceInfo.slice(0, 4).map((entry) => normalizeInteger(entry, 0))
        : null,
    vulnerableStartTime: normalizeFiletimeString(value.vulnerableStartTime, "0"),
    vulnerableEndTime: normalizeFiletimeString(value.vulnerableEndTime, "0"),
    vulnerabilityOccupancyLevel: normalizeNumber(
      value.vulnerabilityOccupancyLevel,
      1,
    ),
    isCapital: normalizeBoolean(value.isCapital, false),
    position: normalizeSpacePoint(value.position, null),
    ...(Object.prototype.hasOwnProperty.call(value, "devFlags")
      ? { devFlags }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(value, "entosisCapture")
      ? {
          entosisCapture: normalizeEntosisCapture(
            value.entosisCapture,
            captureEpoch,
          ),
        }
      : {}),
  };
}

function normalizeDevIndices(value = {}) {
  const militaryPoints = Math.max(0, normalizeInteger(value.militaryPoints, 0));
  const industrialPoints = Math.max(0, normalizeInteger(value.industrialPoints, 0));
  const claimedForDays = Math.max(
    0,
    normalizeInteger(value.claimedForDays ?? value.claimedFor, 0),
  );
  const militaryIncreasing = normalizeBoolean(value.militaryIncreasing, false);
  const industrialIncreasing = normalizeBoolean(value.industrialIncreasing, false);
  return {
    militaryPoints,
    industrialPoints,
    claimedForDays,
    militaryIncreasing,
    industrialIncreasing,
  };
}

function getOperationalIndexLevel(points) {
  const normalizedPoints = Math.max(0, normalizeInteger(points, 0));
  if (normalizedPoints >= DEV_INDEX_LEVEL_WIDTH * 6) {
    return 5;
  }
  for (let level = 0; level <= 5; level += 1) {
    if (normalizedPoints < DEV_INDEX_LEVEL_WIDTH * (level + 1)) {
      return level;
    }
  }
  return 5;
}

function getStrategicIndexLevel(claimedForDays) {
  const normalizedDays = Math.max(0, normalizeInteger(claimedForDays, 0));
  for (let index = STRATEGIC_INDEX_DAY_THRESHOLDS.length - 1; index >= 0; index -= 1) {
    if (normalizedDays >= STRATEGIC_INDEX_DAY_THRESHOLDS[index]) {
      return index + 1;
    }
  }
  return 0;
}

/**
 * Settle the strategic index from a claimed Hub's authoritative capture time.
 *
 * The capture path records `claimTime` at the exact simulation instant that
 * Entosis commits ownership. Claim age is otherwise not represented by a
 * recurring counter, so derive whole days from that durable timestamp whenever
 * the sovereignty scene ticks. Keeping the existing value when it is ahead
 * preserves deliberate migration and administrative index settings.
 */
function tickStrategicClaimAge(solarSystemID, nowMs = Date.now()) {
  const numericSolarSystemID = normalizePositiveInteger(solarSystemID, null);
  const system = numericSolarSystemID
    ? getSystemState(numericSolarSystemID)
    : null;
  if (
    !system ||
    !normalizePositiveInteger(system.allianceID, null) ||
    !normalizePositiveInteger(system.infrastructureHubID, null)
  ) {
    return { success: true, data: { changed: false } };
  }

  const claimAtMs = filetimeToUnixMs(system.claimTime, 0);
  const currentDays = normalizeDevIndices(system.devIndices).claimedForDays;
  const resolvedNowMs = normalizeInteger(nowMs, Date.now());
  if (!claimAtMs || resolvedNowMs < claimAtMs) {
    return { success: true, data: { changed: false, claimedForDays: currentDays } };
  }

  const maxDays = STRATEGIC_INDEX_DAY_THRESHOLDS[STRATEGIC_INDEX_DAY_THRESHOLDS.length - 1];
  const elapsedDays = Math.min(
    maxDays,
    Math.floor((resolvedNowMs - claimAtMs) / DAY_MS),
  );
  if (elapsedDays <= currentDays) {
    return { success: true, data: { changed: false, claimedForDays: currentDays } };
  }

  const next = upsertSystemState(numericSolarSystemID, {
    devIndices: {
      ...system.devIndices,
      claimedForDays: elapsedDays,
    },
  }, {
    suppressStructureSync: true,
  });
  return {
    success: Boolean(next),
    errorMsg: next ? null : "SOVEREIGNTY_SYSTEM_NOT_FOUND",
    data: {
      changed: Boolean(next),
      claimedForDays: elapsedDays,
    },
  };
}

function getSystemDefenseMultiplier(system = null, isCapital = false) {
  const devIndices = normalizeDevIndices(system && system.devIndices);
  const militaryLevel = getOperationalIndexLevel(devIndices.militaryPoints);
  const industrialLevel = getOperationalIndexLevel(devIndices.industrialPoints);
  const strategicLevel = getStrategicIndexLevel(devIndices.claimedForDays);
  const totalBonus =
    BASE_BONUS +
    (MILITARY_INDEX_TO_BONUS[militaryLevel] || 0) +
    (INDUSTRIAL_INDEX_TO_BONUS[industrialLevel] || 0) +
    (STRATEGIC_INDEX_TO_BONUS[strategicLevel] || 0) +
    (isCapital ? CAPITAL_BONUS : 0);
  return Math.max(MIN_OCCUPANCY_BONUS, Math.min(MAX_OCCUPANCY_BONUS, totalBonus));
}

// Capital changes found while the table is being normalised or written are
// sent once the current synchronous write has finished. Only the process that
// owns the durable row reports them: a passive copy re-applies the same lazy
// promotion on every reload.
let pendingCapitalChanges = [];
let capitalChangeFlushScheduled = false;

function flushCapitalSystemChanges() {
  capitalChangeFlushScheduled = false;
  const changes = pendingCapitalChanges;
  pendingCapitalChanges = [];
  for (const change of changes) {
    try {
      broadcastCapitalSystemChanged(change.allianceID, change.oldSolarSystemID, change.newSolarSystemID);
    } catch (error) {
      // ignored: a failed notice must not affect the committed capital change
    }
  }
}

function queueCapitalSystemChange(allianceID, oldSolarSystemID, newSolarSystemID) {
  const numericAllianceID = normalizePositiveInteger(allianceID, null);
  const oldID = normalizePositiveInteger(oldSolarSystemID, null);
  const newID = normalizePositiveInteger(newSolarSystemID, null);
  if (!numericAllianceID || oldID === newID || !maySovereigntyPersist()) {
    return;
  }
  pendingCapitalChanges.push({
    allianceID: numericAllianceID,
    oldSolarSystemID: oldID,
    newSolarSystemID: newID,
  });
  if (!capitalChangeFlushScheduled) {
    capitalChangeFlushScheduled = true;
    setImmediate(flushCapitalSystemChanges);
  }
}

function applyAllianceTimedTransitions(allianceState) {
  if (!allianceState || typeof allianceState !== "object") {
    return false;
  }
  let changed = false;
  const now = currentFileTime();
  const primeValidAfter = normalizeFiletimeBigInt(
    allianceState.primeInfo && allianceState.primeInfo.newPrimeHourValidAfter,
    0n,
  );
  if (
    allianceState.primeInfo &&
    normalizePrimeHour(allianceState.primeInfo.newPrimeHour, 0) >= 0 &&
    primeValidAfter > 0n &&
    primeValidAfter <= now
  ) {
    allianceState.primeInfo.currentPrimeHour = normalizePrimeHour(
      allianceState.primeInfo.newPrimeHour,
      allianceState.primeInfo.currentPrimeHour,
    );
    allianceState.primeInfo.newPrimeHour = allianceState.primeInfo.currentPrimeHour;
    allianceState.primeInfo.newPrimeHourValidAfter = "0";
    changed = true;
  }
  const capitalValidAfter = normalizeFiletimeBigInt(
    allianceState.capitalInfo && allianceState.capitalInfo.newCapitalSystemValidAfter,
    0n,
  );
  if (
    allianceState.capitalInfo &&
    allianceState.capitalInfo.newCapitalSystem &&
    capitalValidAfter > 0n &&
    capitalValidAfter <= now
  ) {
    const previousCapitalSystem = allianceState.capitalInfo.currentCapitalSystem;
    allianceState.capitalInfo.currentCapitalSystem = normalizePositiveInteger(
      allianceState.capitalInfo.newCapitalSystem,
      allianceState.capitalInfo.currentCapitalSystem,
    );
    queueCapitalSystemChange(
      allianceState.allianceID,
      previousCapitalSystem,
      allianceState.capitalInfo.currentCapitalSystem,
    );
    allianceState.capitalInfo.newCapitalSystem = null;
    allianceState.capitalInfo.newCapitalSystemValidAfter = "0";
    changed = true;
  }
  return changed;
}

function getStaticSystemLocationInfo(solarSystemID) {
  const staticSystem =
    worldData.ensureLoaded().solarSystemsById.get(Number(solarSystemID)) || null;
  return {
    solarSystemID: normalizePositiveInteger(
      staticSystem && staticSystem.solarSystemID,
      normalizePositiveInteger(solarSystemID, null),
    ),
    constellationID: normalizePositiveInteger(
      staticSystem && staticSystem.constellationID,
      null,
    ),
    regionID: normalizePositiveInteger(staticSystem && staticSystem.regionID, null),
  };
}

function buildDerivedCurrentDataRecord(system = null, solarSystemID = null) {
  const locationInfo = getStaticSystemLocationInfo(
    solarSystemID || (system && system.solarSystemID),
  );
  const ownerID = normalizePositiveInteger(system && system.allianceID, null);
  return {
    locationID: locationInfo.solarSystemID,
    solarSystemID: locationInfo.solarSystemID,
    constellationID: locationInfo.constellationID,
    regionID: locationInfo.regionID,
    ownerID,
    allianceID: ownerID,
    corporationID: normalizePositiveInteger(system && system.corporationID, null),
    claimStructureID: normalizePositiveInteger(
      system && system.claimStructureID,
      null,
    ),
    infrastructureHubID: normalizePositiveInteger(
      system && system.infrastructureHubID,
      null,
    ),
    stationID: null,
    claimTime: normalizeFiletimeString(system && system.claimTime, "0"),
  };
}

function normalizeCurrentDataRecord(value = {}, solarSystemID, system = null) {
  const fallback = buildDerivedCurrentDataRecord(system, solarSystemID);
  const ownerSource = Object.prototype.hasOwnProperty.call(value, "ownerID")
    ? value.ownerID
    : Object.prototype.hasOwnProperty.call(value, "allianceID")
      ? value.allianceID
      : fallback.ownerID;
  const ownerID = normalizeNullablePositiveInteger(
    ownerSource,
    fallback.ownerID,
  );
  const allianceSource = Object.prototype.hasOwnProperty.call(value, "allianceID")
    ? value.allianceID
    : Object.prototype.hasOwnProperty.call(value, "ownerID")
      ? value.ownerID
      : ownerID;
  const allianceID = normalizeNullablePositiveInteger(
    allianceSource,
    ownerID,
  );
  return {
    locationID: normalizePositiveInteger(value.locationID, fallback.locationID),
    solarSystemID: normalizePositiveInteger(value.solarSystemID, fallback.solarSystemID),
    constellationID: normalizePositiveInteger(
      value.constellationID,
      fallback.constellationID,
    ),
    regionID: normalizePositiveInteger(value.regionID, fallback.regionID),
    ownerID,
    allianceID,
    corporationID: normalizePositiveInteger(
      value.corporationID,
      fallback.corporationID,
    ),
    claimStructureID: normalizePositiveInteger(
      value.claimStructureID,
      fallback.claimStructureID,
    ),
    infrastructureHubID: normalizePositiveInteger(
      value.infrastructureHubID,
      fallback.infrastructureHubID,
    ),
    stationID: normalizePositiveInteger(value.stationID, fallback.stationID),
    claimTime: normalizeFiletimeString(value.claimTime, fallback.claimTime),
  };
}

function normalizeRecentActivityRecord(value = {}, solarSystemID, system = null) {
  const locationInfo = getStaticSystemLocationInfo(
    solarSystemID || (system && system.solarSystemID),
  );
  const ownerSource = Object.prototype.hasOwnProperty.call(value, "ownerID")
    ? value.ownerID
    : Object.prototype.hasOwnProperty.call(value, "allianceID")
      ? value.allianceID
      : normalizePositiveInteger(system && system.allianceID, null);
  return {
    solarSystemID: normalizePositiveInteger(
      value.solarSystemID,
      locationInfo.solarSystemID,
    ),
    ownerID: normalizeNullablePositiveInteger(
      ownerSource,
      normalizePositiveInteger(system && system.allianceID, null),
    ),
    oldOwnerID: normalizeNullablePositiveInteger(value.oldOwnerID, null),
    stationID: normalizeNullablePositiveInteger(value.stationID, null),
    changeTime: normalizeFiletimeString(value.changeTime, "0"),
  };
}

function normalizeAllianceCapitalInfo(value = {}, fallback = {}) {
  const currentCapitalSystem = toPublicSolarSystemID(
    value && value.currentCapitalSystem,
    fallback && fallback.currentCapitalSystem,
  );
  const newCapitalSystem = toPublicSolarSystemID(
    value && value.newCapitalSystem,
    fallback && fallback.newCapitalSystem,
  );
  return {
    currentCapitalSystem,
    newCapitalSystem,
    newCapitalSystemValidAfter: newCapitalSystem
      ? normalizeFiletimeString(
          value && value.newCapitalSystemValidAfter,
          fallback && fallback.newCapitalSystemValidAfter,
        )
      : "0",
  };
}

function buildDefaultAllianceState(allianceID) {
  const runtime = allianceID ? getAllianceRuntime(allianceID) || {} : {};
  return {
    allianceID: normalizePositiveInteger(allianceID, null),
    primeInfo: {
      currentPrimeHour: normalizeInteger(
        runtime.primeInfo && runtime.primeInfo.currentPrimeHour,
        0,
      ),
      newPrimeHour: normalizeInteger(runtime.primeInfo && runtime.primeInfo.newPrimeHour, 0),
      newPrimeHourValidAfter: normalizeFiletimeString(
        runtime.primeInfo && runtime.primeInfo.newPrimeHourValidAfter,
        "0",
      ),
    },
    capitalInfo: normalizeAllianceCapitalInfo(runtime.capitalInfo),
  };
}

function normalizeAllianceState(value = {}, allianceID) {
  const fallback = buildDefaultAllianceState(allianceID);
  return {
    allianceID: normalizePositiveInteger(allianceID, fallback.allianceID),
    primeInfo: {
      currentPrimeHour: normalizeInteger(
        value.primeInfo && value.primeInfo.currentPrimeHour,
        fallback.primeInfo.currentPrimeHour,
      ),
      newPrimeHour: normalizeInteger(
        value.primeInfo && value.primeInfo.newPrimeHour,
        fallback.primeInfo.newPrimeHour,
      ),
      newPrimeHourValidAfter: normalizeFiletimeString(
        value.primeInfo && value.primeInfo.newPrimeHourValidAfter,
        fallback.primeInfo.newPrimeHourValidAfter,
      ),
    },
    capitalInfo: normalizeAllianceCapitalInfo(
      value.capitalInfo,
      fallback.capitalInfo,
    ),
  };
}

function normalizeSystemState(value = {}, solarSystemID) {
  const numericSolarSystemID = normalizePositiveInteger(solarSystemID, 0) || 0;
  const hasAllianceIDField = Object.prototype.hasOwnProperty.call(value, "allianceID");
  const hasCorporationIDField = Object.prototype.hasOwnProperty.call(
    value,
    "corporationID",
  );
  const hasInfrastructureHubField = Object.prototype.hasOwnProperty.call(
    value,
    "infrastructureHubID",
  );
  let allianceID = normalizePositiveInteger(value.allianceID, null);
  let corporationID = normalizePositiveInteger(value.corporationID, null);
  let structures = Array.isArray(value.structures)
    ? value.structures
        .map((entry) =>
          normalizeStructureRecord(entry, numericSolarSystemID, allianceID, corporationID),
        )
        .filter(Boolean)
    : [];
  const iHubStructure = structures.find(
    (entry) => entry.typeID === TYPE_INFRASTRUCTURE_HUB,
  );
  if (!hasAllianceIDField && !allianceID) {
    allianceID = normalizePositiveInteger(iHubStructure && iHubStructure.allianceID, null);
  }
  if (!hasCorporationIDField && !corporationID) {
    corporationID = normalizePositiveInteger(iHubStructure && iHubStructure.corporationID, null);
  }
  if (allianceID || corporationID) {
    structures = structures
      .map((entry) =>
        normalizeStructureRecord(entry, numericSolarSystemID, allianceID, corporationID),
      )
      .filter(Boolean);
  }
  return {
    solarSystemID: numericSolarSystemID,
    allianceID,
    corporationID,
    // The Hub is the claim. A record without a claim index has no claim;
    // no other structure stands in for one.
    claimStructureID: normalizePositiveInteger(value.claimStructureID, null),
    infrastructureHubID: hasInfrastructureHubField
      ? normalizePositiveInteger(value.infrastructureHubID, null)
      : normalizePositiveInteger(
          value.infrastructureHubID,
          iHubStructure && iHubStructure.itemID,
        ),
    claimTime: normalizeFiletimeString(value.claimTime, "0"),
    fuelAccessGroupID: normalizePositiveInteger(value.fuelAccessGroupID, null),
    devIndices: normalizeDevIndices(value.devIndices),
    campaignOutcomeReceipts: normalizeCampaignOutcomeReceipts(
      value.campaignOutcomeReceipts,
    ),
    structureDestructionReceipts: cloneValue(value.structureDestructionReceipts || {}),
    structures,
    recentActivity: Array.isArray(value.recentActivity)
      ? value.recentActivity
          .map((entry) =>
            normalizeRecentActivityRecord(
              entry,
              numericSolarSystemID,
              value,
            ),
          )
          .filter(Boolean)
      : [],
    currentData: Array.isArray(value.currentData)
      ? value.currentData
          .map((entry) =>
            normalizeCurrentDataRecord(
              entry,
              numericSolarSystemID,
              value,
            ),
          )
          .filter(Boolean)
      : [],
  };
}

function buildDefaultTable() {
  return buildDefaultSovereigntyTable();
}

function normalizeTable(table = {}) {
  const normalized = buildDefaultTable();
  normalized._meta.updatedAt =
    table && table._meta && table._meta.updatedAt ? table._meta.updatedAt : null;
  if (table && table._meta && table._meta[SOVEREIGNTY_RESET_MARKER]) {
    normalized._meta[SOVEREIGNTY_RESET_MARKER] = cloneStoreValue(
      table._meta[SOVEREIGNTY_RESET_MARKER],
    );
  }
  normalized.hubs = cloneStoreValue(table && table.hubs ? table.hubs : {});
  normalized.skyhooks = cloneStoreValue(table && table.skyhooks ? table.skyhooks : {});
  normalized.mercenaryDens = cloneStoreValue(
    table && table.mercenaryDens ? table.mercenaryDens : {},
  );
  normalized.resources = cloneStoreValue(
    table && table.resources ? table.resources : normalized.resources,
  );
  for (const [allianceID, record] of Object.entries(table.alliances || {})) {
    const numericAllianceID = normalizePositiveInteger(allianceID, null);
    if (!numericAllianceID || !getAllianceRecord(numericAllianceID)) {
      continue;
    }
    normalized.alliances[String(numericAllianceID)] = normalizeAllianceState(
      record,
      numericAllianceID,
    );
  }
  for (const [solarSystemID, record] of Object.entries(table.systems || {})) {
    const numericSolarSystemID = normalizePositiveInteger(solarSystemID, null);
    if (!numericSolarSystemID) {
      continue;
    }
    normalized.systems[String(numericSolarSystemID)] = normalizeSystemState(
      record,
      numericSolarSystemID,
    );
  }
  return normalized;
}

function applyTableTimedTransitions(table) {
  let changed = false;
  for (const allianceState of Object.values((table && table.alliances) || {})) {
    if (applyAllianceTimedTransitions(allianceState)) {
      changed = true;
    }
  }
  return changed;
}

function getAlliancePrimeHourFromIndexes(allianceID, primeHourByAllianceID) {
  const numericAllianceID = normalizePositiveInteger(allianceID, null);
  if (!numericAllianceID) {
    return 0;
  }
  if (primeHourByAllianceID.has(numericAllianceID)) {
    return primeHourByAllianceID.get(numericAllianceID);
  }
  return buildDefaultAllianceState(numericAllianceID).primeInfo.currentPrimeHour;
}

function buildVulnerabilityWindow(primeHour, defenseMultiplier, nowMs = Date.now()) {
  const centeredPrimeHour = normalizePrimeHour(primeHour, 0);
  const safeMultiplier = Math.max(
    MIN_OCCUPANCY_BONUS,
    normalizeNumber(defenseMultiplier, BASE_BONUS),
  );
  const durationMs = Math.max(
    HOUR_MS,
    Math.round((VULNERABILITY_WINDOW_BASE_HOURS * HOUR_MS) / safeMultiplier),
  );
  const referenceDate = new Date(Math.max(0, normalizeInteger(nowMs, Date.now())));
  let centerMs = Date.UTC(
    referenceDate.getUTCFullYear(),
    referenceDate.getUTCMonth(),
    referenceDate.getUTCDate(),
    centeredPrimeHour,
    0,
    0,
    0,
  );
  let startMs = centerMs - Math.floor(durationMs / 2);
  let endMs = startMs + durationMs;
  if (nowMs > endMs) {
    startMs += DAY_MS;
    endMs += DAY_MS;
  }
  return {
    startTime: unixMsToFiletimeString(startMs),
    endTime: unixMsToFiletimeString(endMs),
  };
}

function buildStructureSnapshot(
  structure,
  system,
  capitalSystemByAllianceID,
  primeHourByAllianceID,
  nowMs = Date.now(),
) {
  const allianceID = normalizePositiveInteger(structure && structure.allianceID, null);
  const isCapital =
    normalizePositiveInteger(structure && structure.typeID, null) ===
      TYPE_INFRASTRUCTURE_HUB &&
    allianceID &&
    capitalSystemByAllianceID.get(allianceID) ===
      normalizePositiveInteger(system && system.solarSystemID, null);
  const defenseMultiplier = getSystemDefenseMultiplier(system, isCapital);
  let vulnerableStartTime = normalizeFiletimeString(
    structure && structure.vulnerableStartTime,
    "0",
  );
  let vulnerableEndTime = normalizeFiletimeString(
    structure && structure.vulnerableEndTime,
    "0",
  );
  if (
    allianceID &&
    (vulnerableStartTime === "0" || vulnerableEndTime === "0")
  ) {
    const vulnerabilityWindow = buildVulnerabilityWindow(
      getAlliancePrimeHourFromIndexes(allianceID, primeHourByAllianceID),
      defenseMultiplier,
      nowMs,
    );
    vulnerableStartTime = vulnerabilityWindow.startTime;
    vulnerableEndTime = vulnerabilityWindow.endTime;
  }
  return {
    ...cloneValue(structure),
    defenseMultiplier,
    campaignOccupancyLevel: defenseMultiplier,
    vulnerabilityOccupancyLevel: defenseMultiplier,
    vulnerableStartTime,
    vulnerableEndTime,
    isCapital,
  };
}

function buildIndexes() {
  const systemsByAllianceID = new Map();
  const allAllianceSystems = [];
  const allDevelopmentIndices = [];
  const currentSovDataByLocationID = new Map();
  const recentSovActivity = [];
  const claimsBySolarSystemID = new Map();
  const infrastructureHubClaimsBySolarSystemID = new Map();
  const structureSnapshotsBySolarSystemID = new Map();
  const allianceSovRowsByAllianceID = new Map();
  const capitalSystemByAllianceID = new Map();
  const primeHourByAllianceID = new Map();
  const staticSystemIDs = new Set();
  const nowMs = Date.now();
  let nextInvalidationAtMs = Number.POSITIVE_INFINITY;

  const appendCurrentDataRows = (locationID, rows) => {
    const numericLocationID = normalizePositiveInteger(locationID, null);
    if (!numericLocationID || !Array.isArray(rows) || rows.length === 0) {
      return;
    }
    if (!currentSovDataByLocationID.has(numericLocationID)) {
      currentSovDataByLocationID.set(numericLocationID, []);
    }
    currentSovDataByLocationID.get(numericLocationID).push(...rows);
  };

  const getAllianceRows = (allianceID) => {
    const numericAllianceID = normalizePositiveInteger(allianceID, null);
    if (!numericAllianceID) {
      return null;
    }
    if (!allianceSovRowsByAllianceID.has(numericAllianceID)) {
      allianceSovRowsByAllianceID.set(numericAllianceID, {
        tcuRows: [],
        iHubRows: [],
        campaignScoreRows: [],
      });
    }
    return allianceSovRowsByAllianceID.get(numericAllianceID);
  };

  for (const allianceState of Object.values(tableCache.alliances || {})) {
    const allianceID = normalizePositiveInteger(allianceState && allianceState.allianceID, null);
    if (!allianceID) {
      continue;
    }
    primeHourByAllianceID.set(
      allianceID,
      normalizePrimeHour(
        allianceState.primeInfo && allianceState.primeInfo.currentPrimeHour,
        0,
      ),
    );
    const capitalSystemID = normalizePositiveInteger(
      allianceState.capitalInfo && allianceState.capitalInfo.currentCapitalSystem,
      null,
    );
    if (capitalSystemID) {
      capitalSystemByAllianceID.set(allianceID, capitalSystemID);
    }
    const pendingPrimeMs = filetimeToUnixMs(
      allianceState.primeInfo && allianceState.primeInfo.newPrimeHourValidAfter,
      0,
    );
    if (pendingPrimeMs > nowMs) {
      nextInvalidationAtMs = Math.min(nextInvalidationAtMs, pendingPrimeMs);
    }
    const pendingCapitalMs = filetimeToUnixMs(
      allianceState.capitalInfo && allianceState.capitalInfo.newCapitalSystemValidAfter,
      0,
    );
    if (pendingCapitalMs > nowMs) {
      nextInvalidationAtMs = Math.min(nextInvalidationAtMs, pendingCapitalMs);
    }
  }

  for (const system of Object.values(tableCache.systems || {}).sort(
    (left, right) => left.solarSystemID - right.solarSystemID,
  )) {
    if (system.allianceID) {
      if (!systemsByAllianceID.has(system.allianceID)) {
        systemsByAllianceID.set(system.allianceID, []);
      }
      const systemRecord = {
        solarSystemID: system.solarSystemID,
        allianceID: system.allianceID,
      };
      systemsByAllianceID.get(system.allianceID).push(systemRecord);
      allAllianceSystems.push(systemRecord);
      claimsBySolarSystemID.set(system.solarSystemID, {
        claimStructureID: system.claimStructureID,
        corporationID: system.corporationID,
        allianceID: system.allianceID,
      });
    }
    if (system.infrastructureHubID && system.allianceID) {
      infrastructureHubClaimsBySolarSystemID.set(system.solarSystemID, {
        hubID: system.infrastructureHubID,
        corporationID: system.corporationID,
        allianceID: system.allianceID,
        claimTime: system.claimTime,
      });
    }
    allDevelopmentIndices.push({
      solarSystemID: system.solarSystemID,
      militaryPoints: system.devIndices.militaryPoints,
      industrialPoints: system.devIndices.industrialPoints,
      claimedFor: system.devIndices.claimedForDays,
    });
    if (system.recentActivity.length > 0) {
      recentSovActivity.push(...system.recentActivity);
    }
    const structureSnapshots = (system.structures || [])
      .map((structure) =>
        buildStructureSnapshot(
          structure,
          system,
          capitalSystemByAllianceID,
          primeHourByAllianceID,
          nowMs,
        ),
      )
      .sort((left, right) => left.itemID - right.itemID);
    structureSnapshotsBySolarSystemID.set(system.solarSystemID, structureSnapshots);
    for (const structure of structureSnapshots) {
      const campaignStartMs = filetimeToUnixMs(structure.campaignStartTime, 0);
      if (campaignStartMs > nowMs) {
        nextInvalidationAtMs = Math.min(nextInvalidationAtMs, campaignStartMs);
      }
      const vulnerableStartMs = filetimeToUnixMs(structure.vulnerableStartTime, 0);
      if (vulnerableStartMs > nowMs) {
        nextInvalidationAtMs = Math.min(nextInvalidationAtMs, vulnerableStartMs);
      }
      const vulnerableEndMs = filetimeToUnixMs(structure.vulnerableEndTime, 0);
      if (vulnerableEndMs > nowMs) {
        nextInvalidationAtMs = Math.min(nextInvalidationAtMs, vulnerableEndMs);
      }
      const allianceRows = getAllianceRows(structure.allianceID);
      if (!allianceRows) {
        continue;
      }
      const allianceStructureRowID = normalizePositiveInteger(structure.itemID, null);
      const baseRow = {
        structureID: allianceStructureRowID,
        solarSystemID: system.solarSystemID,
        campaignStartTime: structure.campaignStartTime,
        campaignEventType: structure.campaignEventType,
        campaignOccupancyLevel: structure.defenseMultiplier,
        vulnerableStartTime: structure.vulnerableStartTime,
        vulnerableEndTime: structure.vulnerableEndTime,
        vulnerabilityOccupancyLevel: structure.defenseMultiplier,
      };
      if (structure.typeID === TYPE_INFRASTRUCTURE_HUB) {
        allianceRows.iHubRows.push({
          ...baseRow,
          corporationID: structure.corporationID,
        });
        // Today's client still finds claimed systems through a TCU-type row:
        // sovSvc.GetSovereigntyStructuresInfoForAlliance builds from tcuRows
        // and three pages keep a Hub only when a TCU-type row carries its
        // item ID. A Hub that carries the claim is listed there under its own
        // ID, and nothing else goes in.
        if (
          Number(system.claimStructureID) === Number(structure.itemID) &&
          Number(system.infrastructureHubID) === Number(structure.itemID)
        ) {
          allianceRows.tcuRows.push(baseRow);
        }
      }
      for (const [teamID, score] of Object.entries(structure.campaignScoresByTeam || {})) {
        allianceRows.campaignScoreRows.push({
          sourceItemID: allianceStructureRowID,
          teamID: normalizeInteger(teamID, 0),
          score: normalizeNumber(score, 0),
        });
      }
    }
  }

  for (const allianceSystems of systemsByAllianceID.values()) {
    allianceSystems.sort((left, right) => left.solarSystemID - right.solarSystemID);
  }
  allAllianceSystems.sort((left, right) => left.solarSystemID - right.solarSystemID);
  allDevelopmentIndices.sort((left, right) => left.solarSystemID - right.solarSystemID);
  for (const rows of allianceSovRowsByAllianceID.values()) {
    rows.tcuRows.sort(
      (left, right) =>
        left.solarSystemID - right.solarSystemID ||
        left.structureID - right.structureID,
    );
    rows.iHubRows.sort(
      (left, right) =>
        left.solarSystemID - right.solarSystemID ||
        left.structureID - right.structureID,
    );
    rows.campaignScoreRows.sort(
      (left, right) =>
        left.sourceItemID - right.sourceItemID ||
        left.teamID - right.teamID,
    );
  }

  for (const staticSystem of [...worldData.ensureLoaded().solarSystems].sort(
    (left, right) => Number(left.solarSystemID) - Number(right.solarSystemID),
  )) {
    staticSystemIDs.add(Number(staticSystem.solarSystemID) || 0);
    const systemState = tableCache.systems[String(staticSystem.solarSystemID)] || null;
    const rows =
      systemState && systemState.currentData.length > 0
        ? systemState.currentData
        : [buildDerivedCurrentDataRecord(systemState, staticSystem.solarSystemID)];
    appendCurrentDataRows(staticSystem.solarSystemID, rows);
    appendCurrentDataRows(staticSystem.constellationID, rows);
    appendCurrentDataRows(staticSystem.regionID, rows);
  }

  for (const system of Object.values(tableCache.systems || {})) {
    if (staticSystemIDs.has(system.solarSystemID)) {
      continue;
    }
    const rows =
      system.currentData.length > 0
        ? system.currentData
        : [buildDerivedCurrentDataRecord(system, system.solarSystemID)];
    appendCurrentDataRows(system.solarSystemID, rows);
    for (const row of rows) {
      appendCurrentDataRows(row.constellationID, [row]);
      appendCurrentDataRows(row.regionID, [row]);
    }
  }

  for (const rows of currentSovDataByLocationID.values()) {
    rows.sort((left, right) => {
      const locationDelta =
        Number(left.locationID || 0) - Number(right.locationID || 0);
      if (locationDelta !== 0) {
        return locationDelta;
      }
      const stationDelta =
        Number(left.stationID || 0) - Number(right.stationID || 0);
      if (stationDelta !== 0) {
        return stationDelta;
      }
      return Number(left.ownerID || 0) - Number(right.ownerID || 0);
    });
  }

  recentSovActivity.sort((left, right) => {
    const timeDelta = compareNumericStringsDescending(
      left.changeTime,
      right.changeTime,
    );
    if (timeDelta !== 0) {
      return timeDelta;
    }
    return Number(left.solarSystemID || 0) - Number(right.solarSystemID || 0);
  });

  indexCache = {
    systemsByAllianceID,
    allAllianceSystems,
    allDevelopmentIndices,
    currentSovDataByLocationID,
    recentSovActivity,
    claimsBySolarSystemID,
    infrastructureHubClaimsBySolarSystemID,
    structureSnapshotsBySolarSystemID,
    allianceSovRowsByAllianceID,
    capitalSystemByAllianceID,
    primeHourByAllianceID,
    debugSnapshot: {
      updatedAt:
        tableCache && tableCache._meta ? tableCache._meta.updatedAt || null : null,
      allianceCount: Object.keys((tableCache && tableCache.alliances) || {}).length,
      systemCount: Object.keys((tableCache && tableCache.systems) || {}).length,
      cachedAllianceSystemCount: allAllianceSystems.length,
      cachedCurrentSovLocationCount: currentSovDataByLocationID.size,
      cachedRecentActivityCount: recentSovActivity.length,
      cachedClaimCount: claimsBySolarSystemID.size,
      cachedHubClaimCount: infrastructureHubClaimsBySolarSystemID.size,
      cachedStructureSystemCount: structureSnapshotsBySolarSystemID.size,
      cachedAllianceRowCount: allianceSovRowsByAllianceID.size,
      nextInvalidationAtMs: Number.isFinite(nextInvalidationAtMs)
        ? Math.trunc(nextInvalidationAtMs)
        : null,
      capitalSystemByAllianceID: Object.fromEntries(
        [...capitalSystemByAllianceID.entries()].sort((left, right) => left[0] - right[0]),
      ),
    },
    generatedAtMs: nowMs,
    nextInvalidationAtMs: Number.isFinite(nextInvalidationAtMs)
      ? Math.trunc(nextInvalidationAtMs)
      : null,
  };
}

function hydrateTable(rawTable) {
  tableCache = normalizeTable(rawTable);
  // Timed transitions (prime hour, capital moves) are a pure function of the
  // table and the clock, so a passive process applies them to its own copy and
  // leaves the durable row alone. Persisting is the owner's job. Skipping it
  // also keeps `_meta.updatedAt` matching the store, so the ensureLoaded probe
  // below still hits instead of re-reading and re-cloning the whole table on
  // every call.
  if (applyTableTimedTransitions(tableCache) && maySovereigntyPersist()) {
    tableCache = writeSovereigntyTable(tableCache);
  }
  buildIndexes();
  return tableCache;
}

function ensureLoaded() {
  // Probe the table's revision without materialising it. Reading the whole table
  // just to compare one timestamp made every cache hit cost as much as a miss.
  const updatedAt = readSovereigntyTableUpdatedAt();
  if (tableCache && tableCache._meta && tableCache._meta.updatedAt === updatedAt) {
    if (
      indexCache &&
      indexCache.nextInvalidationAtMs &&
      Date.now() >= indexCache.nextInvalidationAtMs
    ) {
      if (applyTableTimedTransitions(tableCache) && maySovereigntyPersist()) {
        tableCache = writeSovereigntyTable(tableCache);
      }
      buildIndexes();
    }
    return tableCache;
  }
  return hydrateTable(readSovereigntyTable());
}

function persist() {
  ensureLoaded();
  tableCache = writeSovereigntyTable(tableCache);
  if (applyTableTimedTransitions(tableCache)) {
    tableCache = writeSovereigntyTable(tableCache);
  }
  buildIndexes();
  return tableCache;
}

function ensureAllianceState(allianceID) {
  ensureLoaded();
  const numericAllianceID = normalizePositiveInteger(allianceID, null);
  if (!numericAllianceID) {
    return buildDefaultAllianceState(null);
  }
  const key = String(numericAllianceID);
  if (!tableCache.alliances[key]) {
    tableCache.alliances[key] = buildDefaultAllianceState(numericAllianceID);
    persist();
  }
  return tableCache.alliances[key];
}

function getResolvedAllianceState(allianceID) {
  const allianceState = ensureAllianceState(allianceID);
  if (applyAllianceTimedTransitions(allianceState)) {
    persist();
  }
  return allianceState;
}

function getAllianceSovereigntySnapshot(allianceID) {
  return cloneValue(getResolvedAllianceState(allianceID));
}

function getAlliancePrimeInfo(allianceID) {
  return cloneValue(getResolvedAllianceState(allianceID).primeInfo);
}

function setAlliancePrimeHour(allianceID, hour) {
  const allianceState = getResolvedAllianceState(allianceID);
  const nextHour = normalizePrimeHour(hour, allianceState.primeInfo.currentPrimeHour);
  if (
    allianceState.primeInfo.currentPrimeHour === nextHour &&
    normalizeFiletimeBigInt(allianceState.primeInfo.newPrimeHourValidAfter, 0n) <= 0n
  ) {
    return cloneValue(allianceState.primeInfo);
  }
  allianceState.primeInfo.newPrimeHour = nextHour;
  allianceState.primeInfo.newPrimeHourValidAfter = addMillisecondsToCurrentFiletime(
    PRIME_TIME_CHANGE_DELAY_MS,
  );
  persist();
  return cloneValue(allianceState.primeInfo);
}

function getAllianceCapitalInfo(allianceID) {
  return cloneValue(
    normalizeAllianceCapitalInfo(getResolvedAllianceState(allianceID).capitalInfo),
  );
}

function setAllianceCapitalSystem(allianceID, solarSystemID) {
  const allianceState = getResolvedAllianceState(allianceID);
  const nextCapitalSystemID = toPublicSolarSystemID(solarSystemID, null);
  if (!nextCapitalSystemID) {
    return cloneValue(allianceState.capitalInfo);
  }
  if (
    allianceState.capitalInfo.currentCapitalSystem === nextCapitalSystemID &&
    !allianceState.capitalInfo.newCapitalSystem
  ) {
    return cloneValue(allianceState.capitalInfo);
  }
  allianceState.capitalInfo.newCapitalSystem = nextCapitalSystemID;
  allianceState.capitalInfo.newCapitalSystemValidAfter = addMillisecondsToCurrentFiletime(
    CAPITAL_SYSTEM_CHANGE_DELAY_MS,
  );
  persist();
  return cloneValue(allianceState.capitalInfo);
}

function cancelAllianceCapitalTransition(allianceID) {
  const allianceState = getResolvedAllianceState(allianceID);
  allianceState.capitalInfo.newCapitalSystem = null;
  allianceState.capitalInfo.newCapitalSystemValidAfter = "0";
  persist();
  return cloneValue(allianceState.capitalInfo);
}

// Retail: an alliance with exactly one system has that system as its capital
// at once, with no seven-day transition. Runs on every change of a system's
// owner, for the old owner and the new one, before the table is written.
// Alliances holding none or several systems keep whatever the capital
// transition code decided.
function reconcileSingleSystemCapitals(allianceIDs) {
  let changed = false;
  const candidates = new Set(
    (Array.isArray(allianceIDs) ? allianceIDs : [allianceIDs])
      .map((entry) => normalizePositiveInteger(entry, null))
      .filter(Boolean),
  );
  for (const allianceID of candidates) {
    const owned = Object.values(tableCache.systems || {})
      .filter(
        (system) =>
          normalizePositiveInteger(system && system.allianceID, null) === allianceID,
      )
      .map((system) => normalizePositiveInteger(system.solarSystemID, null))
      .filter(Boolean);
    if (owned.length !== 1) {
      continue;
    }
    const key = String(allianceID);
    if (!tableCache.alliances[key]) {
      tableCache.alliances[key] = buildDefaultAllianceState(allianceID);
    }
    const capitalInfo = tableCache.alliances[key].capitalInfo;
    if (
      normalizePositiveInteger(capitalInfo.currentCapitalSystem, null) === owned[0] &&
      !capitalInfo.newCapitalSystem
    ) {
      continue;
    }
    queueCapitalSystemChange(allianceID, capitalInfo.currentCapitalSystem, owned[0]);
    capitalInfo.currentCapitalSystem = owned[0];
    capitalInfo.newCapitalSystem = null;
    capitalInfo.newCapitalSystemValidAfter = "0";
    changed = true;
  }
  return changed;
}

function upsertAllianceState(allianceID, patch = {}) {
  ensureLoaded();
  const numericAllianceID = normalizePositiveInteger(allianceID, null);
  if (!numericAllianceID) {
    return null;
  }
  const current = cloneValue(ensureAllianceState(numericAllianceID));
  const next = normalizeAllianceState(
    {
      ...current,
      ...cloneValue(patch),
      primeInfo:
        patch.primeInfo !== undefined
          ? { ...cloneValue(current.primeInfo), ...cloneValue(patch.primeInfo) }
          : cloneValue(current.primeInfo),
      capitalInfo:
        patch.capitalInfo !== undefined
          ? { ...cloneValue(current.capitalInfo), ...cloneValue(patch.capitalInfo) }
          : cloneValue(current.capitalInfo),
    },
    numericAllianceID,
  );
  tableCache.alliances[String(numericAllianceID)] = next;
  persist();
  return cloneValue(next);
}

function getSystemState(solarSystemID) {
  ensureLoaded();
  const numericSolarSystemID = normalizePositiveInteger(solarSystemID, null);
  if (!numericSolarSystemID) {
    return null;
  }
  return tableCache.systems[String(numericSolarSystemID)] || null;
}

function buildOwnershipChangeActivity(currentSystem, nextSystem) {
  return {
    solarSystemID: normalizePositiveInteger(nextSystem && nextSystem.solarSystemID, null),
    ownerID: normalizeNullablePositiveInteger(nextSystem && nextSystem.allianceID, null),
    oldOwnerID: normalizeNullablePositiveInteger(currentSystem && currentSystem.allianceID, null),
    stationID: null,
    changeTime: currentFileTime().toString(),
  };
}

function collectSystemAllianceIDs(currentSystem, nextSystem, structureSnapshots = []) {
  const allianceIDs = new Set();
  for (const candidate of [
    currentSystem && currentSystem.allianceID,
    nextSystem && nextSystem.allianceID,
    ...(currentSystem && Array.isArray(currentSystem.structures)
      ? currentSystem.structures.map((entry) => entry && entry.allianceID)
      : []),
    ...(nextSystem && Array.isArray(nextSystem.structures)
      ? nextSystem.structures.map((entry) => entry && entry.allianceID)
      : []),
    ...(Array.isArray(structureSnapshots)
      ? structureSnapshots.map((entry) => entry && entry.allianceID)
      : []),
  ]) {
    const numericAllianceID = normalizePositiveInteger(candidate, null);
    if (numericAllianceID) {
      allianceIDs.add(numericAllianceID);
    }
  }
  return [...allianceIDs].sort((left, right) => left - right);
}

function publishSystemStateEffects(currentValue, nextValue, options = {}) {
  const numericSolarSystemID = normalizePositiveInteger(
    (nextValue && nextValue.solarSystemID) ||
      (currentValue && currentValue.solarSystemID),
    null,
  );
  if (!numericSolarSystemID) {
    return { success: false, errorMsg: "SOLAR_SYSTEM_REQUIRED" };
  }
  const current = normalizeSystemState(currentValue || {}, numericSolarSystemID);
  const next = normalizeSystemState(nextValue || {}, numericSolarSystemID);
  const structuresChanged = !valuesEqual(current.structures, next.structures);
  let structureSyncResult = null;

  if (
    !normalizeBoolean(options.suppressStructureSync, false) &&
    structuresChanged
  ) {
    structureSyncResult = syncSovereigntyStructureRuntime(next, {
      // Space-ball lifecycle is separate from the sovereignty service's
      // OnSovereignty* notification fan-out. Campaign code suppresses the
      // latter while still needing AddBalls/OnSlimItemChange/RemoveBall so
      // pilots in an awake scene see command nodes and live Entosis progress.
      broadcast: !normalizeBoolean(options.suppressStructureBroadcast, false),
    });
  }

  if (!normalizeBoolean(options.suppressNotifications, false)) {
    const structureSnapshots = listSovStructuresForSystem(numericSolarSystemID);
    const allianceIDs = collectSystemAllianceIDs(current, next, structureSnapshots);
    if (!valuesEqual(current.devIndices, next.devIndices)) {
      broadcastSolarSystemDevIndexChanged(numericSolarSystemID, allianceIDs);
    }
    if (
      current.allianceID !== next.allianceID ||
      current.corporationID !== next.corporationID ||
      current.claimStructureID !== next.claimStructureID
    ) {
      broadcastSovereigntyChanged(
        numericSolarSystemID,
        getSystemSovClaim(numericSolarSystemID),
        allianceIDs,
      );
    }
    if (structuresChanged) {
      broadcastSolarSystemSovStructuresUpdated(
        numericSolarSystemID,
        structureSnapshots,
        options.changesByStructureID || null,
        { allianceIDs },
      );
    }
    if (options.audioEventID) {
      broadcastSovereigntyAudioEvent(
        numericSolarSystemID,
        options.audioEventID,
        options.audioTextParams || {},
        allianceIDs,
      );
    }
    if (options.sovHubHack) {
      broadcastSovHubHacked(
        numericSolarSystemID,
        options.sovHubHack.sovHubID,
        options.sovHubHack.upgrades || [],
        allianceIDs,
      );
    }
  }

  return {
    success: !structureSyncResult || structureSyncResult.success !== false,
    errorMsg:
      structureSyncResult && structureSyncResult.success === false
        ? structureSyncResult.errorMsg || "STRUCTURE_SYNC_FAILED"
        : null,
    data: {
      solarSystemID: numericSolarSystemID,
      structuresChanged,
      structureSyncResult,
    },
  };
}

function replaceSystemStateSnapshot(solarSystemID, snapshot, options = {}) {
  ensureLoaded();
  const numericSolarSystemID = normalizePositiveInteger(solarSystemID, null);
  if (!numericSolarSystemID) {
    return null;
  }
  const current = cloneValue(getSystemState(numericSolarSystemID));
  const next = snapshot == null
    ? null
    : normalizeSystemState(cloneValue(snapshot), numericSolarSystemID);
  if (next) {
    tableCache.systems[String(numericSolarSystemID)] = next;
  } else {
    delete tableCache.systems[String(numericSolarSystemID)];
  }
  if ((current && current.allianceID) !== (next && next.allianceID)) {
    reconcileSingleSystemCapitals([
      current && current.allianceID,
      next && next.allianceID,
    ]);
  }
  persist();
  try {
    const {
      invalidateSovereigntyModernStateCache,
    } = require(path.join(__dirname, "./sovModernState"));
    invalidateSovereigntyModernStateCache();
  } catch (_error) {
    // ignored: at bootstrap sovModernState is half-loaded (require cycle) and has no cache yet
  }
  publishSystemStateEffects(current, next, options);
  return cloneValue(next);
}

function upsertSystemState(solarSystemID, patch = {}, options = {}) {
  ensureLoaded();
  const numericSolarSystemID = normalizePositiveInteger(solarSystemID, null);
  if (!numericSolarSystemID) {
    return null;
  }
  const current =
    cloneValue(getSystemState(numericSolarSystemID)) ||
    normalizeSystemState({}, numericSolarSystemID);
  const next = normalizeSystemState(
    {
      ...current,
      ...cloneValue(patch),
      structures:
        patch.structures !== undefined
          ? cloneValue(patch.structures)
          : cloneValue(current.structures),
      devIndices:
        patch.devIndices !== undefined
          ? { ...cloneValue(current.devIndices), ...cloneValue(patch.devIndices) }
          : cloneValue(current.devIndices),
      recentActivity:
        patch.recentActivity !== undefined
          ? cloneValue(patch.recentActivity)
          : cloneValue(current.recentActivity),
      currentData:
        patch.currentData !== undefined
          ? cloneValue(patch.currentData)
          : cloneValue(current.currentData),
    },
    numericSolarSystemID,
  );
  if (
    patch.recentActivity === undefined &&
    current.allianceID !== next.allianceID
  ) {
    next.recentActivity = [
      buildOwnershipChangeActivity(current, next),
      ...next.recentActivity,
    ];
  }
  tableCache.systems[String(numericSolarSystemID)] = next;
  if (current.allianceID !== next.allianceID) {
    reconcileSingleSystemCapitals([current.allianceID, next.allianceID]);
  }
  persist();
  try {
    const {
      invalidateSovereigntyModernStateCache,
    } = require(path.join(__dirname, "./sovModernState"));
    invalidateSovereigntyModernStateCache();
  } catch (_error) {
    // ignored: at bootstrap sovModernState is half-loaded (require cycle) and has no cache yet
  }

  publishSystemStateEffects(current, next, options);

  return cloneValue(next);
}

function mutateStructureInSystem(
  solarSystemID,
  structureID,
  mutator,
  options = {},
) {
  const system = cloneValue(getSystemState(solarSystemID));
  if (!system) {
    return null;
  }
  const numericStructureID = normalizePositiveInteger(structureID, null);
  if (!numericStructureID) {
    return null;
  }
  const structureIndex = system.structures.findIndex(
    (entry) => normalizePositiveInteger(entry && entry.itemID, null) === numericStructureID,
  );
  if (structureIndex < 0) {
    return null;
  }
  const normalizedStructure = normalizeStructureRecord(
    mutator(cloneValue(system.structures[structureIndex])),
    system.solarSystemID,
    system.allianceID,
    system.corporationID,
  );
  if (!normalizedStructure) {
    return null;
  }
  const nextStructures = cloneValue(system.structures);
  nextStructures[structureIndex] = normalizedStructure;
  return upsertSystemState(
    system.solarSystemID,
    {
      structures: nextStructures,
    },
    options,
  );
}

function findSovereigntyStructureByID(structureID, solarSystemID = null) {
  ensureLoaded();
  const numericStructureID = normalizePositiveInteger(structureID, null);
  const numericSolarSystemID = normalizePositiveInteger(solarSystemID, null);
  if (!numericStructureID) {
    return null;
  }
  const systems = numericSolarSystemID
    ? [tableCache.systems[String(numericSolarSystemID)]].filter(Boolean)
    : Object.values(tableCache.systems || {});
  for (const system of systems) {
    const structure = (system.structures || []).find(
      (entry) =>
        normalizePositiveInteger(entry && entry.itemID, null) ===
        numericStructureID,
    );
    if (structure) {
      return {
        solarSystemID: system.solarSystemID,
        system: cloneValue(system),
        structure: cloneValue(structure),
      };
    }
  }
  return null;
}

function listAllSovereigntySystemStates() {
  ensureLoaded();
  return Object.values(tableCache.systems || {})
    .map((system) => cloneValue(system))
    .sort(
      (left, right) =>
        Number(left && left.solarSystemID || 0) -
        Number(right && right.solarSystemID || 0),
    );
}

function setStructureEntosisCapture(
  solarSystemID,
  structureID,
  entosisCapture,
  options = {},
) {
  return mutateStructureInSystem(
    solarSystemID,
    structureID,
    (structure) => ({
      ...structure,
      entosisCapture: normalizeEntosisCapture(
        entosisCapture,
        structure &&
          structure.devFlags &&
          structure.devFlags.sovereigntyCaptureEpoch,
      ),
    }),
    options,
  );
}

function getStructureCampaignEpoch(structure) {
  const devFlags =
    structure && structure.devFlags && typeof structure.devFlags === "object"
      ? structure.devFlags
      : {};
  const campaign =
    devFlags.sovereigntyCampaign &&
    typeof devFlags.sovereigntyCampaign === "object"
      ? devFlags.sovereigntyCampaign
      : {};
  return String(
    campaign.campaignEpoch ||
      devFlags.sovereigntyCampaignEpoch ||
      devFlags.campaignEpoch ||
      "",
  ).trim();
}

function getCommandNodeCampaignTargetID(structure) {
  const devFlags =
    structure && structure.devFlags && typeof structure.devFlags === "object"
      ? structure.devFlags
      : {};
  const sourceInfo = Array.isArray(structure && structure.campaignSourceInfo)
    ? structure.campaignSourceInfo
    : Array.isArray(devFlags.campaignSourceInfo)
      ? devFlags.campaignSourceInfo
      : [];
  return normalizePositiveInteger(
    devFlags.campaignTargetID,
    normalizePositiveInteger(sourceInfo[2], null),
  );
}

function isCampaignCommandNode(
  structure,
  targetID,
  campaignEpoch,
  requestedNodeIDs,
) {
  const itemID = normalizePositiveInteger(structure && structure.itemID, null);
  if (
    !itemID ||
    normalizePositiveInteger(structure && structure.typeID, null) !==
      TYPE_SOVEREIGNTY_COMMAND_NODE ||
    getStructureCampaignEpoch(structure) !== campaignEpoch ||
    getCommandNodeCampaignTargetID(structure) !== targetID
  ) {
    return false;
  }
  const devFlags =
    structure && structure.devFlags && typeof structure.devFlags === "object"
      ? structure.devFlags
      : {};
  return Boolean(
    devFlags.sovereigntyCommandNode === true ||
      devFlags.sovereigntyCampaignAuxiliary === true ||
      requestedNodeIDs.has(itemID),
  );
}

function clearCompletedCampaignFields(structure, campaignEpoch) {
  const devFlags = {
    ...(structure && structure.devFlags && typeof structure.devFlags === "object"
      ? structure.devFlags
      : {}),
  };
  if (
    devFlags.sovereigntyCampaign &&
    typeof devFlags.sovereigntyCampaign === "object" &&
    String(devFlags.sovereigntyCampaign.campaignEpoch || "").trim() ===
      campaignEpoch
  ) {
    delete devFlags.sovereigntyCampaign;
  }
  if (
    String(devFlags.sovereigntyCampaignEpoch || "").trim() === campaignEpoch
  ) {
    delete devFlags.sovereigntyCampaignEpoch;
  }
  if (String(devFlags.campaignEpoch || "").trim() === campaignEpoch) {
    delete devFlags.campaignEpoch;
  }
  const entosisCapture =
    structure &&
    structure.entosisCapture &&
    typeof structure.entosisCapture === "object"
      ? {
          ...structure.entosisCapture,
          controllingTeamID: normalizePositiveInteger(
            structure.allianceID,
            structure.entosisCapture.controllingTeamID,
          ),
          scoringTeamID: null,
          scoreAtLastUpdateTime: 1,
          scoringRate: 0,
          isBlocked: false,
        }
      : structure && structure.entosisCapture;
  return {
    ...structure,
    campaignEventType: 0,
    campaignStartTime: "0",
    campaignScoresByTeam: {},
    devFlags,
    ...(entosisCapture ? { entosisCapture } : {}),
  };
}

/**
 * Atomically consumes one sovereignty command node and applies its campaign
 * point. `replacementStructure`, when supplied, has the shape
 * `{ solarSystemID, structure }`; the caller owns allocation and placement,
 * while this helper fences and commits that identity with the score receipt.
 */
function commitSovereigntyCommandNodeCapture(options = {}) {
  ensureLoaded();
  const sourceSolarSystemID = normalizePositiveInteger(
    options.sourceSolarSystemID,
    null,
  );
  const targetID = normalizePositiveInteger(options.targetID, null);
  const nodeID = normalizePositiveInteger(options.nodeID, null);
  const winnerAllianceID = normalizePositiveInteger(
    options.winnerAllianceID,
    null,
  );
  const defenderAllianceID = normalizePositiveInteger(
    options.defenderAllianceID,
    null,
  );
  const campaignEpoch = String(options.campaignEpoch || "").trim();
  const scoreDelta = normalizeNumber(options.scoreDelta, Number.NaN);
  const completedAtTime = normalizeFiletimeString(
    options.completedAtTime,
    "0",
  );
  if (
    !sourceSolarSystemID ||
    !targetID ||
    !nodeID ||
    !winnerAllianceID ||
    !defenderAllianceID ||
    !campaignEpoch ||
    completedAtTime === "0" ||
    !Number.isFinite(scoreDelta) ||
    Math.abs(Math.abs(scoreDelta) - SOVEREIGNTY_COMMAND_NODE_SCORE_DELTA) >
      1e-9
  ) {
    return {
      success: false,
      errorMsg: "INVALID_SOVEREIGNTY_COMMAND_NODE_CAPTURE_COMMIT",
    };
  }
  const defenderWon = winnerAllianceID === defenderAllianceID;
  if ((defenderWon && scoreDelta < 0) || (!defenderWon && scoreDelta > 0)) {
    return {
      success: false,
      errorMsg: "SOVEREIGNTY_COMMAND_NODE_WINNER_SCORE_MISMATCH",
    };
  }

  const sourceKey = String(sourceSolarSystemID);
  const currentSource = cloneValue(tableCache.systems[sourceKey] || null);
  const sourceHub = currentSource && (currentSource.structures || []).find(
    (structure) =>
      normalizePositiveInteger(structure && structure.itemID, null) ===
        targetID &&
      normalizePositiveInteger(structure && structure.typeID, null) ===
        TYPE_INFRASTRUCTURE_HUB,
  );
  const campaign =
    sourceHub &&
    sourceHub.devFlags &&
    sourceHub.devFlags.sovereigntyCampaign &&
    typeof sourceHub.devFlags.sovereigntyCampaign === "object"
      ? cloneValue(sourceHub.devFlags.sovereigntyCampaign)
      : null;
  if (
    !currentSource ||
    !sourceHub ||
    !campaign ||
    normalizePositiveInteger(currentSource.allianceID, null) !==
      defenderAllianceID ||
    normalizePositiveInteger(sourceHub.allianceID, null) !==
      defenderAllianceID ||
    normalizePositiveInteger(currentSource.claimStructureID, null) !==
      targetID ||
    normalizePositiveInteger(currentSource.infrastructureHubID, null) !==
      targetID ||
    String(campaign.campaignEpoch || "").trim() !== campaignEpoch ||
    normalizePositiveInteger(campaign.targetID, targetID) !== targetID ||
    normalizePositiveInteger(
      campaign.sourceSolarSystemID,
      sourceSolarSystemID,
    ) !== sourceSolarSystemID ||
    normalizePositiveInteger(campaign.defenderAllianceID, null) !==
      defenderAllianceID
  ) {
    return {
      success: false,
      errorMsg: "SOVEREIGNTY_COMMAND_NODE_CAPTURE_FENCE_CHANGED",
    };
  }

  const requestedReplacement =
    options.replacementStructure &&
    typeof options.replacementStructure === "object"
      ? options.replacementStructure
      : null;
  const requestedReplacementSystemID = requestedReplacement
    ? normalizePositiveInteger(requestedReplacement.solarSystemID, null)
    : null;
  const requestedReplacementNodeID = requestedReplacement
    ? normalizePositiveInteger(
        requestedReplacement.structure &&
          requestedReplacement.structure.itemID,
        null,
      )
    : null;
  const requestedNextNodeSequence = Number.isInteger(
    Number(options.nextNodeSequence),
  )
    ? Math.max(1, Number(options.nextNodeSequence))
    : null;
  const requestedNextPlacementIndex = Number.isInteger(
    Number(options.nextPlacementIndex),
  )
    ? Math.max(0, Number(options.nextPlacementIndex))
    : null;
  const existingReceipt = normalizeCommandNodeCaptureReceipt(
    campaign.nodeCaptureReceipts &&
      campaign.nodeCaptureReceipts[String(nodeID)],
  );
  if (existingReceipt) {
    if (
      existingReceipt.sourceSolarSystemID !== sourceSolarSystemID ||
      existingReceipt.targetID !== targetID ||
      existingReceipt.campaignEpoch !== campaignEpoch ||
      existingReceipt.nodeID !== nodeID ||
      existingReceipt.winnerAllianceID !== winnerAllianceID ||
      existingReceipt.defenderAllianceID !== defenderAllianceID ||
      Math.abs(existingReceipt.scoreDelta - scoreDelta) > 1e-9 ||
      (!existingReceipt.result &&
        (existingReceipt.replacementNodeID !== requestedReplacementNodeID ||
          existingReceipt.replacementSolarSystemID !==
            requestedReplacementSystemID))
    ) {
      return {
        success: false,
        errorMsg: "SOVEREIGNTY_COMMAND_NODE_CAPTURE_RECEIPT_FENCE_CHANGED",
      };
    }
    return {
      success: true,
      data: {
        alreadyCompleted: true,
        receipt: cloneValue(existingReceipt),
        campaign: cloneValue(campaign),
        terminalPending: Boolean(existingReceipt.result),
        replacementNodeID: existingReceipt.replacementNodeID,
        replacementSolarSystemID:
          existingReceipt.replacementSolarSystemID,
      },
    };
  }

  if (
    String(campaign.status || "").trim().toLowerCase() !== "active" ||
    !(Array.isArray(campaign.nodeIDs) ? campaign.nodeIDs : [])
      .map((entry) => normalizePositiveInteger(entry, null))
      .includes(nodeID)
  ) {
    return {
      success: false,
      errorMsg: "SOVEREIGNTY_COMMAND_NODE_CAPTURE_NOT_ACTIVE",
    };
  }

  const matchingNodes = [];
  for (const [systemKey, system] of Object.entries(tableCache.systems || {})) {
    for (const structure of system && Array.isArray(system.structures)
      ? system.structures
      : []) {
      if (
        normalizePositiveInteger(structure && structure.itemID, null) ===
          nodeID
      ) {
        matchingNodes.push({
          solarSystemID: normalizePositiveInteger(systemKey, null),
          structure,
        });
      }
    }
  }
  const capturedNode = matchingNodes.length === 1 ? matchingNodes[0] : null;
  if (
    !capturedNode ||
    !capturedNode.solarSystemID ||
    !isCampaignCommandNode(
      capturedNode.structure,
      targetID,
      campaignEpoch,
      new Set([nodeID]),
    )
  ) {
    return {
      success: false,
      errorMsg: "SOVEREIGNTY_COMMAND_NODE_CAPTURE_NODE_FENCE_CHANGED",
    };
  }
  const capturedNodeFlags =
    capturedNode.structure.devFlags &&
    typeof capturedNode.structure.devFlags === "object"
      ? capturedNode.structure.devFlags
      : {};
  const capturedNodeState =
    capturedNodeFlags.commandNodeCapture &&
    typeof capturedNodeFlags.commandNodeCapture === "object"
      ? capturedNodeFlags.commandNodeCapture
      : {};
  const capturedNodeTeamID = normalizeNullableTeamID(
    capturedNodeState.controllingTeamID,
    normalizeNullableTeamID(
      capturedNode.structure.entosisCapture &&
        capturedNode.structure.entosisCapture.controllingTeamID,
      null,
    ),
  );
  const expectedWinnerTeamID = defenderWon
    ? defenderAllianceID
    : -defenderAllianceID;
  if (
    capturedNodeTeamID != null &&
    capturedNodeTeamID !== expectedWinnerTeamID
  ) {
    return {
      success: false,
      errorMsg: "SOVEREIGNTY_COMMAND_NODE_CAPTURE_WINNER_FENCE_CHANGED",
    };
  }
  const persistedCheckpointScore = Number.isFinite(
    Number(capturedNodeState.scoreAtLastUpdateTime),
  )
    ? Number(capturedNodeState.scoreAtLastUpdateTime)
    : normalizeNumber(
        capturedNode.structure.entosisCapture &&
          capturedNode.structure.entosisCapture.scoreAtLastUpdateTime,
        Number.NaN,
      );
  const persistedCheckpointBlocked =
    typeof capturedNodeState.isBlocked === "boolean"
      ? capturedNodeState.isBlocked
      : capturedNode.structure.entosisCapture &&
          capturedNode.structure.entosisCapture.isBlocked === true;
  if (
    !Number.isFinite(persistedCheckpointScore) ||
    persistedCheckpointScore < 1 - 1e-9 ||
    persistedCheckpointBlocked === true
  ) {
    return {
      success: false,
      errorMsg: "SOVEREIGNTY_COMMAND_NODE_CAPTURE_CHECKPOINT_INCOMPLETE",
    };
  }

  const defenderKey = String(defenderAllianceID);
  const attackerTeamID = -defenderAllianceID;
  const attackerKey = String(attackerTeamID);
  const defenderScoreBefore = normalizeNumber(
    campaign.scoresByTeam && campaign.scoresByTeam[defenderKey],
    Number.NaN,
  );
  if (!Number.isFinite(defenderScoreBefore)) {
    return {
      success: false,
      errorMsg: "SOVEREIGNTY_COMMAND_NODE_CAPTURE_SCORE_FENCE_CHANGED",
    };
  }
  const roundScore = (value) =>
    Math.round(Math.max(0, Math.min(1, value)) * 1e12) / 1e12;
  const defenderScoreAfter = roundScore(defenderScoreBefore + scoreDelta);
  const attackerScoreAfter = roundScore(1 - defenderScoreAfter);
  const result =
    defenderScoreAfter >= 1 - 1e-9
      ? "defender"
      : defenderScoreAfter <= 1e-9
        ? "attacker"
        : null;

  if (!result && !requestedReplacement) {
    return {
      success: false,
      errorMsg: "SOVEREIGNTY_COMMAND_NODE_REPLACEMENT_REQUIRED",
    };
  }

  let replacementStructure = null;
  if (!result && requestedReplacement) {
    if (
      !requestedReplacementSystemID ||
      !requestedReplacementNodeID ||
      requestedReplacementNodeID === nodeID
    ) {
      return {
        success: false,
        errorMsg: "SOVEREIGNTY_COMMAND_NODE_REPLACEMENT_INVALID",
      };
    }
    const replacementCollision = Object.values(tableCache.systems || {}).some(
      (system) =>
        (Array.isArray(system && system.structures) ? system.structures : [])
          .some(
            (structure) =>
              normalizePositiveInteger(structure && structure.itemID, null) ===
              requestedReplacementNodeID,
          ),
    );
    replacementStructure = normalizeStructureRecord(
      requestedReplacement.structure,
      requestedReplacementSystemID,
      defenderAllianceID,
      normalizePositiveInteger(sourceHub.corporationID, null),
    );
    if (
      replacementCollision ||
      !replacementStructure ||
      replacementStructure.typeID !== TYPE_SOVEREIGNTY_COMMAND_NODE ||
      !replacementStructure.devFlags ||
      replacementStructure.devFlags.sovereigntyCommandNode !== true ||
      getStructureCampaignEpoch(replacementStructure) !== campaignEpoch ||
      getCommandNodeCampaignTargetID(replacementStructure) !== targetID
    ) {
      return {
        success: false,
        errorMsg: "SOVEREIGNTY_COMMAND_NODE_REPLACEMENT_FENCE_CHANGED",
      };
    }

    const sourceStaticSystem = worldData.getSolarSystemByID(
      sourceSolarSystemID,
    );
    const replacementStaticSystem = worldData.getSolarSystemByID(
      requestedReplacementSystemID,
    );
    const campaignConstellationID = normalizePositiveInteger(
      campaign.constellationID,
      normalizePositiveInteger(
        sourceStaticSystem && sourceStaticSystem.constellationID,
        null,
      ),
    );
    if (
      !campaignConstellationID ||
      normalizePositiveInteger(
        replacementStaticSystem && replacementStaticSystem.constellationID,
        null,
      ) !== campaignConstellationID
    ) {
      return {
        success: false,
        errorMsg: "SOVEREIGNTY_COMMAND_NODE_REPLACEMENT_CONSTELLATION_FENCE",
      };
    }

    // Count the topology that will exist after the captured node is removed.
    // Checking the pre-removal table strands an event at its ten-node cap and
    // likewise rejects same-system or constellation replacements at 5/20.
    let eventNodeCount = 0;
    let replacementSystemNodeCount = 0;
    let constellationNodeCount = 0;
    for (const [systemKey, system] of Object.entries(tableCache.systems || {})) {
      const solarSystemID = normalizePositiveInteger(systemKey, null);
      const staticSystem = worldData.getSolarSystemByID(solarSystemID);
      const isCampaignConstellation =
        normalizePositiveInteger(
          staticSystem && staticSystem.constellationID,
          null,
        ) === campaignConstellationID;
      for (const structure of Array.isArray(system && system.structures)
        ? system.structures
        : []) {
        const physicalNodeID = normalizePositiveInteger(
          structure && structure.itemID,
          null,
        );
        const flags =
          structure &&
          structure.devFlags &&
          typeof structure.devFlags === "object"
            ? structure.devFlags
            : {};
        if (
          physicalNodeID === nodeID ||
          normalizePositiveInteger(structure && structure.typeID, null) !==
            TYPE_SOVEREIGNTY_COMMAND_NODE ||
          flags.sovereigntyCommandNode !== true
        ) {
          continue;
        }
        if (
          getStructureCampaignEpoch(structure) === campaignEpoch &&
          getCommandNodeCampaignTargetID(structure) === targetID
        ) {
          eventNodeCount += 1;
        }
        if (solarSystemID === requestedReplacementSystemID) {
          replacementSystemNodeCount += 1;
        }
        if (isCampaignConstellation) {
          constellationNodeCount += 1;
        }
      }
    }
    if (
      eventNodeCount + 1 > MAX_SOVEREIGNTY_COMMAND_NODES_PER_EVENT ||
      replacementSystemNodeCount + 1 >
        MAX_SOVEREIGNTY_COMMAND_NODES_PER_SYSTEM ||
      constellationNodeCount + 1 >
        MAX_SOVEREIGNTY_COMMAND_NODES_PER_CONSTELLATION
    ) {
      return {
        success: false,
        errorMsg: "SOVEREIGNTY_COMMAND_NODE_REPLACEMENT_CAP_REACHED",
      };
    }
  }

  const receipt = normalizeCommandNodeCaptureReceipt({
    sourceSolarSystemID,
    targetID,
    campaignEpoch,
    nodeID,
    winnerAllianceID,
    winnerTeamID: expectedWinnerTeamID,
    defenderAllianceID,
    scoreDelta,
    defenderScoreBefore,
    defenderScoreAfter,
    attackerScoreAfter,
    replacementNodeID: replacementStructure
      ? requestedReplacementNodeID
      : null,
    replacementSolarSystemID: replacementStructure
      ? requestedReplacementSystemID
      : null,
    completedAtTime,
    result,
  });
  const nextCampaign = {
    ...campaign,
    scoresByTeam: {
      ...(campaign.scoresByTeam || {}),
      [defenderKey]: defenderScoreAfter,
      [attackerKey]: attackerScoreAfter,
    },
    nodeIDs: [
      ...new Set([
        ...(Array.isArray(campaign.nodeIDs) ? campaign.nodeIDs : [])
          .map((entry) => normalizePositiveInteger(entry, null))
          .filter((entry) => entry && entry !== nodeID),
        ...(replacementStructure ? [requestedReplacementNodeID] : []),
      ]),
    ],
    nodeCaptureReceipts: {
      ...(campaign.nodeCaptureReceipts || {}),
      [String(nodeID)]: receipt,
    },
  };
  if (replacementStructure) {
    const currentNextNodeSequence = Math.max(
      1,
      normalizeInteger(campaign.nextNodeSequence, 1),
    );
    const currentNextPlacementIndex = Math.max(
      0,
      normalizeInteger(campaign.nextPlacementIndex, 0),
    );
    nextCampaign.nextNodeSequence = requestedNextNodeSequence == null
      ? currentNextNodeSequence + 1
      : Math.max(currentNextNodeSequence, requestedNextNodeSequence);
    nextCampaign.nextPlacementIndex = requestedNextPlacementIndex == null
      ? currentNextPlacementIndex
      : requestedNextPlacementIndex;
  }
  if (result) {
    nextCampaign.status = "terminal-pending";
    nextCampaign.phase = "terminal-pending";
    nextCampaign.result = result;
    nextCampaign.terminalPending = {
      nodeID,
      winnerAllianceID,
      result,
      completedAtTime,
    };
  }

  const beforeBySystemID = new Map();
  const nextBySystemID = new Map();
  const editSystem = (solarSystemID) => {
    const numericSystemID = normalizePositiveInteger(solarSystemID, null);
    if (!nextBySystemID.has(numericSystemID)) {
      const before = cloneValue(
        tableCache.systems[String(numericSystemID)] || null,
      );
      beforeBySystemID.set(numericSystemID, before);
      nextBySystemID.set(
        numericSystemID,
        before || normalizeSystemState({}, numericSystemID),
      );
    }
    return nextBySystemID.get(numericSystemID);
  };
  const nodeSystem = editSystem(capturedNode.solarSystemID);
  nodeSystem.structures = (nodeSystem.structures || []).filter(
    (structure) =>
      normalizePositiveInteger(structure && structure.itemID, null) !== nodeID,
  );
  if (replacementStructure) {
    const replacementSystem = editSystem(requestedReplacementSystemID);
    replacementSystem.structures = [
      ...(replacementSystem.structures || []),
      replacementStructure,
    ];
  }
  const nextSource = editSystem(sourceSolarSystemID);
  nextSource.structures = (nextSource.structures || []).map((structure) => {
    if (
      normalizePositiveInteger(structure && structure.itemID, null) !== targetID
    ) {
      return structure;
    }
    return {
      ...structure,
      campaignScoresByTeam: cloneValue(nextCampaign.scoresByTeam),
      devFlags: {
        ...(structure.devFlags || {}),
        sovereigntyCampaign: cloneValue(nextCampaign),
      },
    };
  });
  for (const [solarSystemID, system] of nextBySystemID.entries()) {
    tableCache.systems[String(solarSystemID)] = normalizeSystemState(
      system,
      solarSystemID,
    );
  }

  // This operation has one durable boundary: every score, receipt, physical
  // removal and replacement is written with the same sovereignty table image.
  tableCache = writeSovereigntyTable(tableCache);
  buildIndexes();
  try {
    const {
      invalidateSovereigntyModernStateCache,
    } = require(path.join(__dirname, "./sovModernState"));
    invalidateSovereigntyModernStateCache();
  } catch (_error) {
    // ignored: at bootstrap sovModernState is half-loaded (require cycle) and has no cache yet
  }
  for (const [solarSystemID, before] of beforeBySystemID.entries()) {
    publishSystemStateEffects(
      before,
      tableCache.systems[String(solarSystemID)] || null,
      options.effectOptions || {},
    );
  }
  return {
    success: true,
    data: {
      alreadyCompleted: false,
      receipt: cloneValue(receipt),
      campaign: cloneValue(nextCampaign),
      terminalPending: Boolean(result),
      replacementNodeID: receipt.replacementNodeID,
      replacementSolarSystemID: receipt.replacementSolarSystemID,
    },
  };
}

/**
 * Atomically commits the destructive side of a sovereignty command-node
 * campaign. All canonical systems and the modern Sov Hub ledger are mutated
 * in one sovereignty-table write; client/runtime effects are published only
 * after that durable boundary.
 */
function commitSovereigntyHubCampaignOutcome(options = {}) {
  ensureLoaded();
  const solarSystemID = normalizePositiveInteger(options.solarSystemID, null);
  const targetID = normalizePositiveInteger(options.targetID, null);
  const defenderAllianceID = normalizePositiveInteger(
    options.defenderAllianceID,
    null,
  );
  const campaignEpoch = String(options.campaignEpoch || "").trim();
  const result = String(options.result || "").trim().toLowerCase();
  const completedAtTime = normalizeFiletimeString(
    options.completedAtTime,
    "0",
  );
  const requestedNodeIDs = new Set(
    (Array.isArray(options.nodeIDs) ? options.nodeIDs : [])
      .map((entry) => normalizePositiveInteger(entry, null))
      .filter(Boolean),
  );
  if (
    !solarSystemID ||
    !targetID ||
    !defenderAllianceID ||
    !campaignEpoch ||
    completedAtTime === "0" ||
    (result !== "attacker" && result !== "defender")
  ) {
    return {
      success: false,
      errorMsg: "INVALID_SOVEREIGNTY_CAMPAIGN_OUTCOME_COMMIT",
    };
  }

  const sourceKey = String(solarSystemID);
  const currentSource = cloneValue(tableCache.systems[sourceKey] || null);
  if (!currentSource) {
    return {
      success: false,
      errorMsg: "SOVEREIGNTY_CAMPAIGN_SOURCE_NOT_FOUND",
    };
  }
  const receiptKey = buildCampaignOutcomeReceiptKey(targetID, campaignEpoch);
  const existingReceipt = normalizeCampaignOutcomeReceipt(
    currentSource.campaignOutcomeReceipts &&
      currentSource.campaignOutcomeReceipts[receiptKey],
  );
  if (existingReceipt) {
    if (
      existingReceipt.solarSystemID !== solarSystemID ||
      existingReceipt.targetID !== targetID ||
      existingReceipt.campaignEpoch !== campaignEpoch ||
      existingReceipt.defenderAllianceID !== defenderAllianceID ||
      existingReceipt.result !== result
    ) {
      return {
        success: false,
        errorMsg: "SOVEREIGNTY_CAMPAIGN_OUTCOME_RECEIPT_FENCE_CHANGED",
      };
    }
    return {
      success: true,
      data: {
        alreadyCompleted: true,
        receipt: cloneValue(existingReceipt),
        system: cloneValue(currentSource),
        removedNodeIDs: cloneValue(existingReceipt.nodeIDs),
      },
    };
  }

  const target = (currentSource.structures || []).find(
    (structure) =>
      normalizePositiveInteger(structure && structure.itemID, null) ===
        targetID &&
      normalizePositiveInteger(structure && structure.typeID, null) ===
        TYPE_INFRASTRUCTURE_HUB,
  );
  if (
    !target ||
    normalizePositiveInteger(currentSource.allianceID, null) !==
      defenderAllianceID ||
    normalizePositiveInteger(target.allianceID, null) !== defenderAllianceID ||
    normalizePositiveInteger(currentSource.claimStructureID, null) !== targetID ||
    normalizePositiveInteger(currentSource.infrastructureHubID, null) !==
      targetID ||
    getStructureCampaignEpoch(target) !== campaignEpoch
  ) {
    return {
      success: false,
      errorMsg: "SOVEREIGNTY_CAMPAIGN_OUTCOME_FENCE_CHANGED",
    };
  }

  const beforeBySystemID = new Map();
  const removedNodeIDs = [];
  const receipt = normalizeCampaignOutcomeReceipt({
    targetID,
    solarSystemID,
    campaignEpoch,
    defenderAllianceID,
    result,
    completedAtTime,
    nodeIDs: [],
  });
  // The Hub's structure record and its upgrade and fuel ledger, taken before
  // the loss removes both, so the drop roll below sees what the Hub held.
  const lostHubStructure = result === "attacker" ? cloneValue(target) : null;
  let lostHubRecord = null;

  for (const [systemKey, cachedSystem] of Object.entries(
    tableCache.systems || {},
  )) {
    const numericSystemID = normalizePositiveInteger(systemKey, null);
    if (!numericSystemID || !cachedSystem) {
      continue;
    }
    const before = cloneValue(cachedSystem);
    let structuresChanged = false;
    let structures = (before.structures || []).filter((structure) => {
      if (
        isCampaignCommandNode(
          structure,
          targetID,
          campaignEpoch,
          requestedNodeIDs,
        )
      ) {
        const nodeID = normalizePositiveInteger(structure.itemID, null);
        if (nodeID) {
          removedNodeIDs.push(nodeID);
        }
        structuresChanged = true;
        return false;
      }
      return true;
    });

    const isSource = numericSystemID === solarSystemID;
    if (isSource && result === "attacker") {
      const filtered = structures.filter(
        (structure) =>
          normalizePositiveInteger(structure && structure.itemID, null) !==
          targetID,
      );
      structuresChanged = structuresChanged || filtered.length !== structures.length;
      structures = filtered;
    } else if (isSource) {
      structures = structures.map((structure) => {
        if (
          normalizePositiveInteger(structure && structure.itemID, null) !==
          targetID
        ) {
          return structure;
        }
        structuresChanged = true;
        return clearCompletedCampaignFields(structure, campaignEpoch);
      });
    }

    if (!isSource && !structuresChanged) {
      continue;
    }
    beforeBySystemID.set(numericSystemID, before);
    const nextValue = {
      ...before,
      structures,
    };
    if (isSource) {
      receipt.nodeIDs = [
        ...new Set([...requestedNodeIDs, ...removedNodeIDs]),
      ].sort((left, right) => left - right);
      nextValue.campaignOutcomeReceipts = {
        ...(before.campaignOutcomeReceipts || {}),
        [receiptKey]: receipt,
      };
      if (result === "attacker") {
        nextValue.allianceID = null;
        nextValue.corporationID = null;
        nextValue.claimStructureID = null;
        nextValue.infrastructureHubID = null;
        nextValue.claimTime = "0";
        nextValue.fuelAccessGroupID = null;
        nextValue.currentData = [];
        nextValue.devIndices = {
          ...(before.devIndices || {}),
          claimedForDays: 0,
        };
        nextValue.recentActivity = [
          {
            solarSystemID,
            ownerID: null,
            oldOwnerID: defenderAllianceID,
            stationID: null,
            changeTime: completedAtTime,
          },
          ...(Array.isArray(before.recentActivity)
            ? before.recentActivity
            : []),
        ];
      }
    }
    tableCache.systems[systemKey] = normalizeSystemState(
      nextValue,
      numericSystemID,
    );
  }

  // Node enumeration is constellation-wide and happens before the source is
  // normalized. Freeze the complete removed set into the source tombstone.
  receipt.nodeIDs = [
    ...new Set([...requestedNodeIDs, ...removedNodeIDs]),
  ].sort((left, right) => left - right);
  const pendingSource = tableCache.systems[sourceKey];
  pendingSource.campaignOutcomeReceipts = {
    ...(pendingSource.campaignOutcomeReceipts || {}),
    [receiptKey]: cloneValue(receipt),
  };
  tableCache.systems[sourceKey] = normalizeSystemState(
    pendingSource,
    solarSystemID,
  );

  if (result === "attacker") {
    tableCache.hubs =
      tableCache.hubs && typeof tableCache.hubs === "object"
        ? tableCache.hubs
        : {};
    for (const [hubKey, hub] of Object.entries(tableCache.hubs)) {
      if (
        normalizePositiveInteger(hubKey, null) === targetID ||
        normalizePositiveInteger(hub && hub.hubID, null) === targetID
      ) {
        lostHubRecord = lostHubRecord || cloneValue(hub);
        delete tableCache.hubs[hubKey];
      }
    }
    const allianceState = tableCache.alliances[String(defenderAllianceID)];
    if (allianceState && allianceState.capitalInfo) {
      if (
        normalizePositiveInteger(
          allianceState.capitalInfo.currentCapitalSystem,
          null,
        ) === solarSystemID
      ) {
        allianceState.capitalInfo.currentCapitalSystem = null;
      }
      if (
        normalizePositiveInteger(
          allianceState.capitalInfo.newCapitalSystem,
          null,
        ) === solarSystemID
      ) {
        allianceState.capitalInfo.newCapitalSystem = null;
        allianceState.capitalInfo.newCapitalSystemValidAfter = "0";
      }
    }

    reconcileSingleSystemCapitals([defenderAllianceID]);

    // Decision 5: the destroyed Hub's upgrades and fuel go through the normal
    // death drop roll into a wreck at the Hub. The summary lives on the
    // receipt, which is the fence against rolling or dropping twice.
    let drop = null;
    try {
      const { dropSovereigntyHubContents } = require(path.join(
        __dirname,
        "./sovHubLossDrops",
      ));
      drop = dropSovereigntyHubContents({
        structure: lostHubStructure,
        solarSystemID,
        hubRecord: lostHubRecord || {},
        campaignEpoch,
        nowMs: filetimeToUnixMs(completedAtTime, Date.now()),
      });
    } catch (error) {
      drop = {
        seed: "",
        containerID: null,
        containerTypeID: null,
        items: [],
        error: String((error && error.message) || error || "HUB_DROP_FAILED"),
      };
    }
    receipt.drop = normalizeHubLossDrop(drop);
    const droppedSource = tableCache.systems[sourceKey];
    droppedSource.campaignOutcomeReceipts = {
      ...(droppedSource.campaignOutcomeReceipts || {}),
      [receiptKey]: cloneValue(receipt),
    };
  }

  persist();
  try {
    const {
      invalidateSovereigntyModernStateCache,
    } = require(path.join(__dirname, "./sovModernState"));
    invalidateSovereigntyModernStateCache();
  } catch (_error) {
    // ignored: at bootstrap sovModernState is half-loaded (require cycle) and has no cache yet
  }
  for (const [changedSystemID, before] of beforeBySystemID.entries()) {
    publishSystemStateEffects(
      before,
      tableCache.systems[String(changedSystemID)] || null,
      options.effectOptions || {},
    );
  }
  return {
    success: true,
    data: {
      alreadyCompleted: false,
      receipt: cloneValue(receipt),
      system: cloneValue(tableCache.systems[sourceKey]),
      removedNodeIDs: cloneValue(receipt.nodeIDs),
    },
  };
}

/**
 * Marks the attacker-victory destruction notification after delivery. The
 * campaign outcome receipt is the durable idempotency key, so retries keep the
 * first delivery timestamp and never create or infer an outcome.
 */
function markSovereigntyCampaignDestroyedNotificationDelivered(options = {}) {
  ensureLoaded();
  const solarSystemID = normalizePositiveInteger(options.solarSystemID, null);
  const targetID = normalizePositiveInteger(options.targetID, null);
  const campaignEpoch = String(options.campaignEpoch || "").trim();
  const deliveredAtTime = normalizeFiletimeString(
    options.deliveredAtTime,
    "0",
  );
  if (
    !solarSystemID ||
    !targetID ||
    !campaignEpoch ||
    normalizeFiletimeBigInt(deliveredAtTime, 0n) <= 0n
  ) {
    return {
      success: false,
      errorMsg: "INVALID_SOVEREIGNTY_CAMPAIGN_DESTROYED_NOTIFICATION_MARK",
    };
  }

  const sourceKey = String(solarSystemID);
  const currentSource = cloneValue(tableCache.systems[sourceKey] || null);
  const receiptKey = buildCampaignOutcomeReceiptKey(targetID, campaignEpoch);
  const receipt = normalizeCampaignOutcomeReceipt(
    currentSource &&
      currentSource.campaignOutcomeReceipts &&
      currentSource.campaignOutcomeReceipts[receiptKey],
  );
  if (
    !receipt ||
    receipt.solarSystemID !== solarSystemID ||
    receipt.targetID !== targetID ||
    receipt.campaignEpoch !== campaignEpoch
  ) {
    return {
      success: false,
      errorMsg: "SOVEREIGNTY_CAMPAIGN_OUTCOME_RECEIPT_NOT_FOUND",
    };
  }
  if (receipt.result !== "attacker") {
    return {
      success: false,
      errorMsg:
        "SOVEREIGNTY_CAMPAIGN_DESTROYED_NOTIFICATION_NOT_APPLICABLE",
    };
  }
  if (
    normalizeFiletimeBigInt(
      receipt.destroyedNotificationDeliveredAtTime,
      0n,
    ) > 0n
  ) {
    return {
      success: true,
      data: {
        alreadyDelivered: true,
        receipt: cloneValue(receipt),
        system: cloneValue(currentSource),
      },
    };
  }

  receipt.destroyedNotificationDeliveredAtTime = deliveredAtTime;
  currentSource.campaignOutcomeReceipts = {
    ...(currentSource.campaignOutcomeReceipts || {}),
    [receiptKey]: receipt,
  };
  tableCache.systems[sourceKey] = normalizeSystemState(
    currentSource,
    solarSystemID,
  );
  tableCache = writeSovereigntyTable(tableCache);
  buildIndexes();
  return {
    success: true,
    data: {
      alreadyDelivered: false,
      receipt: cloneValue(receipt),
      system: cloneValue(tableCache.systems[sourceKey]),
    },
  };
}

function commitInitialSovereigntyHubCapture(options = {}) {
  ensureLoaded();
  const solarSystemID = normalizePositiveInteger(options.solarSystemID, null);
  const targetID = normalizePositiveInteger(options.targetID, null);
  const winnerAllianceID = normalizePositiveInteger(
    options.winnerAllianceID,
    null,
  );
  const executorCorporationID = normalizePositiveInteger(
    options.executorCorporationID,
    null,
  );
  const captureEpoch = String(options.captureEpoch || "").trim();
  const claimTime = normalizeFiletimeString(options.claimTime, "0");
  if (
    !solarSystemID ||
    !targetID ||
    !winnerAllianceID ||
    !executorCorporationID ||
    !captureEpoch ||
    claimTime === "0"
  ) {
    return { success: false, errorMsg: "INVALID_SOVEREIGNTY_CAPTURE_COMMIT" };
  }

  const current = cloneValue(tableCache.systems[String(solarSystemID)] || null);
  if (!current) {
    return { success: false, errorMsg: "SOVEREIGNTY_CAPTURE_TARGET_NOT_FOUND" };
  }
  const target = (current.structures || []).find(
    (structure) =>
      normalizePositiveInteger(structure && structure.itemID, null) === targetID &&
      normalizePositiveInteger(structure && structure.typeID, null) ===
        TYPE_INFRASTRUCTURE_HUB,
  );
  if (!target) {
    return { success: false, errorMsg: "SOVEREIGNTY_CAPTURE_TARGET_NOT_FOUND" };
  }
  const targetEpoch = String(
    (target.devFlags && target.devFlags.sovereigntyCaptureEpoch) ||
      (target.entosisCapture && target.entosisCapture.captureEpoch) ||
      "",
  ).trim();
  const receipt = normalizeCaptureCompletionReceipt(
    target.entosisCapture && target.entosisCapture.completionReceipt,
  );
  if (
    target.devFlags &&
    target.devFlags.sovereigntyCaptured === true &&
    receipt &&
    receipt.status === "completed" &&
    receipt.captureEpoch === captureEpoch &&
    receipt.winnerAllianceID === winnerAllianceID
  ) {
    // A completed capture receipt is a tombstone for this operation. Custody
    // can legitimately move later (executor transition or alliance lifecycle),
    // and replaying the old frozen executor must never roll that newer state
    // back. A subsequent hostile capture receives a new structure/epoch.
    return {
      success: true,
      data: { alreadyCompleted: true, system: cloneValue(current) },
    };
  }
  if (
    (targetEpoch && targetEpoch !== captureEpoch) ||
    !receipt ||
    receipt.captureEpoch !== captureEpoch ||
    receipt.winnerAllianceID !== winnerAllianceID ||
    receipt.executorCorporationID !== executorCorporationID
  ) {
    return { success: false, errorMsg: "SOVEREIGNTY_CAPTURE_FENCE_CHANGED" };
  }

  // The receipt deliberately freezes the executor for deterministic replay,
  // but it is not authority to resurrect a closed alliance or a corporation
  // that left before a prepared receipt could be recovered. The ordinary
  // prepare->commit path is synchronous; this fence protects startup repair
  // and manually/corruptly persisted receipts.
  const winnerAlliance = getAllianceRecord(winnerAllianceID);
  if (!winnerAlliance || winnerAlliance.deleted) {
    return {
      success: false,
      errorMsg: "SOVEREIGNTY_CAPTURE_WINNER_ALLIANCE_INACTIVE",
    };
  }
  const executorCorporation = getCorporationRecord(executorCorporationID);
  if (
    !executorCorporation ||
    executorCorporation.deleted ||
    executorCorporation.isNPC !== false ||
    normalizePositiveInteger(executorCorporation.allianceID, null) !==
      winnerAllianceID ||
    !getAllianceCorporationIDs(winnerAllianceID).includes(executorCorporationID)
  ) {
    return {
      success: false,
      errorMsg: "SOVEREIGNTY_CAPTURE_EXECUTOR_AUTHORITY_STALE",
    };
  }

  const previousAllianceID = normalizePositiveInteger(current.allianceID, null);
  const nextStructures = (current.structures || [])
    .filter((structure) => {
      const itemID = normalizePositiveInteger(structure && structure.itemID, null);
      const typeID = normalizePositiveInteger(structure && structure.typeID, null);
      if (typeID === TYPE_INFRASTRUCTURE_HUB && itemID !== targetID) {
        return false;
      }
      return true;
    })
    .map((structure) => {
      if (normalizePositiveInteger(structure && structure.itemID, null) !== targetID) {
        return structure;
      }
      return {
        ...structure,
        ownerID: executorCorporationID,
        corporationID: executorCorporationID,
        allianceID: winnerAllianceID,
        devFlags: {
          ...(structure.devFlags && typeof structure.devFlags === "object"
            ? structure.devFlags
            : {}),
          sovereigntyNeutralHub: false,
          sovereigntyCaptureEpoch: captureEpoch,
          sovereigntyCaptured: true,
        },
        entosisCapture: {
          ...(structure.entosisCapture || {}),
          schemaVersion: 1,
          captureEpoch,
          controllingTeamID: winnerAllianceID,
          scoringTeamID: winnerAllianceID,
          scoreAtLastUpdateTime: 1,
          lastUpdatedScoreTime: claimTime,
          scoringRate: 0,
          isBlocked: false,
          defenderTeamID: 1,
          completionCandidateAllianceID: winnerAllianceID,
          completionBlockedReason: null,
          completionReceipt: {
            ...receipt,
            status: "completed",
            claimTime,
            completedAtTime: claimTime,
          },
        },
      };
    });

  const next = normalizeSystemState(
    {
      ...current,
      allianceID: winnerAllianceID,
      corporationID: executorCorporationID,
      claimStructureID: targetID,
      infrastructureHubID: targetID,
      claimTime,
      fuelAccessGroupID: null,
      currentData: [],
      devIndices: {
        ...(current.devIndices || {}),
        claimedForDays: 0,
      },
      structures: nextStructures,
      recentActivity: [
        {
          solarSystemID,
          ownerID: winnerAllianceID,
          oldOwnerID: previousAllianceID,
          stationID: null,
          changeTime: claimTime,
        },
        ...(Array.isArray(current.recentActivity) ? current.recentActivity : []),
      ],
    },
    solarSystemID,
  );

  const displacedAllianceState =
    previousAllianceID && previousAllianceID !== winnerAllianceID
      ? tableCache.alliances[String(previousAllianceID)]
      : null;
  if (displacedAllianceState && displacedAllianceState.capitalInfo) {
    if (
      normalizePositiveInteger(
        displacedAllianceState.capitalInfo.currentCapitalSystem,
        null,
      ) === solarSystemID
    ) {
      displacedAllianceState.capitalInfo.currentCapitalSystem = null;
    }
    if (
      normalizePositiveInteger(
        displacedAllianceState.capitalInfo.newCapitalSystem,
        null,
      ) === solarSystemID
    ) {
      displacedAllianceState.capitalInfo.newCapitalSystem = null;
      displacedAllianceState.capitalInfo.newCapitalSystemValidAfter = "0";
    }
  }

  tableCache.hubs =
    tableCache.hubs && typeof tableCache.hubs === "object"
      ? tableCache.hubs
      : {};
  for (const [hubKey, hub] of Object.entries(tableCache.hubs)) {
    if (
      normalizePositiveInteger(hubKey, null) === targetID ||
      normalizePositiveInteger(hub && hub.solarSystemID, null) === solarSystemID
    ) {
      delete tableCache.hubs[hubKey];
    }
  }
  tableCache.hubs[String(targetID)] = {
    hubID: targetID,
    solarSystemID,
    corporationID: executorCorporationID,
    allianceID: winnerAllianceID,
    installedUpgrades: [],
    fuelByTypeID: {},
    fuelLastUpdatedMs: 0,
    workforceConfiguration: {
      hubID: targetID,
      mode: "inactive",
      sourceSystemIDs: [],
      destinationSystemID: null,
      amount: 0,
    },
    workforceLastUpdatedMs: 0,
    upgradesLastUpdatedMs: 0,
  };
  tableCache.systems[String(solarSystemID)] = next;
  reconcileSingleSystemCapitals([winnerAllianceID, current && current.allianceID]);
  persist();
  try {
    const {
      invalidateSovereigntyModernStateCache,
    } = require(path.join(__dirname, "./sovModernState"));
    invalidateSovereigntyModernStateCache();
  } catch (_error) {
    // ignored: at bootstrap sovModernState is half-loaded (require cycle) and has no cache yet
  }
  publishSystemStateEffects(current, next, options);
  return {
    success: true,
    data: { alreadyCompleted: false, system: cloneValue(next) },
  };
}

function setStructureCampaignState(
  solarSystemID,
  structureID,
  campaignState = {},
  options = {},
) {
  return mutateStructureInSystem(
    solarSystemID,
    structureID,
    (structure) => ({
      ...structure,
      campaignEventType: normalizeInteger(campaignState.campaignEventType, 0),
      campaignStartTime: normalizeFiletimeString(campaignState.campaignStartTime, "0"),
      campaignScoresByTeam:
        campaignState.campaignScoresByTeam !== undefined
          ? normalizeScoresByTeam(campaignState.campaignScoresByTeam)
          : cloneValue(structure.campaignScoresByTeam || {}),
    }),
    options,
  );
}

function clearStructureCampaignState(solarSystemID, structureID, options = {}) {
  return mutateStructureInSystem(
    solarSystemID,
    structureID,
    (structure) => ({
      ...structure,
      campaignEventType: 0,
      campaignStartTime: "0",
      campaignScoresByTeam: {},
    }),
    options,
  );
}

function setStructureCampaignScores(
  solarSystemID,
  structureID,
  campaignScoresByTeam = {},
  options = {},
) {
  const numericStructureID = normalizePositiveInteger(structureID, null);
  return mutateStructureInSystem(
    solarSystemID,
    structureID,
    (structure) => ({
      ...structure,
      campaignScoresByTeam: normalizeScoresByTeam(campaignScoresByTeam),
    }),
    {
      ...options,
      changesByStructureID: numericStructureID
        ? { [numericStructureID]: [STRUCTURE_SCORE_UPDATED] }
        : options.changesByStructureID,
    },
  );
}

function setStructureVulnerabilityState(
  solarSystemID,
  structureID,
  vulnerabilityState = {},
  options = {},
) {
  return mutateStructureInSystem(
    solarSystemID,
    structureID,
    (structure) => ({
      ...structure,
      vulnerableStartTime: normalizeFiletimeString(
        vulnerabilityState.vulnerableStartTime,
        "0",
      ),
      vulnerableEndTime: normalizeFiletimeString(
        vulnerabilityState.vulnerableEndTime,
        "0",
      ),
    }),
    options,
  );
}

function clearStructureVulnerabilityState(solarSystemID, structureID, options = {}) {
  return mutateStructureInSystem(
    solarSystemID,
    structureID,
    (structure) => ({
      ...structure,
      vulnerableStartTime: "0",
      vulnerableEndTime: "0",
    }),
    options,
  );
}

function listAllAllianceSystems() {
  ensureLoaded();
  return cloneValue(indexCache.allAllianceSystems);
}

function listAllianceSystems(allianceID) {
  ensureLoaded();
  const numericAllianceID = normalizePositiveInteger(allianceID, null);
  if (!numericAllianceID) {
    return [];
  }
  return cloneValue(indexCache.systemsByAllianceID.get(numericAllianceID) || []);
}

function getDevelopmentIndicesForSystem(solarSystemID) {
  const system = getSystemState(solarSystemID);
  const devIndices = system ? system.devIndices : normalizeDevIndices();
  return {
    [ATTRIBUTE_DEV_INDEX_MILITARY]: {
      points: devIndices.militaryPoints,
      increasing: devIndices.militaryIncreasing,
    },
    [ATTRIBUTE_DEV_INDEX_INDUSTRIAL]: {
      points: devIndices.industrialPoints,
      increasing: devIndices.industrialIncreasing,
    },
    [ATTRIBUTE_DEV_INDEX_SOVEREIGNTY]: {
      points: devIndices.claimedForDays * CLAIM_DAYS_TO_SECONDS,
      increasing: false,
    },
  };
}

function listAllDevelopmentIndices() {
  ensureLoaded();
  return cloneValue(indexCache.allDevelopmentIndices);
}

function listCurrentSovData(locationID) {
  ensureLoaded();
  const numericLocationID = normalizePositiveInteger(locationID, null);
  if (!numericLocationID) {
    return [];
  }
  return cloneValue(indexCache.currentSovDataByLocationID.get(numericLocationID) || []);
}

function listRecentSovActivity() {
  ensureLoaded();
  return cloneValue(indexCache.recentSovActivity);
}

function getSystemSovClaim(solarSystemID) {
  ensureLoaded();
  const numericSolarSystemID = normalizePositiveInteger(solarSystemID, null);
  if (!numericSolarSystemID) {
    return null;
  }
  return cloneValue(indexCache.claimsBySolarSystemID.get(numericSolarSystemID) || null);
}

// Destruction owns the same claim, Hub ledger and mirror handoff as campaign
// loss. A source receipt removes those resources before replayable loot grants.
function commitSovereigntyStructureDestruction(options = {}) {
  ensureLoaded();
  const structure = options.structure;
  const structureID = normalizePositiveInteger(structure?.structureID, null);
  const solarSystemID = normalizePositiveInteger(structure?.solarSystemID, null);
  const generation = String(options.generation || "");
  const ownerCorpID = normalizePositiveInteger(structure?.ownerCorpID, null);
  if (!structureID || !solarSystemID || !generation || !ownerCorpID)
    return { success: false, errorMsg: "INVALID_SOVEREIGNTY_STRUCTURE_DESTRUCTION" };
  const current = getSystemState(solarSystemID);
  if (!current) return { success: true, data: { canonical: false } };
  const key = `${structureID}:${generation}`;
  let receipt = current.structureDestructionReceipts?.[key];
  if (receipt && (receipt.ownerCorpID !== ownerCorpID || receipt.typeID !== structure.typeID))
    return { success: false, errorMsg: "SOVEREIGNTY_STRUCTURE_DESTRUCTION_FENCE_CHANGED" };
  const duplicate = receipt?.state === "completed";
  if (duplicate) {
    // A previous final flush or mirror projection may have failed after the
    // in-memory receipt changed. Verify durability and repair the projection
    // before acknowledging, without replaying settled inventory outputs.
    const flushed = require("../../gameStore").flushTablesSync(["sovereignty", "items", "notifications"]);
    if (!flushed.success) throw new Error(flushed.errorMsg);
    publishStructureDestructionEffects(receipt);
    return { success: true, data: cloneValue(receipt), duplicate: true };
  }
  if (!receipt) {
    const target = current.structures.find(entry => Number(entry.itemID) === structureID);
    if (!target) return { success: true, data: { canonical: false } };
    if (target.typeID !== structure.typeID || Number(target.corporationID || target.ownerID) !== ownerCorpID)
      return { success: false, errorMsg: "SOVEREIGNTY_STRUCTURE_DESTRUCTION_FENCE_CHANGED" };
    const previousTable = cloneValue(tableCache);
    const beforeBySystemID = {};
    const campaignEpoch = getStructureCampaignEpoch(target);
    receipt = { state: "pending", structureID, solarSystemID, generation, ownerCorpID,
      typeID: structure.typeID, allianceID: target.allianceID, structure: cloneValue(target),
      hubRecord: cloneValue(tableCache.hubs[String(structureID)] || {}),
      dropLocationID: options.dropLocationID || null, beforeBySystemID, completedAtMs: options.nowMs };
    for (const [systemKey, system] of Object.entries(tableCache.systems)) {
      const remaining = system.structures.filter(entry => Number(entry.itemID) !== structureID &&
        !isCampaignCommandNode(entry, structureID, campaignEpoch, new Set()));
      if (remaining.length === system.structures.length && Number(systemKey) !== solarSystemID) continue;
      beforeBySystemID[systemKey] = cloneValue(system);
      const next = { ...system, structures: remaining };
      if (Number(systemKey) === solarSystemID) {
        const claimLost = Number(system.claimStructureID) === structureID;
        if (claimLost) {
          Object.assign(next, { allianceID: null, corporationID: null, claimStructureID: null,
            claimTime: "0", fuelAccessGroupID: null, currentData: [],
            devIndices: { ...system.devIndices, claimedForDays: 0 },
            recentActivity: [{ solarSystemID, ownerID: null, oldOwnerID: system.allianceID,
              stationID: null, changeTime: unixMsToFiletimeString(options.nowMs) }, ...system.recentActivity] });
        }
        if (Number(system.infrastructureHubID) === structureID) next.infrastructureHubID = null;
        next.structureDestructionReceipts = { ...system.structureDestructionReceipts, [key]: receipt };
      }
      tableCache.systems[systemKey] = normalizeSystemState(next, Number(systemKey));
    }
    delete tableCache.hubs[String(structureID)];
    tableCache.systems[String(solarSystemID)].structureDestructionReceipts[key] = cloneValue(receipt);
    reconcileSingleSystemCapitals([target.allianceID]);
    try {
      persist();
      const flushed = require("../../gameStore").flushTableSync("sovereignty");
      if (!flushed.success) throw new Error(flushed.errorMsg);
    } catch (error) {
      tableCache = writeSovereigntyTable(previousTable);
      buildIndexes();
      throw error;
    }
    receipt = cloneValue(tableCache.systems[String(solarSystemID)].structureDestructionReceipts[key]);
  }
  let drop = null;
  if (receipt.typeID === TYPE_INFRASTRUCTURE_HUB) {
    drop = require("./sovHubLossDrops").dropSovereigntyHubContents({
      structure: receipt.structure, solarSystemID, hubRecord: receipt.hubRecord,
      campaignEpoch: generation, nowMs: receipt.completedAtMs, dropLocationID: receipt.dropLocationID,
      destructionKey: `structure-self-destruct:${structureID}:${generation}` });
    if (drop.error || drop.items.some(item => item.error))
      return { success: false, errorMsg: drop.error || "SOVEREIGNTY_STRUCTURE_DROP_PENDING" };
  }
  if (receipt.allianceID) {
    const notice = require("./sovCampaignNotifications").notifySovStructureDestroyed({
      defenderAllianceID: receipt.allianceID, structureTypeID: receipt.typeID, solarSystemID,
      eventKey: `self-destruct:${generation}`, created: unixMsToFiletimeString(receipt.completedAtMs) });
    if (!notice.success) return { success: false, errorMsg: "SOVEREIGNTY_STRUCTURE_DESTROYED_NOTIFICATION_FAILED" };
  }
  publishStructureDestructionEffects(receipt);
  const settled = { ...receipt, state: "completed", drop };
  const source = tableCache.systems[String(solarSystemID)];
  source.structureDestructionReceipts[key] = settled;
  persist();
  const flushed = require("../../gameStore").flushTablesSync(["sovereignty", "items", "notifications"]);
  if (!flushed.success) throw new Error(flushed.errorMsg);
  return { success: true, data: cloneValue(settled), duplicate };
}

function publishStructureDestructionEffects(receipt) {
  for (const [systemKey, before] of Object.entries(receipt.beforeBySystemID)) {
    const effects = publishSystemStateEffects(before, tableCache.systems[systemKey]);
    if (effects?.structureSyncResult?.success === false)
      throw new Error(effects.structureSyncResult.errorMsg || "SOVEREIGNTY_STRUCTURE_SYNC_FAILED");
  }
}

function getInfrastructureHubClaim(solarSystemID) {
  ensureLoaded();
  const numericSolarSystemID = normalizePositiveInteger(solarSystemID, null);
  if (!numericSolarSystemID) {
    return null;
  }
  return cloneValue(
    indexCache.infrastructureHubClaimsBySolarSystemID.get(numericSolarSystemID) || null,
  );
}

function listSovStructuresForSystem(solarSystemID) {
  ensureLoaded();
  const numericSolarSystemID = normalizePositiveInteger(solarSystemID, null);
  if (!numericSolarSystemID) {
    return [];
  }
  return cloneValue(indexCache.structureSnapshotsBySolarSystemID.get(numericSolarSystemID) || []);
}

function getAllianceSovereigntyRows(allianceID) {
  ensureLoaded();
  const numericAllianceID = normalizePositiveInteger(allianceID, null);
  if (!numericAllianceID) {
    return {
      tcuRows: [],
      iHubRows: [],
      campaignScoreRows: [],
    };
  }
  return cloneValue(
    indexCache.allianceSovRowsByAllianceID.get(numericAllianceID) || {
      tcuRows: [],
      iHubRows: [],
      campaignScoreRows: [],
    },
  );
}

function getFuelAccessGroupID(solarSystemID) {
  const system = getSystemState(solarSystemID);
  return system ? system.fuelAccessGroupID : null;
}

function setFuelAccessGroupID(solarSystemID, fuelAccessGroupID) {
  const system = upsertSystemState(solarSystemID, {
    fuelAccessGroupID: normalizePositiveInteger(fuelAccessGroupID, null),
  });
  return system ? system.fuelAccessGroupID : null;
}

function emitSovereigntyAudioEvent(
  solarSystemID,
  eventID,
  textParams = {},
  allianceIDs = [],
) {
  broadcastSovereigntyAudioEvent(solarSystemID, eventID, textParams, allianceIDs);
}

function emitSovHubHacked(
  solarSystemID,
  sovHubID,
  upgrades = [],
  allianceIDs = [],
) {
  broadcastSovHubHacked(solarSystemID, sovHubID, upgrades, allianceIDs);
}

function destroySkyhooks() {
  return [];
}

function acquireSkyhooks() {
  return [];
}

function getSovereigntyDebugSnapshot() {
  ensureLoaded();
  return cloneValue(indexCache.debugSnapshot);
}

function wipeAllSovereigntyState(options = {}) {
  const currentTable = readSovereigntyTable();
  const nextTable = buildDefaultSovereigntyTable();
  if (options.preserveResources !== false) {
    nextTable.resources = cloneStoreValue(
      currentTable && currentTable.resources ? currentTable.resources : nextTable.resources,
    );
  }
  if (options.preserveVersion !== false) {
    nextTable._meta.version = Math.max(
      1,
      normalizeInteger(
        currentTable && currentTable._meta && currentTable._meta.version,
        nextTable._meta.version,
      ),
    );
  }
  // A GM wipe is not the one-time reset; the marker that says the reset ran
  // stays.
  if (currentTable && currentTable._meta && currentTable._meta[SOVEREIGNTY_RESET_MARKER]) {
    nextTable._meta[SOVEREIGNTY_RESET_MARKER] = cloneStoreValue(
      currentTable._meta[SOVEREIGNTY_RESET_MARKER],
    );
  }
  // Remove the structure mirrors before the table is emptied. The modern
  // state derives Hub records from published Hub mirrors whenever it loads,
  // so mirrors that outlive the wipe would put their Hubs straight back.
  clearAllSovereigntyRelatedStructures({
    broadcast: options.broadcast === true,
    syncScene: options.syncScene === true,
    excludedSession: options.excludedSession || null,
  });
  tableCache = writeSovereigntyTable(nextTable);
  indexCache = null;
  try {
    const {
      invalidateSovereigntyModernStateCache,
    } = require(path.join(__dirname, "./sovModernState"));
    invalidateSovereigntyModernStateCache();
  } catch (_error) {
    // ignored: at bootstrap sovModernState is half-loaded (require cycle) and has no cache yet
  }
  buildIndexes();
  return cloneValue(tableCache);
}

function resetSovereigntyStateForTests() {
  tableCache = null;
  indexCache = null;
  clearAllSovereigntyRelatedStructures({
    broadcast: false,
    syncScene: false,
  });
}

module.exports = {
  ATTRIBUTE_DEV_INDEX_INDUSTRIAL,
  ATTRIBUTE_DEV_INDEX_MILITARY,
  ATTRIBUTE_DEV_INDEX_SOVEREIGNTY,
  TYPE_INFRASTRUCTURE_HUB,
  acquireSkyhooks,
  cancelAllianceCapitalTransition,
  clearStructureCampaignState,
  clearStructureVulnerabilityState,
  commitInitialSovereigntyHubCapture,
  commitSovereigntyCommandNodeCapture,
  commitSovereigntyHubCampaignOutcome,
  commitSovereigntyStructureDestruction,
  destroySkyhooks,
  emitSovHubHacked,
  emitSovereigntyAudioEvent,
  getAllianceCapitalInfo,
  getAlliancePrimeInfo,
  getAllianceSovereigntyRows,
  getAllianceSovereigntySnapshot,
  getDevelopmentIndicesForSystem,
  getFuelAccessGroupID,
  findSovereigntyStructureByID,
  getInfrastructureHubClaim,
  getOperationalIndexLevel,
  getStrategicIndexLevel,
  getSovereigntyDebugSnapshot,
  wipeAllSovereigntyState,
  listCurrentSovData,
  listRecentSovActivity,
  markSovereigntyCampaignDestroyedNotificationDelivered,
  getSystemSovClaim,
  getSystemDefenseMultiplier,
  getSystemState,
  listAllAllianceSystems,
  listAllSovereigntySystemStates,
  listAllDevelopmentIndices,
  listAllianceSystems,
  listSovStructuresForSystem,
  publishSystemStateEffects,
  replaceSystemStateSnapshot,
  resetSovereigntyStateForTests,
  setAllianceCapitalSystem,
  setAlliancePrimeHour,
  setFuelAccessGroupID,
  setStructureCampaignScores,
  setStructureCampaignState,
  setStructureEntosisCapture,
  setStructureVulnerabilityState,
  tickStrategicClaimAge,
  upsertAllianceState,
  upsertSystemState,
};
