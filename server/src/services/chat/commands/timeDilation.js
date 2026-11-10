"use strict";

// Time dilation and system loading chat commands: /tidi (read or set the time dilation factor,
// 0.1 to 1.0), /loadsys (prepare the systems on the other side of the caller's stargates) and
// /loadallsys (prepare every solar system), with the solar system labels.

const path = require("path");

const worldData = require("../../../space/worldData");
const spaceRuntime = require("../../../space/runtime");
const {
  scheduleAdvanceNoticeTimeDilationForSystems,
  TIDI_ADVANCE_NOTICE_MS,
} = require("../../../utils/synchronizedTimeDilation");
const tidiAutoscaler = require("../../../utils/tidiAutoscaler");
const {
  handledResult,
} = require(path.join(__dirname, "./commandReplies"));
const {
  normalizePositiveInteger,
} = require(path.join(__dirname, "./commandArguments"));

function getActiveSolarSystemID(session) {
  return normalizePositiveInteger(
    session &&
      (
        (session._space && session._space.systemID) ||
        session.solarsystemid2 ||
        session.solarsystemid
      ),
  );
}

function formatSolarSystemLabel(systemID) {
  const system = worldData.getSolarSystemByID(systemID);
  return system && system.solarSystemName
    ? `${system.solarSystemName}(${systemID})`
    : String(systemID || 0);
}

function formatSolarSystemList(systemIDs) {
  const uniqueIDs = [...new Set((Array.isArray(systemIDs) ? systemIDs : []).filter(Boolean))];
  return uniqueIDs.length > 0
    ? uniqueIDs.map((systemID) => formatSolarSystemLabel(systemID)).join(", ")
    : "none";
}

function formatTimeDilationFactor(value) {
  const factor = Number.isFinite(Number(value)) ? Number(value) : 1;
  return `${factor.toFixed(3)} (${Math.round(factor * 1000) / 10}%)`;
}

function handleLoadSystemCommand(session, chatHub, options) {
  if (!session || !session.characterID) {
    return handledResult(
      chatHub,
      session,
      options,
      "Select a character before loading stargate destination systems.",
    );
  }

  const currentSystemID = getActiveSolarSystemID(session);
  if (!currentSystemID) {
    return handledResult(
      chatHub,
      session,
      options,
      "Current solar system could not be resolved.",
    );
  }

  const stargates = worldData.getStargatesForSystem(currentSystemID);
  if (stargates.length === 0) {
    return handledResult(
      chatHub,
      session,
      options,
      `No stargates found in ${formatSolarSystemLabel(currentSystemID)}.`,
    );
  }

  const destinationSystemIDs = [...new Set(
    stargates
      .map((stargate) => normalizePositiveInteger(stargate.destinationSolarSystemID))
      .filter((systemID) => systemID && systemID !== currentSystemID),
  )];
  if (destinationSystemIDs.length === 0) {
    return handledResult(
      chatHub,
      session,
      options,
      `No valid stargate destination systems found in ${formatSolarSystemLabel(currentSystemID)}.`,
    );
  }

  const alreadyLoaded = destinationSystemIDs.filter((systemID) =>
    spaceRuntime.isSolarSystemSceneLoaded(systemID),
  );
  spaceRuntime.ensureScene(currentSystemID, {
    refreshStargates: false,
    broadcastStargateChanges: false,
  });
  const activationChanges = spaceRuntime.preloadSolarSystems(destinationSystemIDs, {
    broadcast: true,
  });
  const loadedNow = destinationSystemIDs.filter((systemID) =>
    spaceRuntime.isSolarSystemSceneLoaded(systemID),
  );
  const newlyLoaded = loadedNow.filter(
    (systemID) => !alreadyLoaded.includes(systemID),
  );
  const failed = destinationSystemIDs.filter(
    (systemID) => !loadedNow.includes(systemID),
  );

  return handledResult(
    chatHub,
    session,
    options,
    [
      `/loadsys ${formatSolarSystemLabel(currentSystemID)}:`,
      `loaded ${newlyLoaded.length}/${destinationSystemIDs.length} destination systems`,
      `(${formatSolarSystemList(newlyLoaded)})`,
      alreadyLoaded.length > 0
        ? `already loaded: ${formatSolarSystemList(alreadyLoaded)}`
        : null,
      failed.length > 0
        ? `failed: ${formatSolarSystemList(failed)}`
        : null,
      `gate updates emitted: ${activationChanges.length}.`,
    ].filter(Boolean).join(" "),
  );
}

function handleLoadAllSystemsCommand(session, chatHub, options) {
  if (!session || !session.characterID) {
    return handledResult(
      chatHub,
      session,
      options,
      "Select a character before loading all solar systems.",
    );
  }

  const solarSystemIDs = worldData.getSolarSystems()
    .map((system) => normalizePositiveInteger(system && system.solarSystemID))
    .filter(Boolean);
  if (solarSystemIDs.length === 0) {
    return handledResult(
      chatHub,
      session,
      options,
      "No solar systems are available to preload.",
    );
  }

  const alreadyLoaded = solarSystemIDs.filter((systemID) =>
    spaceRuntime.isSolarSystemSceneLoaded(systemID),
  );
  const activationChanges = spaceRuntime.preloadSolarSystems(solarSystemIDs, {
    broadcast: true,
  });
  const loadedNow = solarSystemIDs.filter((systemID) =>
    spaceRuntime.isSolarSystemSceneLoaded(systemID),
  );
  const newlyLoaded = loadedNow.filter(
    (systemID) => !alreadyLoaded.includes(systemID),
  );
  const failed = solarSystemIDs.filter(
    (systemID) => !loadedNow.includes(systemID),
  );

  return handledResult(
    chatHub,
    session,
    options,
    [
      "/loadallsys:",
      `loaded ${loadedNow.length}/${solarSystemIDs.length} solar systems.`,
      `newly loaded: ${newlyLoaded.length}.`,
      `already loaded: ${alreadyLoaded.length}.`,
      failed.length > 0 ? `failed: ${failed.length}.` : null,
      `gate updates emitted: ${activationChanges.length}.`,
    ].filter(Boolean).join(" "),
  );
}

// /tidi <factor>: sets the solar system's time dilation on the server and sends
// OnSetTimeDilation to every client in the system. The handler the login signedFunc installs
// (handshake.js) sets blue.os.maxSimDilation, minSimDilation and dilationOverloadThreshold, so
// blue.dll's own tick loop moves desiredSimDilation, which the stock TiDi HUD reads. A factor
// below 1.0 locks dilation there (threshold 0 forces overload); 1.0 sends max 1.0, min 1.0 and
// threshold 100000000.
function handleTimeDilationCommand(session, argumentText, chatHub, options) {
  const currentSystemID = getActiveSolarSystemID(session);
  if (!currentSystemID) {
    return handledResult(
      chatHub,
      session,
      options,
      "Current solar system could not be resolved.",
    );
  }

  const systemLabel = formatSolarSystemLabel(currentSystemID);
  const trimmedArgument = String(argumentText || "").trim();

  // No argument = show current state
  if (!trimmedArgument) {
    const snapshot = spaceRuntime.getSceneTimeSnapshot(currentSystemID);
    if (!snapshot) {
      return handledResult(
        chatHub,
        session,
        options,
        `/tidi ${systemLabel}: scene not available.`,
      );
    }

    return handledResult(
      chatHub,
      session,
      options,
      [
        `/tidi ${systemLabel}:`,
        `factor=${formatTimeDilationFactor(snapshot.timeDilation)}`,
        `mode=${tidiAutoscaler.getManualOverride(currentSystemID) ? "manual-override" : "autoscale"}`,
        `simTimeMs=${Math.round(Number(snapshot.simTimeMs) || 0)}`,
        `stamp=${Number(snapshot.destinyStamp) || 0}.`,
      ].join(" "),
    );
  }

  if (
    trimmedArgument.toLowerCase() === "auto" ||
    trimmedArgument.toLowerCase() === "autoscale"
  ) {
    const cleared = tidiAutoscaler.clearManualOverride(currentSystemID);
    const resumeFactor = tidiAutoscaler.getCurrentFactor();
    scheduleAdvanceNoticeTimeDilationForSystems(
      [currentSystemID],
      resumeFactor,
      { delayMs: TIDI_ADVANCE_NOTICE_MS },
    );
    return handledResult(
      chatHub,
      session,
      options,
      [
        `/tidi ${systemLabel}:`,
        cleared
          ? "manual override cleared."
          : "no manual override was active.",
        `System will rejoin autoscaling in ${TIDI_ADVANCE_NOTICE_MS / 1000}s at ${formatTimeDilationFactor(resumeFactor)}.`,
      ].join(" "),
    );
  }

  const requestedFactor = Number(trimmedArgument);
  if (!Number.isFinite(requestedFactor)) {
    return handledResult(
      chatHub,
      session,
      options,
      "Usage: /tidi <0.1-1.0|auto>",
    );
  }

  const normalizedFactor = Math.min(1, Math.max(0.1, requestedFactor));
  tidiAutoscaler.setManualOverride(currentSystemID, normalizedFactor);

  // Send clients the advance notice now and apply the server's factor after the lead window, so
  // the DoSimClockRebase lands close to blue.dll's own sync-base switch.
  scheduleAdvanceNoticeTimeDilationForSystems(
    [currentSystemID],
    normalizedFactor,
    { delayMs: TIDI_ADVANCE_NOTICE_MS },
  );

  const clampedMessage =
    normalizedFactor !== requestedFactor
      ? ` Requested ${requestedFactor} was clamped to ${formatTimeDilationFactor(normalizedFactor)}.`
      : "";
  const isDisabling = normalizedFactor >= 1.0;
  return handledResult(
    chatHub,
    session,
    options,
    [
      `/tidi ${systemLabel}:`,
      isDisabling ? "TiDi will set to full speed" : `TiDi will set to ${formatTimeDilationFactor(normalizedFactor)}`,
      "Manual override enabled for this solar system.",
      `in ${TIDI_ADVANCE_NOTICE_MS / 1000}s (synchronized).`,
      clampedMessage.trim() || null,
    ].filter(Boolean).join(" "),
  );
}

module.exports = {
  handleLoadSystemCommand,
  handleLoadAllSystemsCommand,
  handleTimeDilationCommand,
};
