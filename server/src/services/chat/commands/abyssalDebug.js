"use strict";

// Abyssal debug chat commands, all staff only: /abyssalstatus (read the current run, send an
// allowlisted FX or scenery probe, or print its help), /abyssaldebug (turn suppressor
// diagnostics on or off), /abyssallayout (list, show, force or clear the next layout) and
// /abyssalrescue (move a stuck ship back to its source system and clean the broken run), with
// the two help texts only they print.

const path = require("path");

const {
  listAbyssalCalmDarkProbeEffectKeys,
} = require("../specialFxRegistry");
const AbyssalMgrService = require("../../../abyssal").chatIntegration;
const {
  handledResult,
} = require(path.join(__dirname, "./commandReplies"));
const {
  normalizeCommandName,
} = require(path.join(__dirname, "./commandArguments"));
const {
  hasStaffDebugRole,
} = require(path.join(__dirname, "./commandAccess"));

const ABYSSAL_STATUS_HELP_TEXT = [
  "/abyssalstatus [status|weather|fx <effectKey>|scenery <candidateKey|list [category]|next|prev> [near|mid|far]|help] (staff/admin only)",
  "status and weather are read-only snapshot modes for the current Abyssal run. weather is kept as a compatibility alias for the same report. fx sends one allowlisted self-anchored OnSpecialFX probe to your current ship. scenery list prints the conservative Calm Dark environmental probe catalogue without spawning anything. scenery probes spawn one allowlisted environment_visual candidate in Calm Dark room 1 and replace the previous probe if present.",
  "Expected fields include active run state, configured and persisted scene mode, configuration source, current and attached scene keys, mode match, legacy compatibility state, filament/definition, tier, weather, selected layout IDs, room, timer, timeout mode, transition FX state, Calm Dark room-entry FX state, room NPC profile, reward profile, scenery status, and scanner restriction state.",
  "Manual checks: Tranquil Dark activation, isolated scene-key attachment, room 1/2/3 progression, one Bioadaptive Cache per room, transfer/final-exit blocking, relog recovery, final exit near origin trace, lethal timeout, and cleanup.",
  `Allowlisted Calm Dark FX probe keys: ${listAbyssalCalmDarkProbeEffectKeys().join(", ")}.`,
  `Allowlisted scenery probe keys: ${AbyssalMgrService.listAbyssalSceneryProbeCandidateKeys().join(", ")}. Categories: ${AbyssalMgrService.listAbyssalSceneryProbeCatalogueCategoryKeys().join(", ")}. Presets: ${AbyssalMgrService.listAbyssalSceneryProbePresetKeys().join(", ")}.`,
  'Abyssal runs always use authoritative run-scoped isolated scenes; persisted legacy same-system state remains recognizable only for safe recovery and cleanup. /abyssaldebug suppressor on|off controls bounded suppressor diagnostics for your current run. Transition FX and evidence-backed captured-layout scenery are server-owned behavior. Experimental room-entry FX selection and non-authoritative scenery are not exposed through production configuration. The lethal run deadline, entrance lifetime, return protection, transition lifecycle, and supported content definitions are server-owned policy and cannot be changed through environment variables.',
  "Current limitations: isolated run scenes are mandatory for new runs. Loot, NPC variety, side-cache variety, and some environment presentation remain conservative. Shared-run lifecycle policy is EveJS-authored rather than captured-retail multiplayer evidence.",
].join("\n");
const ABYSSAL_RESCUE_HELP_TEXT = [
  "/abyssalrescue (staff/admin only)",
  "Moves your active Abyssal ship back to the recorded source system and cleans the broken run. Use only when isolated-scene recovery failed or the client is stuck at an Abyssal host location.",
].join("\n");

function handleAbyssalDebugCommand(session, argumentText, chatHub, options) {
  if (!hasStaffDebugRole(session)) {
    return handledResult(
      chatHub,
      session,
      options,
      "ABYSSALDEBUG requires a staff/admin role.",
    );
  }

  const tokens = String(argumentText || "").trim().split(/\s+/).filter(Boolean);
  const subject = normalizeCommandName(tokens[0] || "");
  const action = normalizeCommandName(tokens[1] || "");
  const usage = "Usage: /abyssaldebug suppressor <on|off|status>";
  if (
    subject !== "suppressor" ||
    !["on", "off", "status"].includes(action) ||
    tokens.length !== 2
  ) {
    return handledResult(chatHub, session, options, usage);
  }

  const result = action === "status"
    ? AbyssalMgrService.getAbyssalSuppressorDebugForSession(session)
    : AbyssalMgrService.setAbyssalSuppressorDebugForSession(session, action === "on");
  if (!result || result.success !== true || !result.data) {
    const errorMsg = result && result.errorMsg || "STATUS_UNAVAILABLE";
    return handledResult(
      chatHub,
      session,
      options,
      errorMsg === "NOT_IN_ACTIVE_ABYSSAL_RUN"
        ? "Suppressor debug requires your character to be in an active Abyssal run."
        : `Suppressor debug unavailable (${errorMsg}).`,
    );
  }

  const snapshot = result.data;
  const lastPulse = snapshot.lastPulse;
  return handledResult(
    chatHub,
    session,
    options,
    [
      `Suppressor debug: ${snapshot.enabled === true ? "ON" : "OFF"}`,
      `run=${Number(snapshot.runID) || 0} source=${String(snapshot.source || "default-off")}`,
      lastPulse
        ? `lastPulse=${Number(lastPulse.pulseNumber) || 0} rawCandidates=${Number(lastPulse.rawCandidates) || 0} eligible=${Number(lastPulse.eligible) || 0} insideRange=${Number(lastPulse.insideRange) || 0} selected=${Number(lastPulse.selected) || 0} affected=${Number(lastPulse.affected) || 0} removedMissiles=${Number(lastPulse.removedMissiles) || 0} damaged=${Number(lastPulse.damaged) || 0} failed=${Number(lastPulse.failed) || 0}`
        : "lastPulse=none",
      `recentMissileActions=${Array.isArray(snapshot.missileActions) ? snapshot.missileActions.length : 0}`,
      `recentTargetActions=${Array.isArray(snapshot.targetActions) ? snapshot.targetActions.length : 0}`,
    ].join("<br>"),
  );
}

function handleAbyssalLayoutCommand(session, argumentText, chatHub, options) {
  if (!hasStaffDebugRole(session)) {
    return handledResult(
      chatHub,
      session,
      options,
      "ABYSSALLAYOUT requires a staff/admin role.",
    );
  }
  const tokens = String(argumentText || "").trim().split(/\s+/).filter(Boolean);
  const action = normalizeCommandName(tokens[0] || "status") || "status";
  const usage = "Usage: /abyssallayout <list|status|next <layoutID>|clear>";
  if (action === "list" && tokens.length === 1) {
    const result = AbyssalMgrService.listT0DarkLayoutsForStaff();
    const layouts = result && result.success === true && Array.isArray(result.data) ? result.data : [];
    return handledResult(
      chatHub,
      session,
      options,
      [
        `Enabled Tier 0 Dark layouts: ${layouts.length}`,
        ...layouts.map((layout) =>
          `${layout.layoutSetID} tier=${layout.tier} weather=${layout.weather} ` +
            `filamentTypeIDs=${layout.filamentTypeIDs.join(",")} ` +
            `evidence=${layout.evidenceSource} enabled=${layout.enabled === true} ` +
            `weight=${layout.selectionWeight} ` +
            `rooms=${Object.values(layout.roomLayoutIDs || {}).join(",")}`
        ),
      ].join("<br>"),
    );
  }
  if (action === "status" && tokens.length === 1) {
    const result = AbyssalMgrService.getT0DarkLayoutStatusForSession(session);
    const data = result && result.data || {};
    const pending = data.pendingOverride || null;
    const active = data.activeSelection || null;
    const activeBaseRooms = data.activeBaseRoomSelection || null;
    return handledResult(
      chatHub,
      session,
      options,
      [
        `Pending next-run layout: ${pending && pending.layoutSetID || "none"}`,
        `Active run: ${Number(data.activeRunID) || 0}`,
        `Active layout set: ${active && active.selectedLayoutSetID || "none"}`,
        `Active selection source: ${active && active.layoutSelectionSource || "none"}`,
        `Active base room layouts: ${activeBaseRooms ? Object.values(activeBaseRooms.selectedBaseRoomLayoutIDs || {}).join(",") : "none"}`,
        `Active Tier 0 Dark overlay layouts: ${active ? Object.values(active.selectedRoomLayoutIDs || {}).join(",") : "none"}`,
      ].join("<br>"),
    );
  }
  if (action === "next" && tokens.length === 2) {
    const result = AbyssalMgrService.setNextT0DarkLayoutForSession(session, tokens[1]);
    if (!result || result.success !== true) {
      return handledResult(
        chatHub,
        session,
        options,
        `Layout override rejected (${result && result.errorMsg || "UNKNOWN"}).`,
      );
    }
    return handledResult(
      chatHub,
      session,
      options,
      `Next compatible Tier 0 Dark run will use ${result.data.layoutSetID}. The override is character-scoped and consumed after run creation.`,
    );
  }
  if (action === "clear" && tokens.length === 1) {
    const result = AbyssalMgrService.clearNextT0DarkLayoutForSession(session);
    return handledResult(
      chatHub,
      session,
      options,
      result && result.success === true
        ? `Pending layout override cleared=${result.data.cleared === true}.`
        : `Layout override clear failed (${result && result.errorMsg || "UNKNOWN"}).`,
    );
  }
  return handledResult(chatHub, session, options, usage);
}

function handleAbyssalStatusCommand(session, argumentText, chatHub, options) {
  if (!hasStaffDebugRole(session)) {
    return handledResult(
      chatHub,
      session,
      options,
      "ABYSSALSTATUS requires a staff/admin role.",
    );
  }

  const tokens = String(argumentText || "").trim().split(/\s+/).filter(Boolean);
  const mode = normalizeCommandName(tokens[0] || "status") || "status";
  if (mode === "help") {
    return handledResult(
      chatHub,
      session,
      options,
      `${ABYSSAL_STATUS_HELP_TEXT}\n${ABYSSAL_RESCUE_HELP_TEXT}`,
    );
  }
  if (mode === "fx") {
    const effectKey = tokens.slice(1).join(" ").trim();
    if (!effectKey) {
      return handledResult(
        chatHub,
        session,
        options,
        `Usage: /abyssalstatus fx <effectKey>. Allowlisted keys: ${listAbyssalCalmDarkProbeEffectKeys().join(", ")}.`,
      );
    }
    const result = AbyssalMgrService.playAbyssalCalmDarkFxProbeForSession(
      session,
      effectKey,
    );
    if (!result.success) {
      if (result.errorMsg === "FX_NOT_ALLOWLISTED") {
        return handledResult(
          chatHub,
          session,
          options,
          `Unknown Calm Dark FX probe key: ${effectKey}. Allowlisted keys: ${listAbyssalCalmDarkProbeEffectKeys().join(", ")}.`,
        );
      }
      if (result.errorMsg === "NOT_IN_SPACE") {
        return handledResult(
          chatHub,
          session,
          options,
          "You must be in space to use /abyssalstatus fx.",
        );
      }
      if (
        result.errorMsg === "SHIP_NOT_FOUND" ||
        result.errorMsg === "SCENE_NOT_FOUND"
      ) {
        return handledResult(
          chatHub,
          session,
          options,
          "Abyssal FX probe requires an active ship entity in space.",
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
      return handledResult(
        chatHub,
        session,
        options,
        `Abyssal FX probe failed: ${result.errorMsg}.`,
      );
    }
    return handledResult(
      chatHub,
      session,
      options,
      `Abyssal FX probe sent ${result.data.effect.key} (${result.data.guid}) to ship ${Number(result.data.sourceShipID) || 0}. sourceEntity=${Number(result.data.sourceShipID) || 0} sendStatus=${result.data.sendStatus}.`,
    );
  }
  if (mode === "scenery") {
    const candidateKey = normalizeCommandName(tokens[1] || "");
    const presetKey = normalizeCommandName(tokens[2] || "near");
    const sceneryUsage =
      `Usage: /abyssalstatus scenery <candidateKey|list [category]|next|prev> [near|mid|far]. ` +
      `Allowlisted keys: ${AbyssalMgrService.listAbyssalSceneryProbeCandidateKeys().join(", ")}. ` +
      `Categories: ${AbyssalMgrService.listAbyssalSceneryProbeCatalogueCategoryKeys().join(", ")}.`;
    if (!candidateKey || tokens.length > 3) {
      return handledResult(chatHub, session, options, sceneryUsage);
    }
    if (candidateKey === "list") {
      const categoryKey = normalizeCommandName(tokens[2] || "all");
      const result = AbyssalMgrService.listAbyssalSceneryProbeCatalogue(categoryKey);
      if (!result.success) {
        return handledResult(
          chatHub,
          session,
          options,
          `Unknown Abyssal scenery list category: ${categoryKey}. Allowlisted categories: ${AbyssalMgrService.listAbyssalSceneryProbeCatalogueCategoryKeys().join(", ")}.`,
        );
      }
      const entries = Array.isArray(result.data && result.data.entries) ? result.data.entries : [];
      const limit = normalizeCommandName(categoryKey) === "all" ? 12 : 16;
      const visibleEntries = entries.slice(0, limit);
      const summary = `Abyssal scenery catalogue ${String(result.data && result.data.categoryLabel || "all")}: showing ${visibleEntries.length}/${Number(result.data && result.data.totalCount) || 0}.`;
      const lines = visibleEntries.map((entry) =>
        `${entry.key} typeID=${Number(entry.typeID) || 0} typeName="${String(entry.typeName || "")}" ` +
        `catalogueCategory=${String(entry.categoryKey || "other_environment")} typeCategory=${Number(entry.categoryID) || 0}:${String(entry.categoryName || "unknown")} ` +
        `group=${Number(entry.groupID) || 0}:${String(entry.groupName || "unknown")} ` +
        `radius=${Number(entry.radiusMeters) || 0} radiusOverride=${Number(entry.radiusOverrideMeters) || 0} ` +
        `graphicID=${Number(entry.graphicID) || 0} notes="${String(entry.notes || "none")}"`,
      );
      return handledResult(
        chatHub,
        session,
        options,
        [summary, ...lines].join("<br>"),
      );
    }
    let result = null;
    if (candidateKey === "next" || candidateKey === "prev") {
      result = AbyssalMgrService.stepAbyssalSceneryProbeForSession(
        session,
        candidateKey,
        presetKey,
      );
    } else {
      result = AbyssalMgrService.spawnAbyssalSceneryProbeForSession(
        session,
        candidateKey,
        presetKey,
      );
    }
    if (!result.success) {
      if (result.errorMsg === "CANDIDATE_NOT_ALLOWLISTED") {
        return handledResult(
          chatHub,
          session,
          options,
          `Unknown Abyssal scenery probe key: ${candidateKey}. Allowlisted keys: ${AbyssalMgrService.listAbyssalSceneryProbeCandidateKeys().join(", ")}.`,
        );
      }
      if (result.errorMsg === "STEP_NOT_ALLOWLISTED") {
        return handledResult(chatHub, session, options, sceneryUsage);
      }
      if (result.errorMsg === "PRESET_NOT_ALLOWLISTED") {
        return handledResult(
          chatHub,
          session,
          options,
          `Unknown Abyssal scenery probe preset: ${presetKey}. Allowlisted presets: ${AbyssalMgrService.listAbyssalSceneryProbePresetKeys().join(", ")}.`,
        );
      }
      if (result.errorMsg === "NOT_IN_ACTIVE_RUN") {
        return handledResult(
          chatHub,
          session,
          options,
          "Abyssal scenery probes only work inside an active Abyssal run.",
        );
      }
      if (result.errorMsg === "ENV_DISABLED") {
        return handledResult(
          chatHub,
          session,
          options,
          "Experimental Abyssal scenery probes are not exposed through production configuration.",
        );
      }
      if (
        result.errorMsg === "PROFILE_NOT_APPLICABLE" ||
        result.errorMsg === "ROOM_NOT_APPLICABLE"
      ) {
        return handledResult(
          chatHub,
          session,
          options,
          "Abyssal scenery probes currently only work in supported Calm room 1 pockets.",
        );
      }
      if (result.errorMsg === "TYPE_UNRESOLVED") {
        return handledResult(
          chatHub,
          session,
          options,
          `Abyssal scenery probe type could not be resolved locally for candidate ${candidateKey}.`,
        );
      }
      return handledResult(
        chatHub,
        session,
        options,
        `Abyssal scenery probe failed: ${result.errorMsg}.`,
      );
    }
    if (candidateKey === "next" || candidateKey === "prev") {
      return handledResult(
        chatHub,
        session,
        options,
        `Abyssal scenery probe stepped ${candidateKey} to ${result.data.candidateKey} ${result.data.presetKey}. ` +
          `index=${Number(result.data.catalogueIndex) || 0}/${Number(result.data.catalogueSize) || 0} entityID=${Number(result.data.entityID) || 0} ` +
          `typeID=${Number(result.data.typeID) || 0} typeName="${String(result.data.typeName || "")}" ` +
          `radius=${Number(result.data.radiusMeters) || 0} radiusOverride=${Number(result.data.radiusOverrideMeters) || 0} ` +
          `position=${Number(result.data.position && result.data.position.x) || 0},${Number(result.data.position && result.data.position.y) || 0},${Number(result.data.position && result.data.position.z) || 0} ` +
          `guardsActive=${result.data.guardsActive === true} addBallsSent=${result.data.addBallsSent === true} replacedEntityID=${Number(result.data.replacedEntityID) || 0}.`,
      );
    }
    return handledResult(
      chatHub,
      session,
      options,
      `Abyssal scenery probe spawned ${result.data.candidateKey} ${result.data.presetKey}. ` +
        `entityID=${Number(result.data.entityID) || 0} typeID=${Number(result.data.typeID) || 0} ` +
        `typeName="${String(result.data.typeName || "")}" category=${String(result.data.categoryKey || "other_environment")} ` +
        `radius=${Number(result.data.radiusMeters) || 0} radiusOverride=${Number(result.data.radiusOverrideMeters) || 0} ` +
        `index=${Number(result.data.catalogueIndex) || 0}/${Number(result.data.catalogueSize) || 0} ` +
        `position=${Number(result.data.position && result.data.position.x) || 0},${Number(result.data.position && result.data.position.y) || 0},${Number(result.data.position && result.data.position.z) || 0} ` +
        `guardsActive=${result.data.guardsActive === true} addBallsSent=${result.data.addBallsSent === true} replacedEntityID=${Number(result.data.replacedEntityID) || 0}.`,
    );
  }
  if (mode !== "status" && mode !== "weather") {
    return handledResult(
      chatHub,
      session,
      options,
      "Usage: /abyssalstatus [status|weather|fx <effectKey>|scenery <candidateKey|list [category]|next|prev> [near|mid|far]|help]",
    );
  }

  const report = AbyssalMgrService.buildAbyssalStatusReportForSession(session);
  return handledResult(
    chatHub,
    session,
    options,
    report && report.text
      ? report.text
      : "Abyssal status unavailable (REPORT_BUILD_FAILED)",
  );
}

function handleAbyssalRescueCommand(session, argumentText, chatHub, options) {
  void argumentText;
  if (!hasStaffDebugRole(session)) {
    return handledResult(
      chatHub,
      session,
      options,
      "ABYSSALRESCUE requires a staff/admin role.",
    );
  }
  const shipID = Number(
    session && (session.shipID || session.shipid || session.activeShipID),
  ) || 0;
  const result =
    typeof AbyssalMgrService.rescueAbyssalSession === "function"
      ? AbyssalMgrService.rescueAbyssalSession(session, "manual-rescue")
      : null;
  if (!result || result.rescued !== true) {
    return handledResult(
      chatHub,
      session,
      options,
      `Abyssal rescue failed: ${result && result.reason || "UNKNOWN"}.`,
    );
  }
  return handledResult(
    chatHub,
    session,
    options,
    `Abyssal rescue complete. shipID=${shipID} returnSystem=${Number(result.to) || 0} runFound=${result.runFound === true}.`,
  );
}

module.exports = {
  handleAbyssalDebugCommand,
  handleAbyssalLayoutCommand,
  handleAbyssalStatusCommand,
  handleAbyssalRescueCommand,
};
