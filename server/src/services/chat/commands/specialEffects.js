"use strict";

// Special effect chat command: /effect, which lists the playable effects, plays one of them on
// the caller's ship in space, or stops the ones that are running.

const path = require("path");

const {
  buildEffectListText,
  stopAllPlayableEffects,
  playPlayableEffect,
} = require("../specialFxRegistry");
const {
  isDockedSession,
} = require(path.join(__dirname, "../../structure/structureLocation"));
const {
  handledResult,
} = require(path.join(__dirname, "./commandReplies"));
const {
  normalizeCommandName,
} = require(path.join(__dirname, "./commandArguments"));
const {
  formatDistanceMeters,
} = require(path.join(__dirname, "./commandFormatting"));

function handleEffectCommand(session, argumentText, chatHub, options) {
  if (!session || !session.characterID) {
    return handledResult(
      chatHub,
      session,
      options,
      "Select a character before using /effect.",
    );
  }

  if (!session._space || isDockedSession(session)) {
    return handledResult(
      chatHub,
      session,
      options,
      "You must be in space to use /effect.",
    );
  }

  const trimmed = String(argumentText || "").trim();
  if (!trimmed || trimmed === "list" || trimmed === "help" || trimmed === "?") {
    return handledResult(chatHub, session, options, buildEffectListText());
  }

  const parts = trimmed.split(/\s+/);
  const verb = normalizeCommandName(parts[0]);
  const stop = verb === "stop" || verb === "off";
  const effectName = stop ? parts.slice(1).join(" ").trim() : trimmed;
  if (stop && !effectName) {
    const stopResult = stopAllPlayableEffects(session);
    if (!stopResult.success) {
      return handledResult(
        chatHub,
        session,
        options,
        "Effect stop failed.",
      );
    }
    return handledResult(
      chatHub,
      session,
      options,
      "Stopped all known self FX on your ship.",
    );
  }

  if (!effectName) {
    return handledResult(
      chatHub,
      session,
      options,
      "Usage: /effect <name>, /effect stop, or /effect stop <name>",
    );
  }

  const result = playPlayableEffect(session, effectName, { stop });
  if (!result.success) {
    if (result.errorMsg === "EFFECT_NOT_FOUND") {
      return handledResult(
        chatHub,
        session,
        options,
        `Unknown effect: ${effectName}. ${buildEffectListText()}`,
      );
    }
    if (result.errorMsg === "DESTINY_NOT_READY") {
      return handledResult(
        chatHub,
        session,
        options,
        "Space scene is not ready for FX yet. Try again in a moment.",
      );
    }
    if (result.errorMsg === "DEBUG_TEST_TARGET_NO_STATION") {
      return handledResult(
        chatHub,
        session,
        options,
        "That debug/test effect needs a nearby station target, but there is no station entity available in the current scene.",
      );
    }
    if (result.errorMsg === "DEBUG_TEST_TARGET_OUT_OF_RANGE") {
      const maxRangeText = formatDistanceMeters(
        result.data && result.data.maxRangeMeters,
      );
      const nearestDistanceText = formatDistanceMeters(
        result.data && result.data.nearestDistanceMeters,
      );
      const targetName =
        (result.data && result.data.targetName) || "the nearest station";
      return handledResult(
        chatHub,
        session,
        options,
        `That debug/test effect needs a nearby station target within ${maxRangeText}. The nearest station is ${targetName} at ${nearestDistanceText}.`,
      );
    }
    return handledResult(
      chatHub,
      session,
      options,
      "Effect playback failed.",
    );
  }

  const effect = result.data.effect;
  const autoTarget = result.data.autoTarget;
  if (effect.debugOnly && autoTarget) {
    return handledResult(
      chatHub,
      session,
      options,
      `${stop ? "Stopped" : "Played"} debug/test ${effect.key} (${effect.guid}) on your ship using nearby station ${autoTarget.targetName} (${autoTarget.targetID}) at ${formatDistanceMeters(autoTarget.distanceMeters)}.`,
    );
  }
  if (effect.debugOnly) {
    return handledResult(
      chatHub,
      session,
      options,
      `${stop ? "Stopped" : "Played"} debug/test ${effect.key} (${effect.guid}) on your ship.`,
    );
  }
  return handledResult(
    chatHub,
    session,
    options,
    `${stop ? "Stopped" : "Played"} ${effect.key} (${effect.guid}) on your ship.`,
  );
}

module.exports = {
  handleEffectCommand,
};
