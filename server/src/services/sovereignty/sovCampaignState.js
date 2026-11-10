"use strict";

const {
  cloneValue,
} = require("../../common/clone");

const path = require("node:path");

const worldData = require(path.join(__dirname, "../../space/worldData"));
const { createRng } = require(path.join(__dirname, "../../common/random"));
const {
  FILETIME_EPOCH_OFFSET,
  FILETIME_TICKS_PER_MILLISECOND,
  TYPE_INFRASTRUCTURE_HUB,
} = require(path.join(__dirname, "./sovConstants"));
const {
  findSovereigntyStructureByID,
  commitSovereigntyCommandNodeCapture,
  commitSovereigntyHubCampaignOutcome,
  markSovereigntyCampaignDestroyedNotificationDelivered,
  getSystemDefenseMultiplier,
  getAlliancePrimeInfo,
  getAllianceCapitalInfo,
  getSystemState,
  listAllSovereigntySystemStates,
  upsertSystemState,
} = require(path.join(__dirname, "./sovState"));
const {
  isSovereigntyClaimableSolarSystem,
} = require(path.join(__dirname, "./sovSystemRules"));
const campaignNotifications = require(path.join(
  __dirname,
  "./sovCampaignNotifications",
));
const {
  syncSovereigntyStructureRuntime,
} = require(path.join(__dirname, "./sovSpaceInterop"));

// Client static data 3396210 (fsd spacecomponentsbytype): type 32458
// entosisSovereigntyHub captureTimeSeconds 595, defensiveRegenRate 0.2; type
// 34832 entosisCommandNode captureTimeSeconds 235, defensiveRegenRate 0.04.
// The client's entosis timer (entosis/ui/entosisController.py) divides by the
// same captureTimeSeconds, so the server must use these values.
const OWNED_HUB_CAPTURE_TIME_SECONDS = 595;
const COMMAND_NODE_CAPTURE_TIME_SECONDS = 235;
const DEFENDER_REGEN_RATE = 0.2;
const COMMAND_NODE_DEFENDER_REGEN_RATE = 0.04;
const INITIAL_CAMPAIGN_DEFENDER_SCORE = 0.6;
const NODE_SCORE_DELTA = 0.07;
const INITIAL_COMMAND_NODE_COUNT = 4;
const MAX_COMMAND_NODES_PER_SYSTEM = 5;
const MAX_COMMAND_NODES_PER_CONSTELLATION = 20;
// Retail spawns more nodes while an event runs, but no source gives the rate
// (doc/SOV_PARITY_CLEANUP_PLAN.md, section 1). One node every 30 minutes on
// average, drawn between 15 and 45 minutes, is the working assumption.
const EXTRA_COMMAND_NODE_SPAWN_INTERVAL_MS = 30 * 60 * 1000;
const EXTRA_COMMAND_NODE_SPAWN_JITTER = 0.5;
const COMMAND_NODE_TYPE_ID = 34832;
const CAMPAIGN_EVENT_TYPE = 2;
const DAY_MS = 24 * 60 * 60 * 1000;
const REINFORCEMENT_DELAY_MS = 48 * 60 * 60 * 1000;
const DURABLE_CAMPAIGN_TICK_JOB_TYPE = "sovereignty.campaign-tick";
const DURABLE_CAMPAIGN_TICK_JOB_PREFIX = "sovereignty-campaign:";

// Ship modules are process-local. Only checkpoints and campaign state are
// durable; restoring live links after downtime would create ghost captures.
const ownedHubRuntimes = new Map();
const commandNodeRuntimes = new Map();
const completedCampaigns = new Map();
let durableScheduler = null;

// Retail draws the reinforcement exit and the command node systems at random.
// Tests seed this source so a run repeats exactly.
let campaignRandom = Math.random;

// A function is used as is, a seed string or number builds a generator, and
// null restores Math.random.
function setCampaignRandomSource(source = null) {
  if (typeof source === "function") {
    campaignRandom = source;
  } else if (source === null || source === undefined) {
    campaignRandom = Math.random;
  } else {
    campaignRandom = createRng(source);
  }
  return campaignRandom;
}

function drawCampaignRandom() {
  const value = Number(campaignRandom());
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.min(value, 1 - Number.EPSILON);
}

function normalizeInteger(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function normalizePositiveInteger(value, fallback = null) {
  const integer = normalizeInteger(value, 0);
  return integer > 0 ? integer : fallback;
}

function normalizeNowMs(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0
    ? Math.trunc(numeric)
    : Date.now();
}

function clampScore(value) {
  const numeric = Number(value);
  return Math.max(0, Math.min(1, Number.isFinite(numeric) ? numeric : 0));
}

function unixMsToFiletimeString(nowMs) {
  return (
    FILETIME_EPOCH_OFFSET +
    BigInt(normalizeNowMs(nowMs)) * FILETIME_TICKS_PER_MILLISECOND
  ).toString();
}

function filetimeToUnixMs(value, fallback = 0) {
  try {
    const filetime = BigInt(String(value || "0"));
    if (filetime <= FILETIME_EPOCH_OFFSET) {
      return fallback;
    }
    return Number(
      (filetime - FILETIME_EPOCH_OFFSET) / FILETIME_TICKS_PER_MILLISECOND,
    );
  } catch (_error) {
    return fallback;
  }
}

function success(data = {}, extra = {}) {
  return { success: true, data, ...extra };
}

// The next moment an idle Hub's window needs the engine: the window opening,
// its prime hour (to lock the next window's length) and the moment after it
// closes (to roll to the next window). Always strictly after nowMs, so a
// job that fires at one of these times re-arms for the next one.
function nextWindowEventMs(state, nowMs) {
  const startMs = Number(state.vulnerableStartMs);
  const endMs = Number(state.vulnerableEndMs);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return null;
  }
  const candidates = [startMs, endMs + 1];
  if (!state.nextWindowLock) {
    candidates.push(startMs + Math.floor((endMs - startMs) / 2));
  }
  const ahead = candidates.filter((entry) => entry > nowMs);
  return ahead.length > 0 ? Math.min(...ahead) : endMs + 1;
}

function buildCampaignTickJob(state, campaign = null, nowMs = null) {
  if (!state || !normalizePositiveInteger(state.targetID, null)) {
    return null;
  }
  if (state.phase === "secure" || state.phase === "vulnerable") {
    const windowEventMs = nextWindowEventMs(
      state,
      Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now(),
    );
    if (windowEventMs === null) {
      return null;
    }
    return {
      jobID:
        `${DURABLE_CAMPAIGN_TICK_JOB_PREFIX}${Number(state.targetID)}:` +
        `${String(state.captureEpoch || state.vulnerableStartMs)}`,
      type: DURABLE_CAMPAIGN_TICK_JOB_TYPE,
      dueAtMs: windowEventMs,
      payload: {
        targetID: Number(state.targetID),
        captureEpoch: String(state.captureEpoch || ""),
        windowEventMs,
      },
    };
  }
  if (
    (state.phase !== "reinforced" && state.phase !== "campaign") ||
    !Number.isFinite(Number(state.reinforcementExitMs))
  ) {
    return null;
  }
  const nextExtraNodeSpawnMs =
    state.phase === "campaign" &&
    campaign &&
    campaign.status === "active" &&
    Number.isFinite(Number(campaign.nextExtraNodeSpawnMs))
      ? Number(campaign.nextExtraNodeSpawnMs)
      : null;
  return {
    jobID:
      `${DURABLE_CAMPAIGN_TICK_JOB_PREFIX}${Number(state.targetID)}:` +
      `${String(state.captureEpoch || state.reinforcementExitMs)}`,
    type: DURABLE_CAMPAIGN_TICK_JOB_TYPE,
    dueAtMs: nextExtraNodeSpawnMs === null
      ? Number(state.reinforcementExitMs)
      : Math.max(Number(state.reinforcementExitMs), nextExtraNodeSpawnMs),
    payload: {
      targetID: Number(state.targetID),
      captureEpoch: String(state.captureEpoch || ""),
      reinforcementExitMs: Number(state.reinforcementExitMs),
      ...(nextExtraNodeSpawnMs === null ? {} : { nextExtraNodeSpawnMs }),
    },
  };
}

async function scheduleCampaignTick(state, campaign = null, nowMs = null) {
  if (!durableScheduler) {
    return null;
  }
  const job = buildCampaignTickJob(state, campaign, nowMs);
  if (!job) {
    return null;
  }
  await durableScheduler.schedule(job);
  return job;
}

function queueCampaignTick(state, campaign = null, nowMs = null) {
  if (!durableScheduler) {
    return;
  }
  void scheduleCampaignTick(state, campaign, nowMs).catch(() => {
    // Startup reconciliation requeues the durable receipt. The scheduler is a
    // delivery mechanism; the canonical due time remains on the Hub itself.
  });
}

function failure(errorMsg) {
  return { success: false, errorMsg };
}

function findStructureIndex(system, structureID) {
  return (Array.isArray(system && system.structures) ? system.structures : [])
    .findIndex((entry) => Number(entry && entry.itemID) === Number(structureID));
}

function mutateStructure(solarSystemID, structureID, mutator, options = {}) {
  const system = cloneValue(getSystemState(solarSystemID));
  if (!system) {
    return null;
  }
  const index = findStructureIndex(system, structureID);
  if (index < 0) {
    return null;
  }
  const structures = cloneValue(system.structures || []);
  structures[index] = mutator(cloneValue(structures[index]));
  return upsertSystemState(
    solarSystemID,
    { structures },
    { suppressNotifications: true, ...options },
  );
}

function resolveOwnedHub(options = {}) {
  const targetID = normalizePositiveInteger(options.targetID, null);
  const solarSystemID = normalizePositiveInteger(options.solarSystemID, null);
  if (!targetID) {
    return failure("SOVEREIGNTY_CAPTURE_TARGET_REQUIRED");
  }
  const found = findSovereigntyStructureByID(targetID, solarSystemID);
  if (!found || Number(found.structure && found.structure.typeID) !== TYPE_INFRASTRUCTURE_HUB) {
    return failure("SOVEREIGNTY_OWNED_HUB_NOT_FOUND");
  }
  const defenderAllianceID = normalizePositiveInteger(
    found.structure.allianceID || found.system.allianceID,
    null,
  );
  const defenderCorporationID = normalizePositiveInteger(
    found.structure.corporationID || found.system.corporationID,
    null,
  );
  if (
    !defenderAllianceID ||
    !defenderCorporationID ||
    Number(found.system.claimStructureID) !== targetID ||
    Number(found.system.infrastructureHubID) !== targetID
  ) {
    return failure("SOVEREIGNTY_CAPTURE_TARGET_NOT_OWNED");
  }
  return success({
    targetID,
    solarSystemID: Number(found.solarSystemID),
    defenderAllianceID,
    defenderCorporationID,
    system: found.system,
    structure: found.structure,
  });
}

function getHubMetadata(structure) {
  const flags = structure && structure.devFlags;
  const state = flags && flags.sovereigntyOwnedHubCapture;
  return state && typeof state === "object" ? cloneValue(state) : null;
}

function getCampaignMetadata(structure) {
  const flags = structure && structure.devFlags;
  const state = flags && flags.sovereigntyCampaign;
  return state && typeof state === "object" ? cloneValue(state) : null;
}

function buildHubEntosisCapture(state, liveState = {}) {
  return {
    schemaVersion: 1,
    captureEpoch: state.captureEpoch,
    controllingTeamID: state.defenderAllianceID,
    scoringTeamID: liveState.scoringTeamID ?? null,
    scoreAtLastUpdateTime: clampScore(state.scoreAtLastUpdateTime),
    lastUpdatedScoreTime: unixMsToFiletimeString(state.lastUpdatedMs),
    scoringRate: Number(liveState.scoringRate || 0),
    isBlocked: liveState.isBlocked === true,
    defenderTeamID: state.defenderAllianceID,
  };
}

function writeHubMetadata(target, state, liveState = {}, options = {}) {
  return mutateStructure(
    target.solarSystemID,
    target.targetID,
    (structure) => ({
      ...structure,
      defenseMultiplier: Number(state.occupancyMultiplier || 1),
      campaignOccupancyLevel: Number(state.occupancyMultiplier || 1),
      vulnerabilityOccupancyLevel: Number(state.occupancyMultiplier || 1),
      vulnerableStartTime: unixMsToFiletimeString(state.vulnerableStartMs),
      vulnerableEndTime: unixMsToFiletimeString(state.vulnerableEndMs),
      campaignEventType:
        state.phase === "reinforced" || state.phase === "campaign"
          ? CAMPAIGN_EVENT_TYPE
          : Number(structure.campaignEventType || 0),
      campaignStartTime:
        state.reinforcementExitMs
          ? unixMsToFiletimeString(state.reinforcementExitMs)
          : String(structure.campaignStartTime || "0"),
      entosisCapture: buildHubEntosisCapture(state, liveState),
      devFlags: {
        ...(structure.devFlags || {}),
        sovereigntyOwnedHubCapture: cloneValue(state),
      },
    }),
    options,
  );
}

function checkpointHubAt(target, state, runtime, nowMs) {
  const liveState = deriveHubLiveState(state, runtime, nowMs);
  const elapsedSeconds = Math.max(
    0,
    nowMs - Number(state.lastUpdatedMs || nowMs),
  ) / 1000;
  state.scoreAtLastUpdateTime = clampScore(
    Number(state.scoreAtLastUpdateTime) +
      elapsedSeconds * Number(liveState.scoringRate) /
        OWNED_HUB_CAPTURE_TIME_SECONDS,
  );
  state.lastUpdatedMs = nowMs;
  return liveState;
}

function getOrCreateRuntime(map, itemID) {
  const numericID = Number(itemID);
  let runtime = map.get(numericID);
  if (!runtime) {
    runtime = { links: new Map() };
    map.set(numericID, runtime);
  }
  return runtime;
}

function getLiveTeams(runtime, defenderAllianceID) {
  const teams = new Set();
  if (runtime) {
    for (const link of runtime.links.values()) {
      if (!link || link.phase !== "scoring") {
        continue;
      }
      teams.add(
        Number(link.allianceID) === Number(defenderAllianceID)
          ? Number(defenderAllianceID)
          : -Number(defenderAllianceID),
      );
    }
  }
  return [...teams];
}

function deriveHubLiveState(state, runtime, nowMs) {
  const teams = getLiveTeams(runtime, state.defenderAllianceID);
  if (teams.length > 1) {
    return { scoringTeamID: null, scoringRate: 0, isBlocked: true };
  }
  if (teams.length === 1) {
    const teamID = teams[0];
    return {
      scoringTeamID: teamID,
      scoringRate:
        teamID === Number(state.defenderAllianceID)
          ? 1
          : -1 / Math.max(1, Number(state.occupancyMultiplier || 1)),
      isBlocked: false,
    };
  }
  const canRegenerate =
    (state.phase === "vulnerable" || state.phase === "overtime") &&
    Number(state.scoreAtLastUpdateTime) < 1 &&
    nowMs >= Number(state.vulnerableStartMs || 0);
  return {
    scoringTeamID: canRegenerate ? Number(state.defenderAllianceID) : null,
    scoringRate: canRegenerate ? DEFENDER_REGEN_RATE : 0,
    isBlocked: false,
  };
}

// Retail: a captured Hub is reinforced for about 48 hours and comes out at a
// random moment inside its owner's vulnerability window. The window used is
// the first daily window still open 48 hours after the capture, and the draw
// covers the part of it at or after that mark. The chosen time is persisted on
// the Hub as reinforcementExitMs and is the due time of the durable tick.
function scheduleReinforcementExit(state, nowMs) {
  const duration = Math.max(
    1,
    Number(state.vulnerableEndMs) - Number(state.vulnerableStartMs),
  );
  let windowStartMs = Number(state.vulnerableStartMs);
  const earliestMs = nowMs + REINFORCEMENT_DELAY_MS;
  while (windowStartMs + duration <= earliestMs) {
    windowStartMs += DAY_MS;
  }
  const fromMs = Math.max(windowStartMs, earliestMs);
  const toMs = windowStartMs + duration;
  const latestMs = Math.max(fromMs, toMs - 1);
  return Math.min(
    latestMs,
    Math.trunc(fromMs + drawCampaignRandom() * (toMs - fromMs)),
  );
}

function buildDailyVulnerabilityWindow(target, nowMs) {
  const primeInfo = getAlliancePrimeInfo(target.defenderAllianceID) || {};
  const primeHour = Math.max(
    0,
    Math.min(23, normalizeInteger(primeInfo.currentPrimeHour, 0)),
  );
  const capitalInfo = getAllianceCapitalInfo(target.defenderAllianceID) || {};
  const occupancyMultiplier = getSystemDefenseMultiplier(
    target.system,
    Number(capitalInfo.currentCapitalSystem || 0) ===
      Number(target.solarSystemID),
  );
  const durationMs = Math.max(
    60 * 60 * 1000,
    Math.round((18 * 60 * 60 * 1000) / occupancyMultiplier),
  );
  const date = new Date(nowMs);
  let centerMs = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    primeHour,
  );
  let vulnerableStartMs = centerMs - Math.floor(durationMs / 2);
  let vulnerableEndMs = vulnerableStartMs + durationMs;
  if (nowMs > vulnerableEndMs) {
    vulnerableStartMs += DAY_MS;
    vulnerableEndMs += DAY_MS;
  }
  return { vulnerableStartMs, vulnerableEndMs, occupancyMultiplier };
}

function resolvePrimeHour(allianceID) {
  const primeInfo = getAlliancePrimeInfo(allianceID) || {};
  return Math.max(0, Math.min(23, normalizeInteger(primeInfo.currentPrimeHour, 0)));
}

// The prime-hour instant nearest to atMs. Daily windows are shorter than a
// day, so the window that contains a moment is the one centred nearest it.
function nearestPrimeHourCenter(primeHour, atMs) {
  const date = new Date(atMs);
  const dayCenterMs = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    primeHour,
  );
  let nearestMs = dayCenterMs;
  for (const candidateMs of [dayCenterMs - DAY_MS, dayCenterMs + DAY_MS]) {
    if (Math.abs(candidateMs - atMs) < Math.abs(nearestMs - atMs)) {
      nearestMs = candidateMs;
    }
  }
  return nearestMs;
}

function windowCenterMs(state) {
  const startMs = Number(state.vulnerableStartMs);
  const endMs = Number(state.vulnerableEndMs);
  return startMs + Math.floor((endMs - startMs) / 2);
}

// The window length the system's ADM gives right now: 18 hours divided by
// the multiplier, at least one hour.
function sampleWindowLength(target) {
  const capitalInfo = getAllianceCapitalInfo(target.defenderAllianceID) || {};
  const occupancyMultiplier = getSystemDefenseMultiplier(
    getSystemState(target.solarSystemID) || target.system,
    Number(capitalInfo.currentCapitalSystem || 0) ===
      Number(target.solarSystemID),
  );
  return {
    durationMs: Math.max(
      60 * 60 * 1000,
      Math.round((18 * 60 * 60 * 1000) / occupancyMultiplier),
    ),
    occupancyMultiplier,
  };
}

function resolveWindowLength(target, state, centerMs) {
  const lock = state.nextWindowLock;
  if (
    lock &&
    Number(lock.centerMs) === centerMs &&
    Number(lock.durationMs) > 0
  ) {
    return {
      durationMs: Number(lock.durationMs),
      occupancyMultiplier: Number(lock.occupancyMultiplier || 1),
    };
  }
  return sampleWindowLength(target);
}

// Retail locks a window's length at the prime hour the day before it. The
// lock is taken on the first engine evaluation at or after the current
// window's prime hour, from the ADM at that moment. A Hub nobody evaluates
// between that hour and the next window gets the ADM at the first evaluation
// after it. The lock is spent when the engine rolls to that window.
function lockNextWindowIfDue(target, state, nowMs) {
  if (
    !Number.isFinite(Number(state.vulnerableStartMs)) ||
    !Number.isFinite(Number(state.vulnerableEndMs))
  ) {
    return false;
  }
  const currentCenterMs = windowCenterMs(state);
  if (nowMs < currentCenterMs) {
    return false;
  }
  const primeHour = resolvePrimeHour(target.defenderAllianceID);
  const nextCenterMs = nearestPrimeHourCenter(primeHour, currentCenterMs + DAY_MS);
  if (nextCenterMs <= nowMs) {
    return false;
  }
  const lock = state.nextWindowLock;
  if (lock && Number(lock.centerMs) === nextCenterMs) {
    return false;
  }
  const sample = sampleWindowLength(target);
  state.nextWindowLock = {
    centerMs: nextCenterMs,
    durationMs: sample.durationMs,
    occupancyMultiplier: sample.occupancyMultiplier,
    lockedAtMs: nowMs,
  };
  return true;
}

// Moves the engine window to the next daily window: the first one centred
// on a prime hour after the anchor (the current window, or the window a
// fight happened in) that is still ahead of nowMs. By default a window
// still open counts; startAfterNow requires one that has not opened yet,
// which is what a successful defence needs ("secure until the next day's
// window"). The length comes from the lock when the lock is for that
// window, and from the ADM now otherwise.
function rollToNextDailyWindow(target, state, nowMs, options = {}) {
  const primeHour = resolvePrimeHour(target.defenderAllianceID);
  const anchorCenterMs = Number.isFinite(Number(options.anchorMs))
    ? nearestPrimeHourCenter(primeHour, Number(options.anchorMs))
    : windowCenterMs(state);
  let centerMs = nearestPrimeHourCenter(
    primeHour,
    Math.max(anchorCenterMs + DAY_MS, nowMs - DAY_MS),
  );
  for (let guard = 0; guard < 1000; guard += 1) {
    const length = resolveWindowLength(target, state, centerMs);
    const startMs = centerMs - Math.floor(length.durationMs / 2);
    const endMs = startMs + length.durationMs;
    if (options.startAfterNow ? startMs > nowMs : endMs > nowMs) {
      state.vulnerableStartMs = startMs;
      state.vulnerableEndMs = endMs;
      state.occupancyMultiplier = length.occupancyMultiplier;
      state.nextWindowLock = null;
      return state;
    }
    centerMs = nearestPrimeHourCenter(primeHour, centerMs + DAY_MS);
  }
  return state;
}

function ensureOwnedHubVulnerability(options = {}) {
  const targetResult = resolveOwnedHub(options);
  if (!targetResult.success) {
    return targetResult;
  }
  const target = targetResult.data;
  const nowMs = normalizeNowMs(options.nowMs);
  let state = getHubMetadata(target.structure);
  if (!state) {
    const window = buildDailyVulnerabilityWindow(target, nowMs);
    state = {
      schemaVersion: 1,
      captureEpoch:
        `owned-hub:${target.solarSystemID}:${target.targetID}:` +
        `${window.vulnerableStartMs}`,
      targetID: target.targetID,
      solarSystemID: target.solarSystemID,
      defenderAllianceID: target.defenderAllianceID,
      defenderCorporationID: target.defenderCorporationID,
      phase:
        nowMs >= window.vulnerableStartMs && nowMs <= window.vulnerableEndMs
          ? "vulnerable"
          : "secure",
      scoreAtLastUpdateTime: 1,
      lastUpdatedMs: nowMs,
      ...window,
      reinforcementExitMs: null,
      attackerAllianceID: null,
      nextWindowLock: null,
    };
    lockNextWindowIfDue(target, state, nowMs);
    if (!writeHubMetadata(target, state)) {
      return failure("SOVEREIGNTY_VULNERABILITY_CHECKPOINT_FAILED");
    }
    queueCampaignTick(state, null, nowMs);
    return success(cloneValue(state), { created: true });
  }

  const locked = lockNextWindowIfDue(target, state, nowMs);
  // A window that opened and saw no attack is over when it ends: the Hub is
  // idle at full score with no link on it, so it rolls to the next window
  // like a secure one. A fight past the end is overtime and stays with the
  // capture tick.
  const idleWindowOver =
    state.phase === "vulnerable" &&
    Number(state.scoreAtLastUpdateTime) >= 1 - 1e-9 &&
    getLiveTeams(ownedHubRuntimes.get(target.targetID) || null, target.defenderAllianceID).length === 0 &&
    nowMs > Number(state.vulnerableEndMs);
  if (idleWindowOver) {
    state.phase = "secure";
  }
  if (
    state.phase === "secure" &&
    nowMs >= Number(state.vulnerableStartMs) &&
    nowMs <= Number(state.vulnerableEndMs)
  ) {
    state.phase = "vulnerable";
    state.lastUpdatedMs = nowMs;
    if (!writeHubMetadata(target, state)) {
      return failure("SOVEREIGNTY_VULNERABILITY_CHECKPOINT_FAILED");
    }
    queueCampaignTick(state, null, nowMs);
    return success(cloneValue(state), { transitioned: true });
  }
  if (
    state.phase === "secure" &&
    nowMs > Number(state.vulnerableEndMs)
  ) {
    rollToNextDailyWindow(target, state, nowMs);
    state.captureEpoch =
      `owned-hub:${target.solarSystemID}:${target.targetID}:` +
      `${state.vulnerableStartMs}`;
    state.lastUpdatedMs = nowMs;
    state.phase =
      nowMs >= Number(state.vulnerableStartMs) &&
      nowMs <= Number(state.vulnerableEndMs)
        ? "vulnerable"
        : "secure";
    if (!writeHubMetadata(target, state)) {
      return failure("SOVEREIGNTY_VULNERABILITY_CHECKPOINT_FAILED");
    }
    queueCampaignTick(state, null, nowMs);
    return success(cloneValue(state), {
      transitioned: state.phase === "vulnerable",
    });
  }
  if (locked) {
    if (!writeHubMetadata(target, state)) {
      return failure("SOVEREIGNTY_VULNERABILITY_CHECKPOINT_FAILED");
    }
    queueCampaignTick(state, null, nowMs);
  }
  return success(cloneValue(state));
}

function configureSovereigntyVulnerability(options = {}) {
  const targetResult = resolveOwnedHub(options);
  if (!targetResult.success) {
    return targetResult;
  }
  const target = targetResult.data;
  const nowMs = normalizeNowMs(options.nowMs);
  const vulnerableStartMs = normalizeNowMs(options.vulnerableStartMs);
  const vulnerableEndMs = normalizeNowMs(options.vulnerableEndMs);
  if (vulnerableEndMs <= vulnerableStartMs) {
    return failure("SOVEREIGNTY_VULNERABILITY_WINDOW_INVALID");
  }
  const capitalInfo = getAllianceCapitalInfo(target.defenderAllianceID) || {};
  const occupancyMultiplier = getSystemDefenseMultiplier(
    target.system,
    Number(capitalInfo.currentCapitalSystem || 0) ===
      Number(target.solarSystemID),
  );
  const state = {
    schemaVersion: 1,
    captureEpoch: `owned-hub:${target.solarSystemID}:${target.targetID}:${nowMs}`,
    targetID: target.targetID,
    solarSystemID: target.solarSystemID,
    defenderAllianceID: target.defenderAllianceID,
    defenderCorporationID: target.defenderCorporationID,
    phase: "vulnerable",
    scoreAtLastUpdateTime: 1,
    lastUpdatedMs: nowMs,
    vulnerableStartMs,
    vulnerableEndMs,
    occupancyMultiplier,
    reinforcementExitMs: null,
    attackerAllianceID: null,
    nextWindowLock: null,
  };
  const persisted = writeHubMetadata(target, state);
  if (!persisted) {
    return failure("SOVEREIGNTY_VULNERABILITY_CHECKPOINT_FAILED");
  }
  ownedHubRuntimes.delete(target.targetID);
  queueCampaignTick(state, null, nowMs);
  return success(cloneValue(state));
}

function registerOwnedHubEntosisWarmup(options = {}) {
  const targetResult = resolveOwnedHub(options);
  if (!targetResult.success) {
    return targetResult;
  }
  const target = targetResult.data;
  const ensured = ensureOwnedHubVulnerability(options);
  if (!ensured.success) {
    return ensured;
  }
  const refreshedTargetResult = resolveOwnedHub(options);
  if (!refreshedTargetResult.success) {
    return refreshedTargetResult;
  }
  const refreshedTarget = refreshedTargetResult.data;
  const state = getHubMetadata(refreshedTarget.structure);
  const linkID = normalizePositiveInteger(options.linkID, null);
  const allianceID = normalizePositiveInteger(options.allianceID, null);
  if (!state || !linkID || !allianceID) {
    return failure("SOVEREIGNTY_ENTOSIS_WARMUP_INVALID");
  }
  const runtime = getOrCreateRuntime(ownedHubRuntimes, refreshedTarget.targetID);
  runtime.links.set(linkID, {
    linkID,
    allianceID,
    phase: "warmup",
    warmedAtMs: normalizeNowMs(options.nowMs),
  });
  return success({ targetID: refreshedTarget.targetID, linkID });
}

function beginOwnedHubEntosisScoring(options = {}) {
  const targetResult = resolveOwnedHub(options);
  if (!targetResult.success) {
    return targetResult;
  }
  const target = targetResult.data;
  const nowMs = normalizeNowMs(options.nowMs);
  const state = getHubMetadata(target.structure);
  if (!state) {
    return failure("SOVEREIGNTY_VULNERABILITY_NOT_CONFIGURED");
  }
  if (
    state.phase !== "overtime" &&
    (state.phase !== "vulnerable" ||
      nowMs < Number(state.vulnerableStartMs) ||
      nowMs > Number(state.vulnerableEndMs))
  ) {
    return failure("SOVEREIGNTY_TARGET_NOT_VULNERABLE");
  }
  const linkID = normalizePositiveInteger(options.linkID, null);
  const allianceID = normalizePositiveInteger(options.allianceID, null);
  const runtime = getOrCreateRuntime(ownedHubRuntimes, target.targetID);
  const link = runtime.links.get(linkID);
  if (!link || Number(link.allianceID) !== allianceID) {
    return failure("SOVEREIGNTY_ENTOSIS_WARMUP_REQUIRED");
  }
  // Freeze the pre-scoring anchor before exposing this link as live. Without
  // this checkpoint, the next tick applies the new rate retroactively to the
  // entire time since the last persisted state (including warmup/downtime).
  checkpointHubAt(target, state, runtime, nowMs);
  link.phase = "scoring";
  link.scoringAtMs = nowMs;
  if (allianceID !== target.defenderAllianceID && !state.attackerAllianceID) {
    state.attackerAllianceID = allianceID;
  }
  const liveState = deriveHubLiveState(state, runtime, nowMs);
  if (!writeHubMetadata(target, state, liveState)) {
    link.phase = "warmup";
    return failure("SOVEREIGNTY_ENTOSIS_SCORING_CHECKPOINT_FAILED");
  }
  if (allianceID !== target.defenderAllianceID) {
    // TQ's first Entosis cycle is warmup only. Notify the owner only after the
    // hostile scoring anchor is durably visible, never for defender repairs.
    campaignNotifications.notifySovCaptureStarted({
      defenderAllianceID: target.defenderAllianceID,
      structureTypeID: TYPE_INFRASTRUCTURE_HUB,
      solarSystemID: target.solarSystemID,
      eventKey: state.captureEpoch,
      emitLive: options.emitLive !== false,
    });
  }
  return success({ targetID: target.targetID, linkID });
}

function stopOwnedHubEntosisScoring(options = {}) {
  const tickResult = tickOwnedHubCapture(options);
  if (!tickResult.success) {
    return tickResult;
  }
  const targetResult = resolveOwnedHub(options);
  if (!targetResult.success) {
    return targetResult;
  }
  const target = targetResult.data;
  const runtime = getOrCreateRuntime(ownedHubRuntimes, target.targetID);
  runtime.links.delete(normalizePositiveInteger(options.linkID, 0));
  const current = resolveOwnedHub(options);
  const state = current.success ? getHubMetadata(current.data.structure) : null;
  if (state) {
    writeHubMetadata(current.data, state, deriveHubLiveState(state, runtime, normalizeNowMs(options.nowMs)));
  }
  return success({ targetID: target.targetID });
}

// Puts an owned Hub into reinforcement: the score drops to zero, live links
// are dropped, the exit time is checkpointed and the durable campaign tick is
// queued for it. A lost Entosis fight and the GM shortcut both come through
// here.
function enterReinforcement(target, state, nowMs, options = {}) {
  state.scoreAtLastUpdateTime = 0;
  state.phase = "reinforced";
  state.lastUpdatedMs = nowMs;
  state.reinforcementExitMs = Math.max(
    nowMs,
    Math.trunc(Number(options.reinforcementExitMs)),
  );
  ownedHubRuntimes.delete(target.targetID);
  if (!writeHubMetadata(
    target,
    state,
    { scoringTeamID: null, scoringRate: 0, isBlocked: false },
  )) {
    return failure("SOVEREIGNTY_REINFORCEMENT_CHECKPOINT_FAILED");
  }
  queueCampaignTick(state);
  campaignNotifications.notifySovStructureReinforced({
    defenderAllianceID: target.defenderAllianceID,
    decloakTime: unixMsToFiletimeString(state.reinforcementExitMs),
    campaignEventType: CAMPAIGN_EVENT_TYPE,
    solarSystemID: target.solarSystemID,
    eventKey: state.captureEpoch,
    emitLive: options.emitLive !== false,
  });
  return success(cloneValue(state), { completed: true, transitioned: true });
}

function tickOwnedHubCapture(options = {}) {
  const targetResult = resolveOwnedHub(options);
  if (!targetResult.success) {
    return targetResult;
  }
  const target = targetResult.data;
  const state = getHubMetadata(target.structure);
  if (!state) {
    return failure("SOVEREIGNTY_VULNERABILITY_NOT_CONFIGURED");
  }
  if (["reinforced", "campaign", "completed"].includes(String(state.phase))) {
    return success(cloneValue(state));
  }
  const nowMs = normalizeNowMs(options.nowMs);
  const runtime = ownedHubRuntimes.get(target.targetID) || null;
  const liveState = deriveHubLiveState(state, runtime, nowMs);
  checkpointHubAt(target, state, runtime, nowMs);
  lockNextWindowIfDue(target, state, nowMs);

  if (state.scoreAtLastUpdateTime <= 0) {
    return enterReinforcement(target, state, nowMs, {
      reinforcementExitMs: scheduleReinforcementExit(state, nowMs),
      emitLive: options.emitLive,
    });
  }
  if (
    state.scoreAtLastUpdateTime >= 1 &&
    (Number(liveState.scoringRate) > 0 || state.phase === "overtime")
  ) {
    state.scoreAtLastUpdateTime = 1;
    state.phase = "secure";
    state.reinforcementExitMs = null;
    rollToNextDailyWindow(target, state, nowMs, { startAfterNow: true });
    ownedHubRuntimes.delete(target.targetID);
  } else if (
    nowMs >= Number(state.vulnerableEndMs) &&
    state.scoreAtLastUpdateTime < 1
  ) {
    state.phase = "overtime";
  }
  const nextLiveState = deriveHubLiveState(state, ownedHubRuntimes.get(target.targetID), nowMs);
  writeHubMetadata(target, state, nextLiveState);
  if (state.phase === "secure") {
    queueCampaignTick(state, null, nowMs);
  }
  return success(cloneValue(state));
}

// GM shortcut: reinforce an owned Hub now, as if an attacker had run its
// score down. The exit defaults to the engine's schedule; an explicit exit at
// or before now starts the command node event on the next campaign tick.
function forceOwnedHubReinforcement(options = {}) {
  const nowMs = normalizeNowMs(options.nowMs);
  const ensured = ensureOwnedHubVulnerability({ ...options, nowMs });
  if (!ensured.success) {
    return ensured;
  }
  const targetResult = resolveOwnedHub(options);
  if (!targetResult.success) {
    return targetResult;
  }
  const target = targetResult.data;
  const state = getHubMetadata(target.structure);
  if (!state) {
    return failure("SOVEREIGNTY_VULNERABILITY_NOT_CONFIGURED");
  }
  if (state.phase === "reinforced" || state.phase === "campaign") {
    return failure("SOVEREIGNTY_HUB_ALREADY_REINFORCED");
  }
  const requestedExitMs = Number(options.reinforcementExitMs);
  return enterReinforcement(target, state, nowMs, {
    reinforcementExitMs: Number.isFinite(requestedExitMs)
      ? requestedExitMs
      : scheduleReinforcementExit(state, nowMs),
    emitLive: options.emitLive,
  });
}

// GM shortcut: move an owned Hub's engine timers `seconds` into the past, so
// a window opens, a reinforcement exits or regeneration is credited without
// waiting. The durable campaign tick is re-queued for the new exit.
function shiftOwnedHubTimers(options = {}) {
  const targetResult = resolveOwnedHub(options);
  if (!targetResult.success) {
    return targetResult;
  }
  const target = targetResult.data;
  const shiftMs = Math.max(0, normalizeInteger(options.seconds, 0)) * 1000;
  const state = getHubMetadata(target.structure);
  if (!state || shiftMs <= 0) {
    return success({ targetID: target.targetID, shifted: false });
  }
  for (const key of [
    "vulnerableStartMs",
    "vulnerableEndMs",
    "reinforcementExitMs",
    "lastUpdatedMs",
  ]) {
    if (state[key] !== null && Number.isFinite(Number(state[key]))) {
      state[key] = Number(state[key]) - shiftMs;
    }
  }
  if (state.nextWindowLock && Number.isFinite(Number(state.nextWindowLock.centerMs))) {
    state.nextWindowLock.centerMs = Number(state.nextWindowLock.centerMs) - shiftMs;
    state.nextWindowLock.lockedAtMs =
      Number(state.nextWindowLock.lockedAtMs || nowMs) - shiftMs;
  }
  const nowMs = normalizeNowMs(options.nowMs);
  const liveState = deriveHubLiveState(
    state,
    ownedHubRuntimes.get(target.targetID) || null,
    nowMs,
  );
  if (!writeHubMetadata(target, state, liveState)) {
    return failure("SOVEREIGNTY_TIMER_SHIFT_CHECKPOINT_FAILED");
  }
  let campaign = getCampaignMetadata(target.structure);
  if (
    campaign &&
    campaign.status === "active" &&
    Number.isFinite(Number(campaign.nextExtraNodeSpawnMs))
  ) {
    campaign.nextExtraNodeSpawnMs = Number(campaign.nextExtraNodeSpawnMs) - shiftMs;
    const refreshed = findHubByCampaignTarget(target.targetID);
    if (!refreshed || !writeCampaignMetadata(refreshed, campaign)) {
      return failure("SOVEREIGNTY_TIMER_SHIFT_CHECKPOINT_FAILED");
    }
  } else {
    campaign = null;
  }
  queueCampaignTick(state, campaign, nowMs);
  return success(cloneValue(state), { shifted: true });
}

// GM shortcut: forget an owned Hub's engine window so the next use rebuilds
// the daily schedule. Refused while the Hub is reinforced or in a campaign,
// because the command nodes would be orphaned.
function clearOwnedHubVulnerabilityState(options = {}) {
  const targetResult = resolveOwnedHub(options);
  if (!targetResult.success) {
    return targetResult;
  }
  const target = targetResult.data;
  const state = getHubMetadata(target.structure);
  if (state && (state.phase === "reinforced" || state.phase === "campaign")) {
    return failure("SOVEREIGNTY_HUB_IN_CAMPAIGN");
  }
  ownedHubRuntimes.delete(target.targetID);
  const updated = mutateStructure(
    target.solarSystemID,
    target.targetID,
    (structure) => {
      const devFlags = { ...(structure.devFlags || {}) };
      delete devFlags.sovereigntyOwnedHubCapture;
      return {
        ...structure,
        vulnerableStartTime: "0",
        vulnerableEndTime: "0",
        devFlags,
      };
    },
  );
  if (!updated) {
    return failure("SOVEREIGNTY_VULNERABILITY_CLEAR_FAILED");
  }
  return success({ targetID: target.targetID, cleared: Boolean(state) });
}

function getOwnedHubCaptureProjection(options = {}) {
  const targetResult = resolveOwnedHub(options);
  if (!targetResult.success) {
    return null;
  }
  const target = targetResult.data;
  const state = getHubMetadata(target.structure);
  if (!state) {
    return null;
  }
  const nowMs = normalizeNowMs(options.nowMs);
  const liveState = deriveHubLiveState(
    state,
    ownedHubRuntimes.get(target.targetID) || null,
    nowMs,
  );
  return {
    targetID: target.targetID,
    solarSystemID: target.solarSystemID,
    phase: state.phase,
    occupancyMultiplier: Number(state.occupancyMultiplier || 1),
    controllingTeamID: target.defenderAllianceID,
    defenderTeamID: target.defenderAllianceID,
    scoringTeamID: liveState.scoringTeamID,
    scoreAtLastUpdateTime: clampScore(state.scoreAtLastUpdateTime),
    lastUpdatedScoreTime: unixMsToFiletimeString(state.lastUpdatedMs),
    scoringRate: Number(liveState.scoringRate || 0),
    isBlocked: liveState.isBlocked === true,
    reinforcementExitMs: state.reinforcementExitMs || null,
  };
}

function getConstellationSystems(sourceSolarSystemID) {
  const source = worldData.getSolarSystemByID(sourceSolarSystemID);
  const constellationID = normalizePositiveInteger(source && source.constellationID, null);
  const solarSystemIDs = worldData
    .getSolarSystems()
    .filter((system) =>
      Number(system.constellationID) === constellationID &&
      isSovereigntyClaimableSolarSystem(system),
    )
    .map((system) => Number(system.solarSystemID))
    .sort((left, right) => left - right);
  return { constellationID, solarSystemIDs };
}

function findCommandNode(nodeID) {
  const found = findSovereigntyStructureByID(nodeID);
  if (!found || Number(found.structure && found.structure.typeID) !== COMMAND_NODE_TYPE_ID) {
    return null;
  }
  const flags = found.structure.devFlags || {};
  if (flags.sovereigntyCommandNode !== true) {
    return null;
  }
  return {
    nodeID: Number(nodeID),
    solarSystemID: Number(found.solarSystemID),
    system: found.system,
    structure: found.structure,
    campaignEpoch: String(flags.campaignEpoch || ""),
    targetID: normalizePositiveInteger(flags.campaignTargetID, null),
    nodeState:
      flags.commandNodeCapture && typeof flags.commandNodeCapture === "object"
        ? cloneValue(flags.commandNodeCapture)
        : null,
  };
}

function findHubByCampaignTarget(targetID) {
  const result = resolveOwnedHub({ targetID });
  return result.success ? result.data : null;
}

function writeCampaignMetadata(target, campaign, options = {}) {
  return mutateStructure(
    target.solarSystemID,
    target.targetID,
    (structure) => ({
      ...structure,
      campaignEventType:
        campaign.status === "active" ? CAMPAIGN_EVENT_TYPE : 0,
      campaignStartTime:
        campaign.status === "active"
          ? unixMsToFiletimeString(campaign.startedAtMs)
          : "0",
      campaignOccupancyLevel: Number(campaign.occupancyMultiplier || 1),
      campaignScoresByTeam:
        campaign.status === "active" ? cloneValue(campaign.scoresByTeam) : {},
      devFlags: {
        ...(structure.devFlags || {}),
        sovereigntyCampaign: cloneValue(campaign),
      },
    }),
    options,
  );
}

function writeCampaignStartCheckpoint(target, hubState, campaign) {
  return mutateStructure(
    target.solarSystemID,
    target.targetID,
    (structure) => ({
      ...structure,
      defenseMultiplier: Number(hubState.occupancyMultiplier || 1),
      campaignOccupancyLevel: Number(campaign.occupancyMultiplier || 1),
      vulnerabilityOccupancyLevel: Number(
        hubState.occupancyMultiplier || 1,
      ),
      vulnerableStartTime: unixMsToFiletimeString(
        hubState.vulnerableStartMs,
      ),
      vulnerableEndTime: unixMsToFiletimeString(hubState.vulnerableEndMs),
      campaignEventType: CAMPAIGN_EVENT_TYPE,
      campaignStartTime: unixMsToFiletimeString(campaign.startedAtMs),
      campaignScoresByTeam: cloneValue(campaign.scoresByTeam),
      entosisCapture: buildHubEntosisCapture(hubState, {
        scoringTeamID: null,
        scoringRate: 0,
        isBlocked: false,
      }),
      devFlags: {
        ...(structure.devFlags || {}),
        sovereigntyOwnedHubCapture: cloneValue(hubState),
        sovereigntyCampaign: cloneValue(campaign),
      },
    }),
  );
}

function listCampaignNodes(campaign) {
  return (Array.isArray(campaign && campaign.nodeIDs) ? campaign.nodeIDs : [])
    .map((nodeID) => findCommandNode(nodeID))
    .filter((node) =>
      node && String(node.campaignEpoch) === String(campaign.campaignEpoch),
    );
}

function listPhysicalCampaignNodes(targetID, campaignEpoch) {
  const nodes = [];
  for (const system of listAllSovereigntySystemStates()) {
    for (const structure of system.structures || []) {
      const flags = structure && structure.devFlags || {};
      if (
        Number(structure && structure.typeID) === COMMAND_NODE_TYPE_ID &&
        flags.sovereigntyCommandNode === true &&
        Number(flags.campaignTargetID) === Number(targetID) &&
        String(flags.campaignEpoch || "") === String(campaignEpoch || "")
      ) {
        const node = findCommandNode(structure.itemID);
        if (node) {
          nodes.push(node);
        }
      }
    }
  }
  return nodes.sort((left, right) => left.nodeID - right.nodeID);
}

function reconcileActiveCampaign(target, campaign, nowMs) {
  let physical = listPhysicalCampaignNodes(
    campaign.targetID,
    campaign.campaignEpoch,
  );
  for (const node of physical) {
    const candidateAllianceID = normalizePositiveInteger(
      node.nodeState && node.nodeState.completionCandidateAllianceID,
      null,
    );
    if (
      candidateAllianceID &&
      Number(node.nodeState && node.nodeState.scoreAtLastUpdateTime) >=
        1 - 1e-9 &&
      node.structure.entosisCapture &&
      node.structure.entosisCapture.isBlocked !== true
    ) {
      const recovered = captureSovereigntyCommandNode({
        nodeID: node.nodeID,
        allianceID: candidateAllianceID,
        campaignEpoch: campaign.campaignEpoch,
        nowMs,
      });
      if (!recovered || recovered.success === false) {
        return recovered || failure(
          "SOVEREIGNTY_COMMAND_NODE_COMPLETION_RECOVERY_FAILED",
        );
      }
      const refreshedTarget = findHubByCampaignTarget(campaign.targetID);
      if (!refreshedTarget) {
        return success({ completed: true });
      }
      const refreshedCampaign = getCampaignMetadata(
        refreshedTarget.structure,
      );
      if (!refreshedCampaign || refreshedCampaign.status !== "active") {
        return success({ completed: true });
      }
      campaign = refreshedCampaign;
      physical = listPhysicalCampaignNodes(
        campaign.targetID,
        campaign.campaignEpoch,
      );
      break;
    }
  }
  campaign.nodeIDs = [...new Set(physical.map((node) => node.nodeID))];
  const desired = Math.max(
    1,
    normalizeInteger(
      campaign.initialNodeTargetCount,
      INITIAL_COMMAND_NODE_COUNT,
    ),
  );
  while (campaign.nodeIDs.length < desired) {
    if (!createCommandNode(target, campaign, nowMs)) {
      break;
    }
  }
  if (campaign.nodeIDs.length < desired) {
    return failure("SOVEREIGNTY_CAMPAIGN_NODE_REPAIR_INCOMPLETE");
  }
  campaign.startCheckpoint = "complete";
  if (!writeCampaignMetadata(target, campaign)) {
    return failure("SOVEREIGNTY_CAMPAIGN_REPAIR_CHECKPOINT_FAILED");
  }
  campaignNotifications.notifySovCommandNodeEventStarted({
    defenderAllianceID: campaign.defenderAllianceID,
    constellationID: campaign.constellationID,
    solarSystemID: campaign.sourceSolarSystemID,
    campaignEventType: CAMPAIGN_EVENT_TYPE,
    eventKey: campaign.campaignEpoch,
  });
  return success({ repairedNodeCount: campaign.nodeIDs.length });
}

// A node's ID is its Hub's ID times 1000 plus a sequence. A player-launched Hub
// has an inventory itemID (9988400000367), which makes that past 2^53: unsafe
// as a JS number (odd values round), refused by safe-integer checks, and the
// node never became a ball, so nobody could warp to it. Such a Hub uses its ID
// modulo 10^12 instead, which keeps nodes under 10^15; the loop still skips any
// ID already taken.
const COMMAND_NODE_ID_HUB_MODULUS = 1_000_000_000_000;

function getCommandNodeIDBase(targetID) {
  const hubID = Number(targetID);
  return Number.isSafeInteger(hubID * 1000 + 999_999)
    ? hubID * 1000
    : (hubID % COMMAND_NODE_ID_HUB_MODULUS) * 1000;
}

function allocateNodeID(campaign) {
  let sequence = Math.max(1, normalizeInteger(campaign.nextNodeSequence, 1));
  let nodeID;
  const base = getCommandNodeIDBase(campaign.targetID);
  do {
    nodeID = base + sequence;
    sequence += 1;
  } while (
    findSovereigntyStructureByID(nodeID) ||
    (campaign.nodeCaptureReceipts &&
      campaign.nodeCaptureReceipts[String(nodeID)])
  );
  campaign.nextNodeSequence = sequence;
  return nodeID;
}

function countConstellationNodes(constellationID, excludedNodeID = null) {
  let count = 0;
  for (const system of listAllSovereigntySystemStates()) {
    const staticSystem = worldData.getSolarSystemByID(system.solarSystemID);
    if (Number(staticSystem && staticSystem.constellationID) !== Number(constellationID)) {
      continue;
    }
    count += (system.structures || []).filter(
      (entry) =>
        Number(entry && entry.typeID) === COMMAND_NODE_TYPE_ID &&
        Number(entry && entry.itemID) !== Number(excludedNodeID) &&
        entry.devFlags && entry.devFlags.sovereigntyCommandNode === true,
    ).length;
  }
  return count;
}

function countSystemNodes(solarSystemID, excludedNodeID = null) {
  const system = getSystemState(solarSystemID);
  return (system && system.structures || []).filter(
    (entry) =>
      Number(entry && entry.typeID) === COMMAND_NODE_TYPE_ID &&
      Number(entry && entry.itemID) !== Number(excludedNodeID) &&
      entry.devFlags && entry.devFlags.sovereigntyCommandNode === true,
  ).length;
}

// Retail: every node lands in a random system of the constellation with
// equal chance, whoever holds it, within 5 per system and 20 per
// constellation. There is no cap on the nodes one event may spawn.
function chooseNodeSolarSystem(campaign, replacingNodeID = null) {
  if (
    countConstellationNodes(campaign.constellationID, replacingNodeID) >=
      MAX_COMMAND_NODES_PER_CONSTELLATION
  ) {
    return null;
  }
  const systems = Array.isArray(campaign.constellationSolarSystemIDs)
    ? campaign.constellationSolarSystemIDs
    : [];
  const open = systems
    .map((entry) => Number(entry))
    .filter(
      (solarSystemID) =>
        solarSystemID > 0 &&
        countSystemNodes(solarSystemID, replacingNodeID) <
          MAX_COMMAND_NODES_PER_SYSTEM,
    );
  if (open.length === 0) {
    return null;
  }
  return open[Math.min(open.length - 1, Math.floor(drawCampaignRandom() * open.length))];
}

function scheduleNextExtraNodeSpawn(nowMs) {
  const spread =
    1 - EXTRA_COMMAND_NODE_SPAWN_JITTER +
    2 * EXTRA_COMMAND_NODE_SPAWN_JITTER * drawCampaignRandom();
  return Math.trunc(nowMs + EXTRA_COMMAND_NODE_SPAWN_INTERVAL_MS * spread);
}

function buildCommandNodeCandidate(
  target,
  campaign,
  nowMs,
  replacingNodeID = null,
) {
  const solarSystemID = chooseNodeSolarSystem(campaign, replacingNodeID);
  if (!solarSystemID) {
    return null;
  }
  const nodeID = allocateNodeID(campaign);
  const sourceInfo = [
    target.solarSystemID,
    CAMPAIGN_EVENT_TYPE,
    target.targetID,
    target.defenderAllianceID,
  ];
  const nodeState = {
    controllingTeamID: target.defenderAllianceID,
    scoreAtLastUpdateTime: 0.5,
    lastUpdatedMs: nowMs,
  };
  const ordinal = normalizeInteger(campaign.nextNodeSequence, 1);
  const structure = {
    itemID: nodeID,
    typeID: COMMAND_NODE_TYPE_ID,
    groupID: 1316,
    categoryID: 65,
    name: `Sovereignty Command Node ${nodeID}`,
    ownerID: target.defenderCorporationID,
    corporationID: target.defenderCorporationID,
    allianceID: target.defenderAllianceID,
    position: {
      x: 250000000 + ordinal * 1000000,
      y: -125000000 - ordinal * 500000,
      z: ordinal * 250000,
    },
    campaignSourceInfo: sourceInfo,
    entosisCapture: {
      schemaVersion: 1,
      captureEpoch: campaign.campaignEpoch,
      controllingTeamID: target.defenderAllianceID,
      scoringTeamID: null,
      scoreAtLastUpdateTime: 0.5,
      lastUpdatedScoreTime: unixMsToFiletimeString(nowMs),
      scoringRate: 0,
      isBlocked: false,
      defenderTeamID: target.defenderAllianceID,
    },
    devFlags: {
      sovereigntyCommandNode: true,
      sovereigntyCampaignAuxiliary: true,
      campaignEpoch: campaign.campaignEpoch,
      campaignTargetID: target.targetID,
      campaignSourceInfo: sourceInfo,
      commandNodeCapture: nodeState,
    },
  };
  return { nodeID, solarSystemID, structure };
}

function persistCommandNodeCandidate(campaign, candidate) {
  if (!candidate) {
    return null;
  }
  const { nodeID, solarSystemID, structure } = candidate;
  const current = cloneValue(getSystemState(solarSystemID)) || { solarSystemID, structures: [] };
  const structures = [...(current.structures || []), structure];
  const persisted = upsertSystemState(
    solarSystemID,
    { structures },
    { suppressNotifications: true },
  );
  if (!persisted) {
    return null;
  }
  campaign.nodeIDs.push(nodeID);
  return findCommandNode(nodeID);
}

function createCommandNode(target, campaign, nowMs) {
  return persistCommandNodeCandidate(
    campaign,
    buildCommandNodeCandidate(target, campaign, nowMs),
  );
}

function spawnCommandNodes(target, campaign, count, nowMs) {
  const created = [];
  for (let index = 0; index < Math.max(0, normalizeInteger(count, 0)); index += 1) {
    const node = createCommandNode(target, campaign, nowMs);
    if (!node) {
      break;
    }
    created.push(node);
  }
  writeCampaignMetadata(target, campaign);
  return created;
}

function startCampaign(target, hubState, nowMs) {
  const location = getConstellationSystems(target.solarSystemID);
  if (!location.constellationID || location.solarSystemIDs.length === 0) {
    return failure("SOVEREIGNTY_CAMPAIGN_CONSTELLATION_NOT_FOUND");
  }
  const campaign = {
    schemaVersion: 1,
    campaignEpoch: `sov-campaign:${target.solarSystemID}:${target.targetID}:${hubState.reinforcementExitMs}`,
    targetID: target.targetID,
    sourceSolarSystemID: target.solarSystemID,
    constellationID: location.constellationID,
    constellationSolarSystemIDs: location.solarSystemIDs,
    eventType: CAMPAIGN_EVENT_TYPE,
    defenderAllianceID: target.defenderAllianceID,
    defenderCorporationID: target.defenderCorporationID,
    attackerTeamID: -target.defenderAllianceID,
    occupancyMultiplier: Number(hubState.occupancyMultiplier || 1),
    status: "active",
    phase: "campaign",
    result: null,
    startedAtMs: Number(hubState.reinforcementExitMs || nowMs),
    scoresByTeam: {
      [String(target.defenderAllianceID)]: INITIAL_CAMPAIGN_DEFENDER_SCORE,
      [String(-target.defenderAllianceID)]: 1 - INITIAL_CAMPAIGN_DEFENDER_SCORE,
    },
    nodeIDs: [],
    nextNodeSequence: 1,
    initialNodeTargetCount: INITIAL_COMMAND_NODE_COUNT,
    nextExtraNodeSpawnMs: scheduleNextExtraNodeSpawn(
      Number(hubState.reinforcementExitMs || nowMs),
    ),
    startCheckpoint: "metadata",
  };
  hubState.phase = "campaign";
  hubState.lastUpdatedMs = nowMs;
  if (!writeCampaignStartCheckpoint(target, hubState, campaign)) {
    return failure("SOVEREIGNTY_CAMPAIGN_START_INTENT_FAILED");
  }
  const nodes = spawnCommandNodes(
    target,
    campaign,
    INITIAL_COMMAND_NODE_COUNT,
    nowMs,
  );
  if (nodes.length !== INITIAL_COMMAND_NODE_COUNT) {
    // The durable active metadata is a recoverable intent. Startup reconcile
    // adopts any already-written nodes and fills the missing remainder.
    return failure("SOVEREIGNTY_CAMPAIGN_NODE_SPAWN_INCOMPLETE");
  }
  campaign.startCheckpoint = "complete";
  if (!writeCampaignMetadata(target, campaign)) {
    return failure("SOVEREIGNTY_CAMPAIGN_START_CHECKPOINT_FAILED");
  }
  queueCampaignTick(hubState, campaign);
  campaignNotifications.notifySovCommandNodeEventStarted({
    defenderAllianceID: campaign.defenderAllianceID,
    constellationID: campaign.constellationID,
    solarSystemID: campaign.sourceSolarSystemID,
    campaignEventType: CAMPAIGN_EVENT_TYPE,
    eventKey: campaign.campaignEpoch,
  });
  return success(campaign, { transitioned: true });
}

// One extra node when the campaign's spawn time has passed, then the next
// spawn time is drawn and the durable tick re-armed for it. A tick before the
// time only re-arms. Missed intervals (downtime) spawn one node, not many.
function tickExtraCommandNodeSpawn(targetID, nowMs) {
  const target = findHubByCampaignTarget(targetID);
  const campaign = target && getCampaignMetadata(target.structure);
  const state = target && getHubMetadata(target.structure);
  if (!target || !state || !campaign || campaign.status !== "active") {
    return success({ stale: true });
  }
  const spawnedNodeIDs = [];
  const dueMs = Number(campaign.nextExtraNodeSpawnMs);
  if (!Number.isFinite(dueMs)) {
    campaign.nextExtraNodeSpawnMs = scheduleNextExtraNodeSpawn(nowMs);
  } else if (nowMs >= dueMs) {
    const created = createCommandNode(target, campaign, nowMs);
    if (created) {
      spawnedNodeIDs.push(created.nodeID);
    }
    campaign.nextExtraNodeSpawnMs = scheduleNextExtraNodeSpawn(nowMs);
  }
  if (!writeCampaignMetadata(target, campaign)) {
    return failure("SOVEREIGNTY_CAMPAIGN_SPAWN_CHECKPOINT_FAILED");
  }
  queueCampaignTick(state, campaign);
  return success({
    spawnedNodeIDs,
    nextExtraNodeSpawnMs: campaign.nextExtraNodeSpawnMs,
  });
}

function tickSovereigntyCampaigns(options = {}) {
  const nowMs = normalizeNowMs(options.nowMs);
  const requestedTargetID = normalizePositiveInteger(options.targetID, null);
  const candidates = requestedTargetID
    ? [resolveOwnedHub({ targetID: requestedTargetID })].filter((entry) => entry.success)
    : listAllSovereigntySystemStates()
        .flatMap((system) => system.structures || [])
        .filter((structure) => Number(structure.typeID) === TYPE_INFRASTRUCTURE_HUB)
        .map((structure) => resolveOwnedHub({ targetID: structure.itemID }))
        .filter((entry) => entry.success);
  const results = [];
  for (const candidate of candidates) {
    const target = candidate.data;
    const hubState = getHubMetadata(target.structure);
    if (!hubState || hubState.phase !== "reinforced") {
      continue;
    }
    if (Number(hubState.reinforcementExitMs || Infinity) > nowMs) {
      continue;
    }
    results.push(startCampaign(target, hubState, nowMs));
  }
  const failed = results.find((entry) => entry.success === false);
  if (failed) {
    return failed;
  }
  return success({ tickedCampaigns: results.length, results });
}

function bindDurableScheduler(scheduler) {
  if (!scheduler || typeof scheduler.schedule !== "function") {
    throw new TypeError("sovereignty campaign scheduler requires schedule");
  }
  durableScheduler = scheduler;
  return true;
}

function unbindDurableScheduler(scheduler = null) {
  if (scheduler && scheduler !== durableScheduler) {
    return false;
  }
  durableScheduler = null;
  return true;
}

function handleDurableSovereigntyCampaignTick(job = {}, options = {}) {
  if (job.type !== DURABLE_CAMPAIGN_TICK_JOB_TYPE) {
    return failure("INVALID_SOVEREIGNTY_CAMPAIGN_JOB");
  }
  const payload = job.payload && typeof job.payload === "object"
    ? job.payload
    : {};
  const targetID = normalizePositiveInteger(payload.targetID, null);
  const target = targetID && findHubByCampaignTarget(targetID);
  if (!target) {
    return success({ stale: true });
  }
  const state = getHubMetadata(target.structure);
  const nowMs = normalizeNowMs(options.nowMs);
  const expected = buildCampaignTickJob(state, null, nowMs);
  if (
    !expected ||
    String(job.jobID || "") !== expected.jobID ||
    String(payload.captureEpoch || "") !== String(state.captureEpoch || "")
  ) {
    return success({ stale: true });
  }
  if (state.phase === "secure" || state.phase === "vulnerable") {
    // An idle Hub: open, lock or roll its window, then re-arm for the next
    // event. ensureOwnedHubVulnerability re-arms itself when it writes; the
    // explicit queue below covers an evaluation that changed nothing.
    const ensured = ensureOwnedHubVulnerability({
      targetID,
      solarSystemID: target.solarSystemID,
      nowMs,
    });
    if (!ensured || ensured.success === false) {
      return ensured;
    }
    const refreshed = findHubByCampaignTarget(targetID);
    const refreshedState = refreshed && getHubMetadata(refreshed.structure);
    if (
      refreshedState &&
      (refreshedState.phase === "secure" || refreshedState.phase === "vulnerable")
    ) {
      queueCampaignTick(refreshedState, null, nowMs);
    }
    return success({
      windowTicked: true,
      phase: refreshedState ? refreshedState.phase : null,
    });
  }
  if (nowMs < Number(state.reinforcementExitMs)) {
    return failure("SOVEREIGNTY_CAMPAIGN_NOT_DUE");
  }
  if (state.phase === "campaign") {
    const campaign = getCampaignMetadata(target.structure);
    if (!campaign || campaign.status !== "active") {
      return success({ stale: true });
    }
    const repaired = reconcileActiveCampaign(target, campaign, nowMs);
    if (!repaired || repaired.success === false || repaired.data.completed) {
      return repaired;
    }
    const spawned = tickExtraCommandNodeSpawn(targetID, nowMs);
    if (!spawned || spawned.success === false) {
      return spawned;
    }
    return success({ ...repaired.data, ...spawned.data });
  }
  return tickSovereigntyCampaigns({ targetID, nowMs });
}

async function reconcileSovereigntyCampaigns(options = {}) {
  const nowMs = normalizeNowMs(options.nowMs);
  const results = [];
  let scheduled = 0;
  let transitioned = 0;
  const canonicalSystems = listAllSovereigntySystemStates();
  for (const system of canonicalSystems) {
    const mirrorRepair = syncSovereigntyStructureRuntime(system, {
      broadcast: false,
      syncScene: false,
    });
    if (!mirrorRepair || mirrorRepair.success === false) {
      return mirrorRepair || failure(
        "SOVEREIGNTY_CAMPAIGN_STRUCTURE_MIRROR_REPAIR_FAILED",
      );
    }
    for (const structure of system.structures || []) {
      if (Number(structure.typeID) !== TYPE_INFRASTRUCTURE_HUB) {
        continue;
      }
      const targetResult = resolveOwnedHub({
        targetID: structure.itemID,
        solarSystemID: system.solarSystemID,
      });
      if (!targetResult.success) {
        continue;
      }
      const target = targetResult.data;
      const state = getHubMetadata(target.structure);
      const campaign = getCampaignMetadata(target.structure);
      if (
        campaign &&
        (campaign.status === "terminal-pending" ||
          (campaign.status === "completed" && campaign.result))
      ) {
        results.push(recoverTerminalCampaign(target, campaign, nowMs));
        continue;
      }
      if (!state) {
        const ensured = ensureOwnedHubVulnerability({
          targetID: target.targetID,
          solarSystemID: target.solarSystemID,
          nowMs,
        });
        results.push(ensured);
        continue;
      }
      if (state.phase === "reinforced") {
        if (Number(state.reinforcementExitMs) <= nowMs) {
          const ticked = tickSovereigntyCampaigns({
            targetID: target.targetID,
            nowMs,
          });
          if (ticked.success) {
            results.push(ticked);
            transitioned += 1;
          } else {
            // startCampaign writes the active intent before creating its
            // physical node set. Capacity or persistence can therefore fail
            // after the Hub has left `reinforced`. Re-read that checkpoint
            // and retain the same durable job as an active repair job.
            const refreshed = findHubByCampaignTarget(target.targetID);
            const refreshedState = refreshed && getHubMetadata(
              refreshed.structure,
            );
            const repairJob = refreshedState &&
              refreshedState.phase === "campaign"
              ? await scheduleCampaignTick(refreshedState)
              : null;
            if (repairJob) {
              scheduled += 1;
              results.push(success({
                repairScheduled: true,
                jobID: repairJob.jobID,
              }));
            } else {
              results.push(ticked);
            }
          }
        } else {
          const job = await scheduleCampaignTick(state);
          if (job) {
            scheduled += 1;
          }
        }
        continue;
      }
      if (state.phase === "secure" || state.phase === "vulnerable") {
        const ensured = ensureOwnedHubVulnerability({
          targetID: target.targetID,
          solarSystemID: target.solarSystemID,
          nowMs,
        });
        results.push(ensured);
        if (ensured && ensured.success !== false) {
          const refreshed = findHubByCampaignTarget(target.targetID);
          const refreshedState = refreshed && getHubMetadata(refreshed.structure);
          if (
            refreshedState &&
            (refreshedState.phase === "secure" || refreshedState.phase === "vulnerable")
          ) {
            const job = await scheduleCampaignTick(refreshedState, null, nowMs);
            if (job) {
              scheduled += 1;
            }
          }
        }
        continue;
      }
      if (campaign && campaign.status === "active") {
        const repaired = reconcileActiveCampaign(target, campaign, nowMs);
        if (repaired && repaired.success === false) {
          const job = await scheduleCampaignTick(state);
          if (job) {
            scheduled += 1;
            results.push(success({ repairScheduled: true, jobID: job.jobID }));
          } else {
            results.push(repaired);
          }
        } else {
          results.push(repaired);
          if (!(repaired && repaired.data && repaired.data.completed)) {
            const refreshed = findHubByCampaignTarget(target.targetID);
            const refreshedCampaign = refreshed && getCampaignMetadata(
              refreshed.structure,
            );
            if (refreshedCampaign && refreshedCampaign.status === "active") {
              const job = await scheduleCampaignTick(state, refreshedCampaign);
              if (job) {
                scheduled += 1;
              }
            }
          }
        }
      }
    }
  }
  const failed = results.find((entry) => entry && entry.success === false);
  if (failed) {
    return failed;
  }
  const notifications = replayDestroyedCampaignNotifications({
    nowMs,
    emitLive: options.emitLive,
  });
  if (!notifications.success) {
    return notifications;
  }
  return success({
    scheduled,
    transitioned,
    repaired: results.length,
    replayedNotifications: notifications.data.delivered,
  });
}

function buildNodeProjection(node, campaign) {
  const capture = node.structure.entosisCapture || {};
  return {
    nodeID: node.nodeID,
    typeID: COMMAND_NODE_TYPE_ID,
    solarSystemID: node.solarSystemID,
    campaignEpoch: campaign.campaignEpoch,
    campaignSourceInfo:
      cloneValue(node.structure.campaignSourceInfo) ||
      cloneValue(node.structure.devFlags && node.structure.devFlags.campaignSourceInfo),
    position: cloneValue(node.structure.position),
    entosisCapture: {
      controllingTeamID: capture.controllingTeamID ?? campaign.defenderAllianceID,
      scoringTeamID: capture.scoringTeamID ?? null,
      scoreAtLastUpdateTime: clampScore(capture.scoreAtLastUpdateTime ?? 0.5),
      lastUpdatedScoreTime: String(capture.lastUpdatedScoreTime || "0"),
      scoringRate: Number(capture.scoringRate || 0),
      isBlocked: capture.isBlocked === true,
      defenderTeamID: campaign.defenderAllianceID,
    },
  };
}

function getSovereigntyCampaignProjection(options = {}) {
  const targetID = normalizePositiveInteger(options.targetID, null);
  if (!targetID) {
    return null;
  }
  const completed = completedCampaigns.get(targetID);
  const target = findHubByCampaignTarget(targetID);
  if (!target) {
    return completed ? cloneValue(completed) : null;
  }
  const campaign = getCampaignMetadata(target.structure);
  if (!campaign) {
    return completed ? cloneValue(completed) : null;
  }
  return {
    ...cloneValue(campaign),
    commandNodes: listCampaignNodes(campaign).map((node) =>
      buildNodeProjection(node, campaign),
    ),
  };
}

function resolveCommandNodeForAction(options = {}) {
  const nodeID = normalizePositiveInteger(options.nodeID, null);
  const node = nodeID ? findCommandNode(nodeID) : null;
  if (!node) {
    return failure("SOVEREIGNTY_COMMAND_NODE_STALE_OR_CAPTURED");
  }
  const campaignEpoch = String(options.campaignEpoch || "");
  if (!campaignEpoch || campaignEpoch !== node.campaignEpoch) {
    return failure("SOVEREIGNTY_CAMPAIGN_EPOCH_FENCE");
  }
  const target = findHubByCampaignTarget(node.targetID);
  const campaign = target && getCampaignMetadata(target.structure);
  if (
    !target ||
    !campaign ||
    campaign.status !== "active" ||
    campaign.campaignEpoch !== campaignEpoch ||
    !campaign.nodeIDs.map(Number).includes(nodeID)
  ) {
    return failure("SOVEREIGNTY_COMMAND_NODE_STALE_FENCE");
  }
  return success({ node, target, campaign });
}

function buildNodeLiveState(node, campaign, runtime) {
  const teams = getLiveTeams(runtime, campaign.defenderAllianceID);
  if (teams.length > 1) {
    return { scoringTeamID: null, scoringRate: 0, isBlocked: true };
  }
  if (teams.length === 0) {
    // Command nodes defensively regenerate while idle at the component's
    // defensiveRegenRate (0.04 in client static data 3396210).
    const controllingTeamID = Number(
      node && node.nodeState && node.nodeState.controllingTeamID ||
        campaign.defenderAllianceID,
    );
    const nodeState = node && node.nodeState || {};
    const pristine =
      nodeState.hasScored !== true &&
      controllingTeamID === Number(campaign.defenderAllianceID) &&
      Math.abs(
        Number(nodeState.scoreAtLastUpdateTime == null
          ? 0.5
          : nodeState.scoreAtLastUpdateTime) - 0.5,
      ) < 1e-9;
    if (pristine) {
      return { scoringTeamID: null, scoringRate: 0, isBlocked: false };
    }
    return {
      scoringTeamID: Number(campaign.defenderAllianceID),
      scoringRate:
        controllingTeamID === Number(campaign.defenderAllianceID)
          ? COMMAND_NODE_DEFENDER_REGEN_RATE
          : -COMMAND_NODE_DEFENDER_REGEN_RATE,
      isBlocked: false,
    };
  }
  const teamID = teams[0];
  const nodeState = node.nodeState || {};
  const controllingTeamID = Number(
    nodeState.controllingTeamID || campaign.defenderAllianceID,
  );
  const occupancyMultiplier = Math.max(
    1,
    Number(campaign.occupancyMultiplier || 1),
  );
  const isDefenderTeam = teamID === Number(campaign.defenderAllianceID);
  const isControllingTeam = teamID === controllingTeamID;
  return {
    scoringTeamID: teamID,
    scoringRate: isControllingTeam
      ? 1
      : isDefenderTeam
        ? -1
        : -1 / occupancyMultiplier,
    isBlocked: false,
  };
}

function checkpointCommandNodeAt(node, campaign, runtime, nowMs) {
  const nodeState = node.nodeState || {
    controllingTeamID: campaign.defenderAllianceID,
    scoreAtLastUpdateTime: 0.5,
    lastUpdatedMs: nowMs,
  };
  const liveState = buildNodeLiveState(
    { ...node, nodeState },
    campaign,
    runtime,
  );
  const elapsedSeconds = Math.max(
    0,
    nowMs - Number(nodeState.lastUpdatedMs || nowMs),
  ) / 1000;
  nodeState.scoreAtLastUpdateTime = clampScore(
    Number(nodeState.scoreAtLastUpdateTime) +
      elapsedSeconds * Number(liveState.scoringRate) /
        COMMAND_NODE_CAPTURE_TIME_SECONDS,
  );
  nodeState.lastUpdatedMs = nowMs;
  return { nodeState, liveState };
}

function findActiveNodeScoringAlliance(runtime, campaign, scoringTeamID) {
  if (!runtime || !runtime.links) {
    return null;
  }
  const link = [...runtime.links.values()].find((entry) => {
    if (!entry || entry.phase !== "scoring") {
      return false;
    }
    return Number(scoringTeamID) === Number(campaign.defenderAllianceID)
      ? Number(entry.allianceID) === Number(campaign.defenderAllianceID)
      : Number(entry.allianceID) !== Number(campaign.defenderAllianceID);
  });
  return normalizePositiveInteger(link && link.allianceID, null);
}

function writeCommandNodeState(node, campaign, nodeState, liveState) {
  return mutateStructure(
    node.solarSystemID,
    node.nodeID,
    (structure) => ({
      ...structure,
      entosisCapture: {
        schemaVersion: 1,
        captureEpoch: campaign.campaignEpoch,
        controllingTeamID: Number(
          nodeState.controllingTeamID || campaign.defenderAllianceID,
        ),
        scoringTeamID: liveState.scoringTeamID,
        scoreAtLastUpdateTime: clampScore(nodeState.scoreAtLastUpdateTime),
        lastUpdatedScoreTime: unixMsToFiletimeString(nodeState.lastUpdatedMs),
        scoringRate: Number(liveState.scoringRate || 0),
        isBlocked: liveState.isBlocked === true,
        defenderTeamID: campaign.defenderAllianceID,
      },
      devFlags: {
        ...(structure.devFlags || {}),
        commandNodeCapture: cloneValue(nodeState),
      },
    }),
  );
}

function registerCommandNodeEntosisWarmup(options = {}) {
  const resolved = resolveCommandNodeForAction(options);
  if (!resolved.success) {
    return resolved;
  }
  const linkID = normalizePositiveInteger(options.linkID, null);
  const allianceID = normalizePositiveInteger(options.allianceID, null);
  if (!linkID || !allianceID) {
    return failure("SOVEREIGNTY_COMMAND_NODE_WARMUP_INVALID");
  }
  const runtime = getOrCreateRuntime(commandNodeRuntimes, resolved.data.node.nodeID);
  runtime.links.set(linkID, {
    linkID,
    allianceID,
    phase: "warmup",
    warmedAtMs: normalizeNowMs(options.nowMs),
  });
  return success({ nodeID: resolved.data.node.nodeID, linkID });
}

function beginCommandNodeEntosisScoring(options = {}) {
  const resolved = resolveCommandNodeForAction(options);
  if (!resolved.success) {
    return resolved;
  }
  const { node, campaign } = resolved.data;
  const linkID = normalizePositiveInteger(options.linkID, null);
  const allianceID = normalizePositiveInteger(options.allianceID, null);
  const runtime = getOrCreateRuntime(commandNodeRuntimes, node.nodeID);
  const link = runtime.links.get(linkID);
  if (!link || Number(link.allianceID) !== allianceID) {
    return failure("SOVEREIGNTY_COMMAND_NODE_WARMUP_REQUIRED");
  }
  // Anchor the warmup interval before making the link score. Otherwise the
  // next tick retroactively applies its rate to the entire time since spawn or
  // downtime.
  const checkpoint = checkpointCommandNodeAt(
    node,
    campaign,
    runtime,
    normalizeNowMs(options.nowMs),
  );
  link.phase = "scoring";
  const nodeState = checkpoint.nodeState || {
    controllingTeamID: campaign.defenderAllianceID,
    scoreAtLastUpdateTime: 0.5,
    lastUpdatedMs: normalizeNowMs(options.nowMs),
  };
  nodeState.hasScored = true;
  writeCommandNodeState(
    node,
    campaign,
    nodeState,
    buildNodeLiveState({ ...node, nodeState }, campaign, runtime),
  );
  return success({ nodeID: node.nodeID, linkID });
}

function stopCommandNodeEntosisScoring(options = {}) {
  const tickResult = tickCommandNodeCapture(options);
  if (!tickResult.success) {
    return tickResult;
  }
  const resolved = resolveCommandNodeForAction(options);
  if (!resolved.success) {
    return resolved;
  }
  const { node, campaign } = resolved.data;
  const runtime = getOrCreateRuntime(commandNodeRuntimes, node.nodeID);
  runtime.links.delete(normalizePositiveInteger(options.linkID, 0));
  const freshNode = findCommandNode(node.nodeID);
  if (freshNode) {
    writeCommandNodeState(
      freshNode,
      campaign,
      freshNode.nodeState,
      buildNodeLiveState(freshNode, campaign, runtime),
    );
  }
  return success({ nodeID: node.nodeID });
}

function removeCampaignNode(campaign, nodeID) {
  const node = findCommandNode(nodeID);
  if (node) {
    const system = cloneValue(getSystemState(node.solarSystemID));
    const structures = (system.structures || []).filter(
      (entry) => Number(entry && entry.itemID) !== Number(nodeID),
    );
    upsertSystemState(
      node.solarSystemID,
      { structures },
      { suppressNotifications: true },
    );
  }
  campaign.nodeIDs = campaign.nodeIDs.filter((entry) => Number(entry) !== Number(nodeID));
  commandNodeRuntimes.delete(Number(nodeID));
}

function cleanupCampaignNodes(campaign) {
  for (const nodeID of [...campaign.nodeIDs]) {
    removeCampaignNode(campaign, nodeID);
  }
}

function finishCampaign(target, campaign, result, nowMs) {
  campaign.status = "completed";
  campaign.phase = "completed";
  campaign.result = result;
  campaign.completedAtMs = nowMs;
  campaign.scoresByTeam = result === "defender"
    ? {
        [String(campaign.defenderAllianceID)]: 1,
        [String(campaign.attackerTeamID)]: 0,
      }
    : {
        [String(campaign.defenderAllianceID)]: 0,
        [String(campaign.attackerTeamID)]: 1,
      };
  const nodeIDs = [...campaign.nodeIDs];
  if (result === "defender") {
    const freshTarget = findHubByCampaignTarget(target.targetID);
    const hubState = getHubMetadata(freshTarget.structure);
    hubState.phase = "secure";
    hubState.scoreAtLastUpdateTime = 1;
    hubState.lastUpdatedMs = nowMs;
    hubState.reinforcementExitMs = null;
    rollToNextDailyWindow(freshTarget, hubState, nowMs, {
      startAfterNow: true,
      anchorMs: Number(campaign.startedAtMs || nowMs),
    });
    // Persist the final Hub/campaign state first; the canonical outcome commit
    // then atomically removes every constellation node and records the replay
    // tombstone in the same sovereignty-table write.
    if (!writeHubMetadata(
      freshTarget,
      hubState,
      { scoringTeamID: null, scoringRate: 0, isBlocked: false },
    )) {
      return failure("SOVEREIGNTY_CAMPAIGN_HUB_CHECKPOINT_FAILED");
    }
    if (!writeCampaignMetadata(freshTarget, campaign)) {
      return failure("SOVEREIGNTY_CAMPAIGN_CHECKPOINT_FAILED");
    }
    queueCampaignTick(hubState, null, nowMs);
  }

  const committed = commitSovereigntyHubCampaignOutcome({
    solarSystemID: target.solarSystemID,
    targetID: target.targetID,
    campaignEpoch: campaign.campaignEpoch,
    defenderAllianceID: campaign.defenderAllianceID,
    result,
    completedAtTime: unixMsToFiletimeString(nowMs),
    nodeIDs,
    effectOptions: { suppressNotifications: true },
  });
  if (!committed || committed.success === false) {
    return committed || failure("SOVEREIGNTY_CAMPAIGN_OUTCOME_COMMIT_FAILED");
  }
  for (const nodeID of nodeIDs) {
    commandNodeRuntimes.delete(Number(nodeID));
  }
  campaign.nodeIDs = [];
  completedCampaigns.set(target.targetID, {
    ...cloneValue(campaign),
    commandNodes: [],
  });
  if (result === "attacker") {
    const notification = campaignNotifications.notifySovStructureDestroyed({
      defenderAllianceID: campaign.defenderAllianceID,
      structureTypeID: TYPE_INFRASTRUCTURE_HUB,
      solarSystemID: target.solarSystemID,
      eventKey: campaign.campaignEpoch,
      created: unixMsToFiletimeString(nowMs),
    });
    if (!notification || notification.success !== true) {
      return failure("SOVEREIGNTY_CAMPAIGN_DESTROYED_NOTIFICATION_FAILED");
    }
    const marked = markSovereigntyCampaignDestroyedNotificationDelivered({
      solarSystemID: target.solarSystemID,
      targetID: target.targetID,
      campaignEpoch: campaign.campaignEpoch,
      deliveredAtTime: unixMsToFiletimeString(nowMs),
    });
    if (!marked || marked.success === false) {
      return marked || failure(
        "SOVEREIGNTY_CAMPAIGN_DESTROYED_NOTIFICATION_MARK_FAILED",
      );
    }
    // Lost sovereignty (41 alliance, 42 corporation). Keyed by the campaign
    // epoch, so a replayed outcome reuses the same notifications.
    campaignNotifications.notifySovClaimLost({
      allianceID: campaign.defenderAllianceID,
      corporationID: target.defenderCorporationID,
      solarSystemID: target.solarSystemID,
      eventKey: campaign.campaignEpoch,
      created: unixMsToFiletimeString(nowMs),
    });
  }
  return campaign;
}

function recoverTerminalCampaign(target, campaign, nowMs) {
  const terminal = campaign.terminalPending || {};
  const completedAtMs = filetimeToUnixMs(
    terminal.completedAtTime,
    Number(campaign.completedAtMs || nowMs),
  );
  const result = String(campaign.result || terminal.result || "").toLowerCase();
  if (result !== "attacker" && result !== "defender") {
    return failure("SOVEREIGNTY_CAMPAIGN_TERMINAL_RECEIPT_INVALID");
  }
  return finishCampaign(target, campaign, result, completedAtMs);
}

function replayDestroyedCampaignNotifications(options = {}) {
  const emitLive = options.emitLive !== false;
  let delivered = 0;
  for (const system of listAllSovereigntySystemStates()) {
    for (const receipt of Object.values(system.campaignOutcomeReceipts || {})) {
      if (
        !receipt ||
        receipt.result !== "attacker" ||
        String(receipt.destroyedNotificationDeliveredAtTime || "0") !== "0"
      ) {
        continue;
      }
      const notification = campaignNotifications.notifySovStructureDestroyed({
        defenderAllianceID: receipt.defenderAllianceID,
        structureTypeID: TYPE_INFRASTRUCTURE_HUB,
        solarSystemID: receipt.solarSystemID,
        eventKey: receipt.campaignEpoch,
        created: receipt.completedAtTime,
        emitLive,
      });
      if (!notification || notification.success !== true) {
        return failure("SOVEREIGNTY_CAMPAIGN_DESTROYED_NOTIFICATION_FAILED");
      }
      const marked = markSovereigntyCampaignDestroyedNotificationDelivered({
        solarSystemID: receipt.solarSystemID,
        targetID: receipt.targetID,
        campaignEpoch: receipt.campaignEpoch,
        deliveredAtTime: unixMsToFiletimeString(
          normalizeNowMs(options.nowMs),
        ),
      });
      if (!marked || marked.success === false) {
        return marked || failure(
          "SOVEREIGNTY_CAMPAIGN_DESTROYED_NOTIFICATION_MARK_FAILED",
        );
      }
      delivered += 1;
    }
  }
  return success({ delivered });
}

function captureSovereigntyCommandNode(options = {}) {
  const resolved = resolveCommandNodeForAction(options);
  if (!resolved.success) {
    return resolved;
  }
  const { node, target, campaign } = resolved.data;
  const allianceID = normalizePositiveInteger(options.allianceID, null);
  if (!allianceID) {
    return failure("SOVEREIGNTY_COMMAND_NODE_ALLIANCE_REQUIRED");
  }
  const nowMs = normalizeNowMs(options.nowMs);
  const defenderWon = allianceID === campaign.defenderAllianceID;
  const defenderScoreAfter = clampScore(
    Number(campaign.scoresByTeam[String(campaign.defenderAllianceID)]) +
      (defenderWon ? NODE_SCORE_DELTA : -NODE_SCORE_DELTA),
  );
  const terminalResult = defenderScoreAfter >= 1 - 1e-9
    ? "defender"
    : defenderScoreAfter <= 1e-9
      ? "attacker"
      : null;
  let replacement = null;
  if (!terminalResult) {
    replacement = buildCommandNodeCandidate(
      target,
      campaign,
      nowMs,
      node.nodeID,
    );
    if (!replacement) {
      return failure("SOVEREIGNTY_COMMAND_NODE_REPLACEMENT_REQUIRED");
    }
  }
  const committed = commitSovereigntyCommandNodeCapture({
    sourceSolarSystemID: target.solarSystemID,
    targetID: target.targetID,
    campaignEpoch: campaign.campaignEpoch,
    nodeID: node.nodeID,
    winnerAllianceID: allianceID,
    defenderAllianceID: campaign.defenderAllianceID,
    scoreDelta: defenderWon ? NODE_SCORE_DELTA : -NODE_SCORE_DELTA,
    completedAtTime: unixMsToFiletimeString(nowMs),
    replacementStructure: replacement
      ? {
          solarSystemID: replacement.solarSystemID,
          structure: replacement.structure,
        }
      : null,
    // The candidate allocator advances this cursor while it chooses a
    // replacement. Persist it with the same atomic score/node commit so a
    // restart (or a long replacement chain) can never reuse an earlier node
    // identity.
    nextNodeSequence: replacement
      ? campaign.nextNodeSequence
      : undefined,
    effectOptions: { suppressNotifications: true },
  });
  if (!committed || committed.success === false) {
    return committed || failure("SOVEREIGNTY_COMMAND_NODE_COMMIT_FAILED");
  }
  commandNodeRuntimes.delete(Number(node.nodeID));
  const canonicalCampaign = cloneValue(committed.data.campaign);
  if (committed.data.terminalPending) {
    const terminal = finishCampaign(
      target,
      canonicalCampaign,
      canonicalCampaign.result,
      nowMs,
    );
    if (!terminal || terminal.success === false) {
      return terminal || failure("SOVEREIGNTY_CAMPAIGN_FINISH_FAILED");
    }
  }
  return success({
    targetID: target.targetID,
    nodeID: node.nodeID,
    result: canonicalCampaign.result,
    scoresByTeam: cloneValue(canonicalCampaign.scoresByTeam),
    replacementNodeID: committed.data.replacementNodeID,
  }, { completed: committed.data.terminalPending === true });
}

// Completes a command node for one side at once, then commits the capture
// through the same path a finished Entosis cycle takes.
function forceCommandNodeCapture(options = {}) {
  const resolved = resolveCommandNodeForAction(options);
  if (!resolved.success) {
    return resolved;
  }
  const { node, campaign } = resolved.data;
  const allianceID = normalizePositiveInteger(options.allianceID, null);
  if (!allianceID) {
    return failure("SOVEREIGNTY_COMMAND_NODE_ALLIANCE_REQUIRED");
  }
  const nowMs = normalizeNowMs(options.nowMs);
  const controllingTeamID =
    allianceID === Number(campaign.defenderAllianceID)
      ? Number(campaign.defenderAllianceID)
      : -Number(campaign.defenderAllianceID);
  const endpoint = {
    ...(node.nodeState || {}),
    controllingTeamID,
    scoreAtLastUpdateTime: 1,
    lastUpdatedMs: nowMs,
    hasScored: true,
  };
  if (!writeCommandNodeState(node, campaign, endpoint, {
    scoringTeamID: controllingTeamID,
    scoringRate: 0,
    isBlocked: false,
  })) {
    return failure("SOVEREIGNTY_COMMAND_NODE_TEST_ENDPOINT_FAILED");
  }
  return captureSovereigntyCommandNode(options);
}

function tickCommandNodeCapture(options = {}) {
  const resolved = resolveCommandNodeForAction(options);
  if (!resolved.success) {
    return resolved;
  }
  const { node, campaign } = resolved.data;
  const nowMs = normalizeNowMs(options.nowMs);
  const runtime = commandNodeRuntimes.get(node.nodeID) || null;
  const liveState = buildNodeLiveState(node, campaign, runtime);
  const nodeState = node.nodeState || {
    controllingTeamID: campaign.defenderAllianceID,
    scoreAtLastUpdateTime: 0.5,
    lastUpdatedMs: nowMs,
  };
  const checkpoint = checkpointCommandNodeAt(
    { ...node, nodeState },
    campaign,
    runtime,
    nowMs,
  );
  Object.assign(nodeState, checkpoint.nodeState);

  if (
    nodeState.scoreAtLastUpdateTime >= 1 &&
    Number(liveState.scoringTeamID) === Number(nodeState.controllingTeamID)
  ) {
    const winnerAllianceID = findActiveNodeScoringAlliance(
      runtime,
      campaign,
      liveState.scoringTeamID,
    ) || (
      Number(liveState.scoringTeamID) === Number(campaign.defenderAllianceID)
        ? Number(campaign.defenderAllianceID)
        : null
    );
    if (!winnerAllianceID) {
      return failure("SOVEREIGNTY_COMMAND_NODE_SCORER_STALE");
    }
    nodeState.completionCandidateAllianceID = winnerAllianceID;
    if (!writeCommandNodeState(node, campaign, nodeState, {
      scoringTeamID: liveState.scoringTeamID,
      scoringRate: 0,
      isBlocked: false,
    })) {
      return failure("SOVEREIGNTY_COMMAND_NODE_ENDPOINT_CHECKPOINT_FAILED");
    }
    return captureSovereigntyCommandNode({
      nodeID: node.nodeID,
      allianceID: winnerAllianceID,
      campaignEpoch: campaign.campaignEpoch,
      nowMs,
    });
  }
  if (nodeState.scoreAtLastUpdateTime <= 0 && liveState.scoringTeamID != null) {
    // Command nodes are two-directional. Burning the incumbent's progress does
    // not capture the node: controller flips at zero, then the challenger must
    // build 0 -> 1. The V24.01 client explicitly adds one full score to its
    // negative-rate ETA for this second leg.
    nodeState.controllingTeamID = Number(liveState.scoringTeamID);
    nodeState.scoreAtLastUpdateTime = 0;
    nodeState.lastUpdatedMs = nowMs;
    delete nodeState.completionCandidateAllianceID;
  }
  const nextLiveState = buildNodeLiveState(
    { ...node, nodeState },
    campaign,
    runtime,
  );
  writeCommandNodeState(node, campaign, nodeState, nextLiveState);
  return success(cloneValue(nodeState));
}

function spawnExtraCommandNodes(options = {}) {
  const targetID = normalizePositiveInteger(options.targetID, null);
  const target = targetID && findHubByCampaignTarget(targetID);
  const campaign = target && getCampaignMetadata(target.structure);
  if (!target || !campaign || campaign.status !== "active") {
    return failure("SOVEREIGNTY_CAMPAIGN_NOT_ACTIVE");
  }
  const created = spawnCommandNodes(
    target,
    campaign,
    normalizeInteger(options.count, 0),
    normalizeNowMs(options.nowMs),
  );
  return success({ createdNodeIDs: created.map((node) => node.nodeID) });
}

function resetSovereigntyCampaignRuntimeForTests() {
  ownedHubRuntimes.clear();
  commandNodeRuntimes.clear();
  completedCampaigns.clear();
}

module.exports = {
  OWNED_HUB_CAPTURE_TIME_SECONDS,
  COMMAND_NODE_CAPTURE_TIME_SECONDS,
  DEFENDER_REGEN_RATE,
  COMMAND_NODE_DEFENDER_REGEN_RATE,
  INITIAL_CAMPAIGN_DEFENDER_SCORE,
  NODE_SCORE_DELTA,
  INITIAL_COMMAND_NODE_COUNT,
  MAX_COMMAND_NODES_PER_SYSTEM,
  MAX_COMMAND_NODES_PER_CONSTELLATION,
  EXTRA_COMMAND_NODE_SPAWN_INTERVAL_MS,
  EXTRA_COMMAND_NODE_SPAWN_JITTER,
  COMMAND_NODE_TYPE_ID,
  DURABLE_CAMPAIGN_TICK_JOB_TYPE,
  bindDurableScheduler,
  buildCampaignTickJob,
  configureSovereigntyVulnerability,
  registerOwnedHubEntosisWarmup,
  beginOwnedHubEntosisScoring,
  stopOwnedHubEntosisScoring,
  tickOwnedHubCapture,
  getOwnedHubCaptureProjection,
  tickSovereigntyCampaigns,
  handleDurableSovereigntyCampaignTick,
  reconcileSovereigntyCampaigns,
  ensureOwnedHubVulnerability,
  unbindDurableScheduler,
  getSovereigntyCampaignProjection,
  registerCommandNodeEntosisWarmup,
  beginCommandNodeEntosisScoring,
  stopCommandNodeEntosisScoring,
  tickCommandNodeCapture,
  captureSovereigntyCommandNode,
  resetSovereigntyCampaignRuntimeForTests,
  forceOwnedHubReinforcement,
  shiftOwnedHubTimers,
  clearOwnedHubVulnerabilityState,
  forceCommandNodeCapture,
  _testing: {
    getCommandNodeIDBase,
    spawnExtraCommandNodes,
    captureCommandNodeForTeam: forceCommandNodeCapture,
    setCampaignRandomSource,
    scheduleReinforcementExit,
    tickExtraCommandNodeSpawn,
    nearestPrimeHourCenter,
    lockNextWindowIfDue,
    rollToNextDailyWindow,
    nextWindowEventMs,
  },
};
