"use strict";

const {
  cloneValue,
} = require("../../common/clone");

const path = require("node:path");

const {
  getAllianceRecord,
} = require(path.join(__dirname, "../corporation/corporationState"));
const {
  getActiveExecutorCorporationID,
} = require(path.join(__dirname, "../corporation/allianceGovernanceState"));
const {
  FILETIME_EPOCH_OFFSET,
  FILETIME_TICKS_PER_MILLISECOND,
  TYPE_INFRASTRUCTURE_HUB,
} = require(path.join(__dirname, "./sovConstants"));
const {
  commitInitialSovereigntyHubCapture,
  findSovereigntyStructureByID,
  listAllSovereigntySystemStates,
  setStructureEntosisCapture,
  tickStrategicClaimAge,
} = require(path.join(__dirname, "./sovState"));

const SOV_HUB_CAPTURE_TIME_SECONDS = 595;
const SOV_HUB_CAPTURE_TIME_MS = SOV_HUB_CAPTURE_TIME_SECONDS * 1000;
const NEUTRAL_DEFENDER_TEAM_ID = 1;
const OWNER_SCC = 1000132;

// Entosis modules and their warmup/scoring phases are deliberately process
// local. The score checkpoint is durable, but an emulator restart cannot keep
// a ship module active and therefore must never advance a stale scoring rate.
const liveTargets = new Map();

function normalizePositiveInteger(value, fallback = null) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return fallback;
  }
  const integerValue = Math.trunc(numericValue);
  return integerValue > 0 ? integerValue : fallback;
}

function normalizeNowMs(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue >= 0
    ? Math.trunc(numericValue)
    : Date.now();
}

function unixMsToFiletimeString(value) {
  return (
    FILETIME_EPOCH_OFFSET +
    BigInt(normalizeNowMs(value)) * FILETIME_TICKS_PER_MILLISECOND
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

function clampScore(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return 0;
  }
  return Math.max(0, Math.min(1, numericValue));
}

function buildCaptureEpoch(solarSystemID, targetID, nowMs) {
  return `initial-hub:${solarSystemID}:${targetID}:${normalizeNowMs(nowMs)}`;
}

function buildIdleCapture(target, nowMs) {
  const existing = target.structure.entosisCapture || {};
  const captureEpoch =
    String(existing.captureEpoch || "").trim() ||
    String(
      target.structure.devFlags &&
        target.structure.devFlags.sovereigntyCaptureEpoch ||
        "",
    ).trim() ||
    buildCaptureEpoch(target.solarSystemID, target.structure.itemID, nowMs);
  return {
    schemaVersion: 1,
    captureEpoch,
    controllingTeamID: normalizePositiveInteger(existing.controllingTeamID, null),
    scoringTeamID: normalizePositiveInteger(existing.scoringTeamID, null),
    scoreAtLastUpdateTime: clampScore(existing.scoreAtLastUpdateTime),
    lastUpdatedScoreTime:
      String(existing.lastUpdatedScoreTime || "0") !== "0"
        ? String(existing.lastUpdatedScoreTime)
        : unixMsToFiletimeString(nowMs),
    scoringRate: 0,
    isBlocked: false,
    defenderTeamID: NEUTRAL_DEFENDER_TEAM_ID,
    completionCandidateAllianceID: normalizePositiveInteger(
      existing.completionCandidateAllianceID,
      null,
    ),
    completionBlockedReason:
      String(existing.completionBlockedReason || "").trim() || null,
    completionReceipt:
      existing.completionReceipt && typeof existing.completionReceipt === "object"
        ? cloneValue(existing.completionReceipt)
        : null,
  };
}

function resolveNeutralCaptureTarget({ targetID, solarSystemID = null } = {}) {
  const numericTargetID = normalizePositiveInteger(targetID, null);
  const numericSolarSystemID = normalizePositiveInteger(solarSystemID, null);
  if (!numericTargetID) {
    return { success: false, errorMsg: "SOVEREIGNTY_CAPTURE_TARGET_REQUIRED" };
  }
  const found = findSovereigntyStructureByID(
    numericTargetID,
    numericSolarSystemID,
  );
  if (!found) {
    return { success: false, errorMsg: "SOVEREIGNTY_CAPTURE_TARGET_NOT_FOUND" };
  }
  const structure = found.structure || {};
  const system = found.system || {};
  const neutralHub =
    Number(structure.typeID) === TYPE_INFRASTRUCTURE_HUB &&
    Number(structure.ownerID) === OWNER_SCC &&
    Number(structure.corporationID) === OWNER_SCC &&
    !normalizePositiveInteger(structure.allianceID, null) &&
    Number(system.claimStructureID || 0) !== numericTargetID &&
    Number(system.infrastructureHubID || 0) !== numericTargetID &&
    !(
      structure.devFlags &&
      structure.devFlags.sovereigntyCaptured === true
    );
  if (!neutralHub) {
    return { success: false, errorMsg: "SOVEREIGNTY_CAPTURE_TARGET_NOT_NEUTRAL" };
  }
  return {
    success: true,
    data: {
      solarSystemID: Number(found.solarSystemID),
      targetID: numericTargetID,
      system,
      structure,
    },
  };
}

function validateAlliance(allianceID) {
  const numericAllianceID = normalizePositiveInteger(allianceID, null);
  if (!numericAllianceID) {
    return { success: false, errorMsg: "ALLIANCE_MEMBERSHIP_REQUIRED" };
  }
  const alliance = getAllianceRecord(numericAllianceID);
  if (!alliance || alliance.deleted) {
    return { success: false, errorMsg: "ALLIANCE_NOT_FOUND" };
  }
  return { success: true, allianceID: numericAllianceID };
}

function getOrCreateLiveTarget(target, nowMs) {
  const targetID = Number(target.targetID);
  let runtime = liveTargets.get(targetID);
  let capture;
  if (!runtime) {
    capture = buildIdleCapture(target, nowMs);
    runtime = {
      targetID,
      solarSystemID: Number(target.solarSystemID),
      links: new Map(),
    };
    liveTargets.set(targetID, runtime);

    // A persisted non-zero rate belongs to a process-local module that no
    // longer exists. Retain the last checkpoint and explicitly fence it idle.
    const stored = target.structure.entosisCapture;
    if (stored && (Number(stored.scoringRate) !== 0 || stored.isBlocked === true)) {
      setStructureEntosisCapture(
        target.solarSystemID,
        targetID,
        capture,
      );
    }
  } else {
    capture = target.structure.entosisCapture
      ? cloneValue(target.structure.entosisCapture)
      : buildIdleCapture(target, nowMs);
  }
  return { runtime, capture };
}

function persistCapture(target, capture, options = {}) {
  const result = setStructureEntosisCapture(
    target.solarSystemID,
    target.targetID,
    capture,
    options,
  );
  return result
    ? { success: true, changed: true, capture: cloneValue(capture) }
    : { success: false, errorMsg: "SOVEREIGNTY_CAPTURE_CHECKPOINT_FAILED" };
}

function getScoringAllianceIDs(runtime) {
  return [
    ...new Set(
      [...runtime.links.values()]
        .filter((link) => link && link.phase === "scoring")
        .map((link) => normalizePositiveInteger(link.allianceID, null))
        .filter(Boolean),
    ),
  ].sort((left, right) => left - right);
}

function applyCoalitionState(capture, runtime, nowMs) {
  const allianceIDs = getScoringAllianceIDs(runtime);
  const next = {
    ...capture,
    lastUpdatedScoreTime: unixMsToFiletimeString(nowMs),
    scoringRate: 0,
    isBlocked: false,
    defenderTeamID: NEUTRAL_DEFENDER_TEAM_ID,
    completionBlockedReason: null,
  };
  if (allianceIDs.length === 0) {
    return next;
  }
  if (allianceIDs.length > 1) {
    next.scoringTeamID = null;
    next.scoringRate = 0;
    next.isBlocked = true;
    return next;
  }
  const allianceID = allianceIDs[0];
  next.scoringTeamID = allianceID;
  if (
    clampScore(next.scoreAtLastUpdateTime) <= 0 ||
    Number(next.controllingTeamID) === allianceID
  ) {
    next.controllingTeamID = allianceID;
    next.scoringRate = 1;
  } else {
    next.scoringRate = -1;
  }
  return next;
}

function materializeCapture(capture, runtime, nowMs) {
  const anchorMs = filetimeToUnixMs(capture.lastUpdatedScoreTime, nowMs);
  const elapsedMs = Math.max(0, nowMs - anchorMs);
  const score = clampScore(capture.scoreAtLastUpdateTime);
  const rate = Number(capture.scoringRate) > 0
    ? 1
    : Number(capture.scoringRate) < 0
      ? -1
      : 0;
  if (rate === 0 || elapsedMs === 0) {
    return {
      capture: {
        ...capture,
        scoreAtLastUpdateTime: score,
        lastUpdatedScoreTime: unixMsToFiletimeString(nowMs),
      },
      reachedCompletion: score >= 1,
      crossedZero: false,
    };
  }
  if (rate > 0) {
    const rawScore = score + elapsedMs / SOV_HUB_CAPTURE_TIME_MS;
    const completionAtMs =
      anchorMs + (1 - score) * SOV_HUB_CAPTURE_TIME_MS;
    return {
      capture: {
        ...capture,
        scoreAtLastUpdateTime: clampScore(rawScore),
        lastUpdatedScoreTime: unixMsToFiletimeString(nowMs),
      },
      reachedCompletion: rawScore >= 1,
      completionAtMs,
      crossedZero: false,
    };
  }

  const zeroAtMs = anchorMs + score * SOV_HUB_CAPTURE_TIME_MS;
  if (nowMs < zeroAtMs) {
    return {
      capture: {
        ...capture,
        scoreAtLastUpdateTime: clampScore(
          score - elapsedMs / SOV_HUB_CAPTURE_TIME_MS,
        ),
        lastUpdatedScoreTime: unixMsToFiletimeString(nowMs),
      },
      reachedCompletion: false,
      crossedZero: false,
    };
  }

  const scoringAllianceIDs = getScoringAllianceIDs(runtime);
  const challengerAllianceID =
    scoringAllianceIDs.length === 1
      ? scoringAllianceIDs[0]
      : normalizePositiveInteger(capture.scoringTeamID, null);
  const buildElapsedMs = Math.max(0, nowMs - zeroAtMs);
  const builtScore = buildElapsedMs / SOV_HUB_CAPTURE_TIME_MS;
  return {
    capture: {
      ...capture,
      controllingTeamID: challengerAllianceID,
      scoringTeamID: challengerAllianceID,
      scoreAtLastUpdateTime: clampScore(builtScore),
      lastUpdatedScoreTime: unixMsToFiletimeString(nowMs),
      scoringRate: challengerAllianceID ? 1 : 0,
      isBlocked: false,
    },
    reachedCompletion: Boolean(challengerAllianceID && builtScore >= 1),
    completionAtMs: zeroAtMs + SOV_HUB_CAPTURE_TIME_MS,
    crossedZero: true,
    zeroAtMs,
    challengerAllianceID,
  };
}

function prepareOrResumeCompletion(target, capture, winnerAllianceID, nowMs) {
  let receipt =
    capture.completionReceipt && typeof capture.completionReceipt === "object"
      ? cloneValue(capture.completionReceipt)
      : null;
  if (!receipt) {
    const executorCorporationID = getActiveExecutorCorporationID(winnerAllianceID);
    if (!executorCorporationID) {
      const blocked = {
        ...capture,
        controllingTeamID: winnerAllianceID,
        scoringTeamID: winnerAllianceID,
        scoreAtLastUpdateTime: 1,
        lastUpdatedScoreTime: unixMsToFiletimeString(nowMs),
        scoringRate: 0,
        isBlocked: false,
        completionCandidateAllianceID: winnerAllianceID,
        completionBlockedReason: "activeExecutorRequired",
        completionReceipt: null,
      };
      const alreadyBlocked =
        clampScore(capture.scoreAtLastUpdateTime) >= 1 &&
        capture.completionBlockedReason === "activeExecutorRequired" &&
        Number(capture.scoringRate) === 0 &&
        capture.isBlocked !== true;
      if (alreadyBlocked) {
        return {
          success: true,
          completed: false,
          blocked: true,
          changed: false,
          capture: blocked,
        };
      }
      const checkpoint = persistCapture(target, blocked);
      return checkpoint.success
        ? {
            success: true,
            completed: false,
            blocked: true,
            changed: true,
            capture: blocked,
          }
        : checkpoint;
    }
    receipt = {
      captureEpoch: capture.captureEpoch,
      winnerAllianceID,
      executorCorporationID,
      status: "prepared",
      preparedAtTime: unixMsToFiletimeString(nowMs),
      claimTime: unixMsToFiletimeString(nowMs),
      completedAtTime: "0",
    };
    const prepared = {
      ...capture,
      controllingTeamID: winnerAllianceID,
      scoringTeamID: winnerAllianceID,
      scoreAtLastUpdateTime: 1,
      lastUpdatedScoreTime: unixMsToFiletimeString(nowMs),
      scoringRate: 0,
      isBlocked: false,
      completionCandidateAllianceID: winnerAllianceID,
      completionBlockedReason: null,
      completionReceipt: receipt,
    };
    const checkpoint = persistCapture(target, prepared, {
      suppressNotifications: true,
    });
    if (!checkpoint.success) {
      return checkpoint;
    }
    capture = prepared;
  }

  const commit = commitInitialSovereigntyHubCapture({
    solarSystemID: target.solarSystemID,
    targetID: target.targetID,
    winnerAllianceID: Number(receipt.winnerAllianceID),
    executorCorporationID: Number(receipt.executorCorporationID),
    captureEpoch: String(receipt.captureEpoch),
    claimTime:
      String(receipt.claimTime || "0") !== "0"
        ? String(receipt.claimTime)
        : String(receipt.preparedAtTime || unixMsToFiletimeString(nowMs)),
  });
  if (!commit || commit.success === false) {
    return commit || {
      success: false,
      errorMsg: "SOVEREIGNTY_CAPTURE_COMMIT_FAILED",
    };
  }
  liveTargets.delete(target.targetID);
  return {
    success: true,
    completed: true,
    changed: true,
    data: commit.data || {},
  };
}

function advanceForOperation(target, runtime, capture, nowMs) {
  if (
    capture.completionReceipt ||
    clampScore(capture.scoreAtLastUpdateTime) >= 1
  ) {
    const winnerAllianceID = normalizePositiveInteger(
      capture.completionReceipt && capture.completionReceipt.winnerAllianceID,
      normalizePositiveInteger(
        capture.completionCandidateAllianceID,
        capture.controllingTeamID,
      ),
    );
    if (winnerAllianceID) {
      return prepareOrResumeCompletion(target, capture, winnerAllianceID, nowMs);
    }
  }
  const materialized = materializeCapture(capture, runtime, nowMs);
  if (materialized.reachedCompletion) {
    const winnerAllianceID = normalizePositiveInteger(
      materialized.capture.controllingTeamID,
      materialized.capture.scoringTeamID,
    );
    return prepareOrResumeCompletion(
      target,
      materialized.capture,
      winnerAllianceID,
      materialized.completionAtMs || nowMs,
    );
  }
  return {
    success: true,
    completed: false,
    capture: materialized.capture,
  };
}

function registerEntosisWarmup(options = {}) {
  const nowMs = normalizeNowMs(options.nowMs);
  const targetResult = resolveNeutralCaptureTarget(options);
  if (!targetResult.success) {
    return targetResult;
  }
  const allianceResult = validateAlliance(options.allianceID);
  if (!allianceResult.success) {
    return allianceResult;
  }
  const linkID = normalizePositiveInteger(options.linkID, null);
  if (!linkID) {
    return { success: false, errorMsg: "ENTOSIS_LINK_REQUIRED" };
  }
  const target = targetResult.data;
  const { runtime, capture } = getOrCreateLiveTarget(target, nowMs);
  const existing = runtime.links.get(linkID);
  if (existing && Number(existing.allianceID) !== allianceResult.allianceID) {
    return { success: false, errorMsg: "ENTOSIS_LINK_AUTHORITY_CHANGED" };
  }
  if (!existing) {
    runtime.links.set(linkID, {
      linkID,
      allianceID: allianceResult.allianceID,
      phase: "warmup",
      registeredAtMs: nowMs,
    });
  }
  if (!target.structure.entosisCapture) {
    const checkpoint = persistCapture(target, capture);
    if (!checkpoint.success) {
      runtime.links.delete(linkID);
      return checkpoint;
    }
  }
  return {
    success: true,
    data: { targetID: target.targetID, warmup: true },
  };
}

function beginEntosisScoring(options = {}) {
  const nowMs = normalizeNowMs(options.nowMs);
  const targetResult = resolveNeutralCaptureTarget(options);
  if (!targetResult.success) {
    return targetResult;
  }
  const allianceResult = validateAlliance(options.allianceID);
  if (!allianceResult.success) {
    return allianceResult;
  }
  const linkID = normalizePositiveInteger(options.linkID, null);
  if (!linkID) {
    return { success: false, errorMsg: "ENTOSIS_LINK_REQUIRED" };
  }
  const target = targetResult.data;
  const { runtime, capture } = getOrCreateLiveTarget(target, nowMs);
  const existing = runtime.links.get(linkID);
  if (existing && Number(existing.allianceID) !== allianceResult.allianceID) {
    return { success: false, errorMsg: "ENTOSIS_LINK_AUTHORITY_CHANGED" };
  }
  if (existing && existing.phase === "scoring") {
    return { success: true, data: { targetID: target.targetID, scoring: true } };
  }
  const advanced = advanceForOperation(target, runtime, capture, nowMs);
  if (!advanced.success || advanced.completed || advanced.blocked) {
    return advanced;
  }
  runtime.links.set(linkID, {
    linkID,
    allianceID: allianceResult.allianceID,
    phase: "scoring",
    registeredAtMs: existing ? existing.registeredAtMs : nowMs,
    scoringStartedAtMs: nowMs,
  });
  const next = applyCoalitionState(advanced.capture, runtime, nowMs);
  const checkpoint = persistCapture(target, next);
  if (!checkpoint.success) {
    runtime.links.delete(linkID);
    return checkpoint;
  }
  return {
    success: true,
    data: { targetID: target.targetID, scoring: true },
  };
}

function stopEntosisScoring(options = {}) {
  const nowMs = normalizeNowMs(options.nowMs);
  const targetID = normalizePositiveInteger(options.targetID, null);
  const linkID = normalizePositiveInteger(options.linkID, null);
  if (!targetID || !linkID) {
    return { success: false, errorMsg: "ENTOSIS_LINK_TARGET_REQUIRED" };
  }
  const found = findSovereigntyStructureByID(targetID, options.solarSystemID);
  if (!found) {
    // A completed capture removes its runtime entry. Deactivation after that
    // commit is an idempotent cleanup, not a failed module shutdown.
    liveTargets.delete(targetID);
    return { success: true, data: { stopped: false } };
  }
  const target = {
    solarSystemID: Number(found.solarSystemID),
    targetID,
    system: found.system,
    structure: found.structure,
  };
  const runtime = liveTargets.get(targetID);
  if (!runtime) {
    const idle = buildIdleCapture(target, nowMs);
    if (target.structure.entosisCapture) {
      const checkpoint = persistCapture(target, idle);
      if (!checkpoint.success) {
        return checkpoint;
      }
    }
    return { success: true, data: { stopped: false } };
  }
  if (!runtime.links.has(linkID)) {
    return { success: true, data: { stopped: false } };
  }
  const capture = target.structure.entosisCapture
    ? cloneValue(target.structure.entosisCapture)
    : buildIdleCapture(target, nowMs);
  const advanced = advanceForOperation(target, runtime, capture, nowMs);
  if (!advanced.success || advanced.completed || advanced.blocked) {
    runtime.links.delete(linkID);
    if (runtime.links.size === 0) {
      liveTargets.delete(targetID);
    }
    return advanced;
  }
  runtime.links.delete(linkID);
  const next = applyCoalitionState(advanced.capture, runtime, nowMs);
  const checkpoint = persistCapture(target, next);
  if (!checkpoint.success) {
    return checkpoint;
  }
  if (runtime.links.size === 0) {
    liveTargets.delete(targetID);
  }
  return { success: true, data: { stopped: true } };
}

function tickOneTarget(targetID, nowMs) {
  const found = findSovereigntyStructureByID(targetID);
  if (!found) {
    liveTargets.delete(targetID);
    return { success: true, completed: false, missing: true };
  }
  const target = {
    solarSystemID: Number(found.solarSystemID),
    targetID: Number(targetID),
    system: found.system,
    structure: found.structure,
  };
  let runtime = liveTargets.get(target.targetID);
  if (!runtime) {
    runtime = {
      targetID: target.targetID,
      solarSystemID: target.solarSystemID,
      links: new Map(),
    };
  }
  let capture = target.structure.entosisCapture
    ? cloneValue(target.structure.entosisCapture)
    : buildIdleCapture(target, nowMs);

  // A target explicitly ticked after restart has no live link. Clear only the
  // rate; never extrapolate the persisted checkpoint across process downtime.
  if (!liveTargets.has(target.targetID)) {
    if (capture.completionReceipt || clampScore(capture.scoreAtLastUpdateTime) >= 1) {
      const winnerAllianceID = normalizePositiveInteger(
        capture.completionReceipt && capture.completionReceipt.winnerAllianceID,
        normalizePositiveInteger(
          capture.completionCandidateAllianceID,
          capture.controllingTeamID,
        ),
      );
      if (winnerAllianceID) {
        return prepareOrResumeCompletion(target, capture, winnerAllianceID, nowMs);
      }
    }
    if (Number(capture.scoringRate) !== 0 || capture.isBlocked === true) {
      capture = {
        ...capture,
        scoringRate: 0,
        isBlocked: false,
      };
      return persistCapture(target, capture);
    }
    return { success: true, completed: false };
  }

  if (capture.completionReceipt || clampScore(capture.scoreAtLastUpdateTime) >= 1) {
    const winnerAllianceID = normalizePositiveInteger(
      capture.completionReceipt && capture.completionReceipt.winnerAllianceID,
      normalizePositiveInteger(
        capture.completionCandidateAllianceID,
        capture.controllingTeamID,
      ),
    );
    if (winnerAllianceID) {
      return prepareOrResumeCompletion(target, capture, winnerAllianceID, nowMs);
    }
  }

  const anchorMs = filetimeToUnixMs(capture.lastUpdatedScoreTime, nowMs);
  const score = clampScore(capture.scoreAtLastUpdateTime);
  const rate = Number(capture.scoringRate) > 0
    ? 1
    : Number(capture.scoringRate) < 0
      ? -1
      : 0;
  if (rate > 0) {
    const completionAtMs = anchorMs + (1 - score) * SOV_HUB_CAPTURE_TIME_MS;
    if (nowMs >= completionAtMs) {
      return prepareOrResumeCompletion(
        target,
        {
          ...capture,
          scoreAtLastUpdateTime: 1,
          lastUpdatedScoreTime: unixMsToFiletimeString(completionAtMs),
        },
        normalizePositiveInteger(capture.controllingTeamID, capture.scoringTeamID),
        completionAtMs,
      );
    }
    return { success: true, completed: false };
  }
  if (rate < 0) {
    const zeroAtMs = anchorMs + score * SOV_HUB_CAPTURE_TIME_MS;
    if (nowMs >= zeroAtMs) {
      const allianceIDs = getScoringAllianceIDs(runtime);
      const challengerAllianceID =
        allianceIDs.length === 1
          ? allianceIDs[0]
          : normalizePositiveInteger(capture.scoringTeamID, null);
      const pivot = {
        ...capture,
        controllingTeamID: challengerAllianceID,
        scoringTeamID: challengerAllianceID,
        scoreAtLastUpdateTime: 0,
        lastUpdatedScoreTime: unixMsToFiletimeString(zeroAtMs),
        scoringRate: challengerAllianceID ? 1 : 0,
        isBlocked: false,
      };
      const completionAtMs = zeroAtMs + SOV_HUB_CAPTURE_TIME_MS;
      if (challengerAllianceID && nowMs >= completionAtMs) {
        return prepareOrResumeCompletion(
          target,
          {
            ...pivot,
            scoreAtLastUpdateTime: 1,
            lastUpdatedScoreTime: unixMsToFiletimeString(completionAtMs),
          },
          challengerAllianceID,
          completionAtMs,
        );
      }
      const checkpoint = persistCapture(target, pivot);
      return checkpoint.success
        ? {
            success: true,
            completed: false,
            transitioned: true,
            changed: true,
          }
        : checkpoint;
    }
  }
  return { success: true, completed: false };
}

function tickSovereigntyCapture(options = {}) {
  const nowMs = normalizeNowMs(options.nowMs);
  const targetID = normalizePositiveInteger(options.targetID, null);
  const solarSystemID = normalizePositiveInteger(options.solarSystemID, null);
  const strategicAgeResult = solarSystemID
    ? tickStrategicClaimAge(solarSystemID, nowMs)
    : null;
  if (strategicAgeResult && strategicAgeResult.success === false) {
    return strategicAgeResult;
  }
  let targetIDs;
  if (targetID) {
    targetIDs = [targetID];
  } else {
    targetIDs = [...liveTargets.values()]
      .filter(
        (runtime) =>
          !solarSystemID || Number(runtime.solarSystemID) === solarSystemID,
      )
      .map((runtime) => runtime.targetID);
  }
  const results = targetIDs.map((candidateTargetID) => ({
    targetID: candidateTargetID,
    ...tickOneTarget(candidateTargetID, nowMs),
  }));
  const failure = results.find((result) => result.success === false);
  if (failure) {
    return failure;
  }
  return {
    success: true,
    data: {
      available: true,
      tickedTargets: results.length,
      completedTargets: results.filter((result) => result.completed).length,
      changed: results.some(
        (result) =>
          result.completed === true ||
          result.transitioned === true ||
          result.changed === true,
      ),
      strategicAge: strategicAgeResult && strategicAgeResult.data || null,
      results,
    },
  };
}

function reconcilePreparedSovereigntyCaptures(options = {}) {
  const nowMs = normalizeNowMs(options.nowMs);
  const results = [];
  for (const system of listAllSovereigntySystemStates()) {
    for (const structure of Array.isArray(system.structures)
      ? system.structures
      : []) {
      if (Number(structure && structure.typeID) !== TYPE_INFRASTRUCTURE_HUB) {
        continue;
      }
      const capture =
        structure &&
        structure.entosisCapture &&
        typeof structure.entosisCapture === "object"
          ? cloneValue(structure.entosisCapture)
          : null;
      if (!capture) {
        continue;
      }
      const receipt =
        capture.completionReceipt &&
        typeof capture.completionReceipt === "object"
          ? capture.completionReceipt
          : null;
      const hasPreparedReceipt = receipt && receipt.status === "prepared";
      const hasBlockedWinner =
        !receipt &&
        clampScore(capture.scoreAtLastUpdateTime) >= 1 &&
        normalizePositiveInteger(
          capture.completionCandidateAllianceID,
          capture.controllingTeamID,
        );
      const hasStaleRuntimeRate =
        Number(capture.scoringRate) !== 0 || capture.isBlocked === true;
      if (
        !hasPreparedReceipt &&
        !hasBlockedWinner &&
        !hasStaleRuntimeRate
      ) {
        continue;
      }
      const target = {
        solarSystemID: Number(system.solarSystemID),
        targetID: Number(structure.itemID),
        system,
        structure,
      };
      const winnerAllianceID = normalizePositiveInteger(
        receipt && receipt.winnerAllianceID,
        normalizePositiveInteger(
          capture.completionCandidateAllianceID,
          capture.controllingTeamID,
        ),
      );
      let result;
      if (hasPreparedReceipt || hasBlockedWinner) {
        result = winnerAllianceID
          ? prepareOrResumeCompletion(target, capture, winnerAllianceID, nowMs)
          : { success: false, errorMsg: "SOVEREIGNTY_CAPTURE_WINNER_MISSING" };
      } else {
        result = persistCapture(target, {
          ...capture,
          scoringRate: 0,
          isBlocked: false,
        });
      }
      results.push({
        solarSystemID: target.solarSystemID,
        targetID: target.targetID,
        ...result,
      });
    }
  }
  const failure = results.find((result) => result.success === false);
  return {
    success: !failure,
    errorMsg: failure ? failure.errorMsg : null,
    data: {
      scannedCandidates: results.length,
      completed: results.filter((result) => result.completed === true).length,
      blocked: results.filter((result) => result.blocked === true).length,
      changed: results.some((result) => result.changed === true),
      results,
    },
  };
}

function getSovereigntyCaptureProjection(options = {}) {
  const targetID = normalizePositiveInteger(options.targetID, null);
  if (!targetID) {
    return null;
  }
  const found = findSovereigntyStructureByID(targetID, options.solarSystemID);
  if (!found || Number(found.structure.typeID) !== TYPE_INFRASTRUCTURE_HUB) {
    return null;
  }
  const nowMs = normalizeNowMs(options.nowMs);
  const capture = found.structure.entosisCapture
    ? cloneValue(found.structure.entosisCapture)
    : buildIdleCapture(
        {
          solarSystemID: found.solarSystemID,
          targetID,
          structure: found.structure,
        },
        nowMs,
      );
  const runtime = liveTargets.get(targetID);
  const runtimeHasScoringLinks = Boolean(
    runtime && getScoringAllianceIDs(runtime).length > 0,
  );
  const scoringRate = runtimeHasScoringLinks
    ? Number(capture.scoringRate) > 0
      ? 1
      : Number(capture.scoringRate) < 0
        ? -1
        : 0
    : 0;
  return {
    controllingTeamID: normalizePositiveInteger(capture.controllingTeamID, null),
    scoringTeamID: runtimeHasScoringLinks
      ? normalizePositiveInteger(capture.scoringTeamID, null)
      : normalizePositiveInteger(capture.controllingTeamID, null),
    scoreAtLastUpdateTime: clampScore(capture.scoreAtLastUpdateTime),
    lastUpdatedScoreTime: String(capture.lastUpdatedScoreTime || "0"),
    scoringRate,
    isBlocked: runtimeHasScoringLinks && capture.isBlocked === true,
    defenderTeamID: NEUTRAL_DEFENDER_TEAM_ID,
  };
}

function resetSovereigntyCaptureRuntimeForTests() {
  liveTargets.clear();
}

module.exports = {
  NEUTRAL_DEFENDER_TEAM_ID,
  SOV_HUB_CAPTURE_TIME_SECONDS,
  beginEntosisScoring,
  getSovereigntyCaptureProjection,
  reconcilePreparedSovereigntyCaptures,
  registerEntosisWarmup,
  resetSovereigntyCaptureRuntimeForTests,
  stopEntosisScoring,
  tickSovereigntyCapture,
};
