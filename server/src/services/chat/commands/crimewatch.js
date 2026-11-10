"use strict";

// Crimewatch chat commands: /cwatch (show or clear the caller's crimewatch timers, set the
// safety level, or set the weapon, pvp, npc, criminal, suspect and disapproval timers),
// /naughty (commit an offence in space: set the combat timers and, in high security, call
// CONCORD) and /secstatus (read or set the caller's security status), with the timer and
// safety argument parsing and the status message they share.

const path = require("path");

const spaceRuntime = require("../../../space/runtime");
const crimewatchState = require("../../security/crimewatchState");
const {
  handledResult,
} = require(path.join(__dirname, "./commandReplies"));
const {
  isSpaceSessionReady,
  resolveSessionShipEntity,
  resolveSessionSolarSystemID,
} = require(path.join(__dirname, "./commandSessionLocation"));

function getCrimewatchReferenceMsForSession(session) {
  if (
    session &&
    session._space &&
    Number.isFinite(Number(session._space.simTimeMs))
  ) {
    return Number(session._space.simTimeMs);
  }

  return spaceRuntime.getSimulationTimeMsForSession(session, Date.now());
}

function formatDurationBriefMs(durationMs) {
  const remainingMs = Math.max(0, Math.trunc(Number(durationMs) || 0));
  if (remainingMs <= 0) {
    return "0s";
  }

  const totalSeconds = Math.ceil(remainingMs / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const leftoverMinutes = minutes % 60;
  if (leftoverMinutes > 0) {
    return `${hours}h ${leftoverMinutes}m`;
  }
  return `${hours}h`;
}

function formatCrimewatchSafetyLabel(safetyLevel) {
  switch (Number(safetyLevel)) {
    case crimewatchState.SAFETY_LEVEL_NONE:
      return "NONE";
    case crimewatchState.SAFETY_LEVEL_PARTIAL:
      return "PARTIAL";
    case crimewatchState.SAFETY_LEVEL_FULL:
    default:
      return "FULL";
  }
}

function parseCrimewatchDurationArgument(argumentText, defaultMs) {
  const normalized = String(argumentText || "").trim().toLowerCase();
  if (!normalized) {
    return {
      success: false,
      errorMsg: "USAGE",
    };
  }

  if (["on", "enable", "enabled", "true"].includes(normalized)) {
    return {
      success: true,
      durationMs: Math.max(0, Math.trunc(Number(defaultMs) || 0)),
    };
  }

  if (["off", "disable", "disabled", "false", "clear", "0"].includes(normalized)) {
    return {
      success: true,
      durationMs: 0,
    };
  }

  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i.exec(normalized);
  if (!match) {
    return {
      success: false,
      errorMsg: "INVALID_DURATION",
    };
  }

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount < 0) {
    return {
      success: false,
      errorMsg: "INVALID_DURATION",
    };
  }

  const unit = String(match[2] || "s").toLowerCase();
  const multiplier = unit === "ms"
    ? 1
    : unit === "m"
      ? 60_000
      : unit === "h"
        ? 3_600_000
        : 1_000;
  return {
    success: true,
    durationMs: Math.max(0, Math.trunc(amount * multiplier)),
  };
}

function parseCrimewatchSafetyArgument(argumentText) {
  const normalized = String(argumentText || "").trim().toLowerCase();
  if (!normalized) {
    return {
      success: false,
      errorMsg: "USAGE",
    };
  }

  if (["full", "green", "2"].includes(normalized)) {
    return {
      success: true,
      safetyLevel: crimewatchState.SAFETY_LEVEL_FULL,
    };
  }
  if (["partial", "yellow", "1"].includes(normalized)) {
    return {
      success: true,
      safetyLevel: crimewatchState.SAFETY_LEVEL_PARTIAL,
    };
  }
  if (["none", "red", "0"].includes(normalized)) {
    return {
      success: true,
      safetyLevel: crimewatchState.SAFETY_LEVEL_NONE,
    };
  }

  return {
    success: false,
    errorMsg: "INVALID_SAFETY_LEVEL",
  };
}

function buildCrimewatchStatusMessage(session) {
  const characterID = session && session.characterID ? session.characterID : 0;
  const now = getCrimewatchReferenceMsForSession(session);
  const state = characterID
    ? crimewatchState.getCharacterCrimewatchState(characterID, now)
    : null;
  const effectiveState = state || {
    safetyLevel: crimewatchState.SAFETY_LEVEL_FULL,
    weaponTimerExpiresAtMs: 0,
    pvpTimerExpiresAtMs: 0,
    npcTimerExpiresAtMs: 0,
    criminalTimerExpiresAtMs: 0,
    disapprovalTimerExpiresAtMs: 0,
    criminal: false,
    suspect: false,
  };

  const remainingWeaponMs = Math.max(
    0,
    Number(effectiveState.weaponTimerExpiresAtMs || 0) - now,
  );
  const remainingPvpMs = Math.max(
    0,
    Number(effectiveState.pvpTimerExpiresAtMs || 0) - now,
  );
  const remainingNpcMs = Math.max(
    0,
    Number(effectiveState.npcTimerExpiresAtMs || 0) - now,
  );
  const remainingPenaltyMs = Math.max(
    0,
    Number(effectiveState.criminalTimerExpiresAtMs || 0) - now,
  );
  const remainingDisapprovalMs = Math.max(
    0,
    Number(effectiveState.disapprovalTimerExpiresAtMs || 0) - now,
  );
  const flagLabel = effectiveState.criminal && remainingPenaltyMs > 0
    ? `CRIMINAL (${formatDurationBriefMs(remainingPenaltyMs)})`
    : effectiveState.suspect && remainingPenaltyMs > 0
      ? `SUSPECT (${formatDurationBriefMs(remainingPenaltyMs)})`
      : "CLEAR";

  return [
    `Crimewatch: safety ${formatCrimewatchSafetyLabel(effectiveState.safetyLevel)}.`,
    `Weapon ${formatDurationBriefMs(remainingWeaponMs)}.`,
    `PvP ${formatDurationBriefMs(remainingPvpMs)}.`,
    `NPC ${formatDurationBriefMs(remainingNpcMs)}.`,
    `Flag ${flagLabel}.`,
    `Disapproval ${formatDurationBriefMs(remainingDisapprovalMs)}.`,
  ].join(" ");
}

function synchronizeCrimewatchSessionState(session, scene, now) {
  const activeScene = scene || (
    isSpaceSessionReady(session)
      ? spaceRuntime.getSceneForSession(session)
      : null
  );
  if (!activeScene) {
    return;
  }

  const referenceNow = Number.isFinite(Number(now))
    ? Number(now)
    : activeScene.getCurrentSimTimeMs();
  crimewatchState.tickScene(activeScene, referenceNow);
}

function handleCrimewatchCommand(session, argumentText, chatHub, options) {
  if (!session || !session.characterID) {
    return handledResult(
      chatHub,
      session,
      options,
      "Select a character before using /cwatch.",
    );
  }

  const usage =
    "Usage: /cwatch [status|clear|safety <full|partial|none>|weapon <off|seconds>|pvp <off|seconds>|npc <off|seconds>|criminal <off|seconds>|suspect <off|seconds>|disapproval <off|seconds>]";
  const trimmed = String(argumentText || "").trim();
  const scene = isSpaceSessionReady(session)
    ? spaceRuntime.getSceneForSession(session)
    : null;
  const now = scene ? scene.getCurrentSimTimeMs() : getCrimewatchReferenceMsForSession(session);
  const offenderEntity = scene ? resolveSessionShipEntity(session) : null;

  if (!trimmed || ["status", "state"].includes(trimmed.toLowerCase())) {
    return handledResult(
      chatHub,
      session,
      options,
      buildCrimewatchStatusMessage(session),
    );
  }

  if (["clear", "reset"].includes(trimmed.toLowerCase())) {
    const result = crimewatchState.setCharacterCrimewatchDebugState(
      session.characterID,
      { clearAll: true },
      {
        now,
        systemID: resolveSessionSolarSystemID(session),
        scene,
        offenderEntity,
      },
    );
    if (!result.success) {
      return handledResult(
        chatHub,
        session,
        options,
        `Crimewatch update failed: ${result.errorMsg || "UNKNOWN_ERROR"}.`,
      );
    }

    synchronizeCrimewatchSessionState(session, scene, now);
    return handledResult(
      chatHub,
      session,
      options,
      `Crimewatch timers cleared. ${buildCrimewatchStatusMessage(session)}`,
    );
  }

  const [subcommandRaw, ...rest] = trimmed.split(/\s+/);
  const subcommand = String(subcommandRaw || "").trim().toLowerCase();
  const valueText = rest.join(" ").trim();
  let updates = null;

  if (subcommand === "safety") {
    const parsed = parseCrimewatchSafetyArgument(valueText);
    if (!parsed.success) {
      return handledResult(chatHub, session, options, usage);
    }
    updates = {
      safetyLevel: parsed.safetyLevel,
    };
  } else if (
    subcommand === "weapon" ||
    subcommand === "pvp" ||
    subcommand === "npc" ||
    subcommand === "criminal" ||
    subcommand === "suspect" ||
    subcommand === "disapproval"
  ) {
    const defaultDurationMs =
      subcommand === "weapon"
        ? crimewatchState.WEAPON_TIMER_DURATION_MS
        : subcommand === "pvp"
          ? crimewatchState.PVP_TIMER_DURATION_MS
          : subcommand === "npc"
            ? crimewatchState.NPC_TIMER_DURATION_MS
            : subcommand === "disapproval"
              ? crimewatchState.DISAPPROVAL_TIMER_DURATION_MS
              : crimewatchState.CRIMINAL_TIMER_DURATION_MS;
    const parsed = parseCrimewatchDurationArgument(valueText, defaultDurationMs);
    if (!parsed.success) {
      return handledResult(chatHub, session, options, usage);
    }

    if (subcommand === "weapon") {
      updates = { weaponTimerMs: parsed.durationMs };
    } else if (subcommand === "pvp") {
      updates = { pvpTimerMs: parsed.durationMs };
    } else if (subcommand === "npc") {
      updates = { npcTimerMs: parsed.durationMs };
    } else if (subcommand === "disapproval") {
      updates = { disapprovalTimerMs: parsed.durationMs };
    } else if (subcommand === "criminal") {
      updates = parsed.durationMs > 0
        ? {
          criminal: true,
          suspect: false,
          criminalTimerMs: parsed.durationMs,
          refreshConcord: true,
        }
        : {
          criminal: false,
          suspect: false,
          criminalTimerMs: 0,
        };
    } else {
      updates = parsed.durationMs > 0
        ? {
          suspect: true,
          criminal: false,
          criminalTimerMs: parsed.durationMs,
        }
        : {
          suspect: false,
          criminal: false,
          criminalTimerMs: 0,
        };
    }
  } else {
    return handledResult(chatHub, session, options, usage);
  }

  const result = crimewatchState.setCharacterCrimewatchDebugState(
    session.characterID,
    updates,
    {
      now,
      systemID: resolveSessionSolarSystemID(session),
      scene,
      offenderEntity,
    },
  );
  if (!result.success) {
    return handledResult(
      chatHub,
      session,
      options,
      `Crimewatch update failed: ${result.errorMsg || "UNKNOWN_ERROR"}.`,
    );
  }

  synchronizeCrimewatchSessionState(session, scene, now);
  return handledResult(
    chatHub,
    session,
    options,
    `Crimewatch updated. ${buildCrimewatchStatusMessage(session)}`,
  );
}

function handleNaughtyCommand(session, argumentText, chatHub, options) {
  if (!isSpaceSessionReady(session)) {
    return handledResult(
      chatHub,
      session,
      options,
      "You must be in space before using /naughty.",
    );
  }

  if (String(argumentText || "").trim()) {
    return handledResult(
      chatHub,
      session,
      options,
      "Usage: /naughty",
    );
  }

  const scene = spaceRuntime.getSceneForSession(session);
  const offenderEntity = resolveSessionShipEntity(session);
  if (!scene || !offenderEntity) {
    return handledResult(
      chatHub,
      session,
      options,
      "Active ship not found in space.",
    );
  }

  const now = scene.getCurrentSimTimeMs();
  const result = crimewatchState.triggerHighSecCriminalOffense(
    scene,
    offenderEntity,
    {
      now,
      reason: "NAUGHTY_COMMAND",
    },
  );
  if (!result.success) {
    return handledResult(
      chatHub,
      session,
      options,
      `Crimewatch update failed: ${result.errorMsg || "UNKNOWN_ERROR"}.`,
    );
  }

  synchronizeCrimewatchSessionState(session, scene, now);
  if (!result.data || result.data.applied !== true) {
    const reason = String(result.data && result.data.reason || "").trim().toUpperCase();
    const message =
      reason === "NOT_HIGHSEC"
        ? "You are not in a high-security solar system, so /naughty only refreshed the local combat timers and did not schedule CONCORD."
        : "Crimewatch did not create a criminal response.";
    return handledResult(
      chatHub,
      session,
      options,
      `${message} ${buildCrimewatchStatusMessage(session)}`,
    );
  }

  const responseDueMs = Math.max(
    0,
    Number(result.data.concordResponseDueAtMs || 0) - now,
  );
  const securityPenalty = result.data.securityStatusPenalty || null;
  const securitySuffix =
    securityPenalty && securityPenalty.applied === true
      ? ` Security status is now ${Number(securityPenalty.nextSecurityStatus || 0).toFixed(2)}.`
      : "";
  return handledResult(
    chatHub,
    session,
    options,
    `Crimewatch offense simulated. CONCORD ${responseDueMs > 0 ? `will respond in about ${formatDurationBriefMs(responseDueMs)}` : "response is active now"}. ${buildCrimewatchStatusMessage(session)}${securitySuffix}`,
  );
}

function handleSecurityStatusCommand(session, argumentText, chatHub, options) {
  if (!session || !session.characterID) {
    return handledResult(
      chatHub,
      session,
      options,
      "Select a character before using /secstatus.",
    );
  }

  const trimmed = String(argumentText || "").trim();
  const currentSecurityStatus = crimewatchState.getCharacterSecurityStatus(
    session.characterID,
    0,
  );
  if (!trimmed) {
    return handledResult(
      chatHub,
      session,
      options,
      `Security status is ${currentSecurityStatus.toFixed(2)}. Use /secstatus <value> to set it (${crimewatchState.SECURITY_STATUS_MIN.toFixed(0)} to ${crimewatchState.SECURITY_STATUS_MAX.toFixed(0)}).`,
    );
  }

  const requestedSecurityStatus = Number(trimmed);
  if (!Number.isFinite(requestedSecurityStatus)) {
    return handledResult(
      chatHub,
      session,
      options,
      "Usage: /secstatus [status]",
    );
  }

  const scene = isSpaceSessionReady(session)
    ? spaceRuntime.getSceneForSession(session)
    : null;
  const entity = scene ? resolveSessionShipEntity(session) : null;
  const now = scene ? scene.getCurrentSimTimeMs() : Date.now();
  const result = crimewatchState.setCharacterSecurityStatus(
    session.characterID,
    requestedSecurityStatus,
    {
      now,
      scene,
      entity,
      session,
    },
  );
  if (!result.success) {
    return handledResult(
      chatHub,
      session,
      options,
      `Security status update failed: ${result.errorMsg || "UNKNOWN_ERROR"}.`,
    );
  }

  return handledResult(
    chatHub,
    session,
    options,
    `Security status set to ${result.data.securityStatus.toFixed(2)} (requested ${requestedSecurityStatus.toFixed(2)}; clamped to ${crimewatchState.SECURITY_STATUS_MIN.toFixed(0)} to ${crimewatchState.SECURITY_STATUS_MAX.toFixed(0)}).`,
  );
}

module.exports = {
  handleCrimewatchCommand,
  handleNaughtyCommand,
  handleSecurityStatusCommand,
};
