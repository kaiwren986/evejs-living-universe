"use strict";

// Signature chat commands: /sigscan (list the signatures in the caller's system) and /sigs (the
// same through the system scanner, which Abyssal Deadspace does not have).

const path = require("path");

const worldData = require("../../../space/worldData");
const ScanMgrService = require(path.join(__dirname, "../../exploration/scanMgrService"));
const signatureRuntime = require(path.join(__dirname, "../../exploration/signatures/signatureRuntime"));
const {
  handledResult,
} = require(path.join(__dirname, "./commandReplies"));
const {
  isConnectedSessionInAbyssalDeadspace,
} = require(path.join(__dirname, "./commandSessionLocation"));

function handleSigscanCommand(session, chatHub, options) {
  if (!session || !session.characterID) {
    return handledResult(
      chatHub,
      session,
      options,
      "Select a character before using /sigscan.",
    );
  }

  const scanMgr = new ScanMgrService();
  const result = scanMgr.resolveAllSystemSignaturesForSession(session, {
    durationMs: 1,
    refreshSignalTracker: false,
  });
  if (!result.success) {
    return handledResult(
      chatHub,
      session,
      options,
      "Could not resolve signatures for the current system.",
    );
  }

  const systemID = Number(result.data && result.data.systemID) || 0;
  const signatureCount = Number(result.data && result.data.signatureCount) || 0;
  const system = worldData.getSolarSystemByID(systemID);
  const systemLabel =
    (system && system.solarSystemName) ||
    (systemID > 0 ? `system ${systemID}` : "the current system");
  return handledResult(
    chatHub,
    session,
    options,
    signatureCount > 0
      ? `Resolved ${signatureCount} signature${signatureCount === 1 ? "" : "s"} to 100% in ${systemLabel}.`
      : `No scannable signatures are currently present in ${systemLabel}.`,
  );
}

function handleSigsCommand(session, chatHub, options) {
  if (!session || !session.characterID) {
    return handledResult(
      chatHub,
      session,
      options,
      "Select a character before using /sigs.",
    );
  }

  if (isConnectedSessionInAbyssalDeadspace(session)) {
    return handledResult(
      chatHub,
      session,
      options,
      "The system scanner is unavailable in Abyssal Deadspace.",
    );
  }

  const systemID = Number(
    (session._space && session._space.systemID) ||
    session.solarsystemid2 ||
    session.solarsystemid ||
    0
  ) || 0;
  if (systemID <= 0) {
    return handledResult(
      chatHub,
      session,
      options,
      "You must be in space to inspect live signatures.",
    );
  }

  const sites = signatureRuntime.buildSystemScannableViews(systemID);
  const system = worldData.getSolarSystemByID(systemID);
  const systemLabel =
    (system && system.solarSystemName) ||
    (systemID > 0 ? `system ${systemID}` : "the current system");
  if (sites.length <= 0) {
    return handledResult(
      chatHub,
      session,
      options,
      `No scannable sites are currently present in ${systemLabel}.`,
    );
  }

  const lines = sites.map((entry) => (
    `${entry.targetID} | ${entry.siteKind} | ${entry.family} | ${entry.label}` +
    `${entry.pairKind ? ` | ${entry.pairKind}` : ""} | site ${entry.siteID}`
  ));
  return handledResult(
    chatHub,
    session,
    options,
    [
      `Scannable sites in ${systemLabel} (${sites.length}):`,
      ...lines,
    ].join("\n"),
  );
}

module.exports = {
  handleSigscanCommand,
  handleSigsCommand,
};
