"use strict";

// Death test chat commands: /suicide (destroy the caller's own ship, with the Abyssal rules
// about who may do that and what happens to a capsule), /deathtest (spawn ships and destroy
// them) and /deathstructure (the same for a structure type), with the authority check and the
// error text only they use. chatCommands.js re-exports three of these through its _testing
// hook, so it requires them back.

const path = require("path");

const log = require("../../../utils/logger");
const {
  getActiveShipRecord,
} = require("../../character/characterState");
const {
  isCapsuleTypeID,
} = require("../../inventory/itemStore");
const {
  resolveShipByName,
  resolveShipByTypeID,
} = require("../shipTypeRegistry");
const {
  destroySessionShip,
  spawnShipDeathTestField,
} = require("../../../space/shipDestruction");
const {
  isAbyssalHostLocationID,
} = require("../../../abyssal").engineSupport.hostLocation;
const spaceRuntime = require("../../../space/runtime");
const AbyssalMgrService = require("../../../abyssal").chatIntegration;
const {
  buildStructureDeathTestUsage,
  parseStructureDeathTestArgs,
  spawnStructureDeathTestField,
} = require(path.join(__dirname, "../../structure/structureDeathTestRuntime"));
const {
  handledResult,
  getFeedbackChannel,
} = require(path.join(__dirname, "./commandReplies"));
const {
  normalizePositiveInteger,
  parseOptionalTypeAndCount,
} = require(path.join(__dirname, "./commandArguments"));
const {
  formatSuggestions,
} = require(path.join(__dirname, "./commandSuggestions"));
const {
  isSpaceSessionReady,
} = require(path.join(__dirname, "./commandSessionLocation"));
const {
  syncInventoryChangesToSession,
} = require(path.join(__dirname, "./commandInventorySync"));

function resolveAbyssalSuicideAuthority(
  session,
  abyssalMgrService = AbyssalMgrService,
) {
  if (!session || typeof session !== "object") {
    return null;
  }

  const characterID = normalizePositiveInteger(
    session.characterID || session.charid || session.characterId,
  );
  const shipID = normalizePositiveInteger(
    session._space && session._space.shipID ||
      session.shipID ||
      session.shipid ||
      session.activeShipID,
  );
  let activeRun = null;
  try {
    activeRun =
      characterID &&
      abyssalMgrService &&
      typeof abyssalMgrService.getActiveAbyssalRunForCharacterID === "function"
        ? abyssalMgrService.getActiveAbyssalRunForCharacterID(characterID)
        : null;
    if (
      !activeRun &&
      shipID &&
      abyssalMgrService &&
      typeof abyssalMgrService.getActiveAbyssalRunForShipID === "function"
    ) {
      activeRun = abyssalMgrService.getActiveAbyssalRunForShipID(shipID);
    }
  } catch (_error) {
    // Exact server-owned scene identity below remains authoritative when the
    // run registry is temporarily unavailable during terminal handling.
    activeRun = null;
  }

  const sceneKind = String(
    session._space && session._space.sceneKind || "",
  ).trim();
  const sceneKey = String(
    session._space && session._space.sceneKey || session.spaceSceneKey || "",
  ).trim();
  const sceneKeyMatch = /^abyssal-run:(\d+)$/.exec(sceneKey);
  const sceneInstanceID = normalizePositiveInteger(
    session._space && session._space.instanceID || session.spaceInstanceID,
  ) || normalizePositiveInteger(sceneKeyMatch && sceneKeyMatch[1]);
  const sessionLocationID = normalizePositiveInteger(
    session._space && session._space.systemID ||
      session.solarsystemid2 ||
      session.solarsystemid ||
      session.locationid,
  );
  const hasAbyssalSceneAuthority = Boolean(
    sceneKind === "abyssal" ||
    sceneKeyMatch ||
    isAbyssalHostLocationID(sessionLocationID),
  );
  if (!activeRun && !hasAbyssalSceneAuthority) {
    return null;
  }

  return {
    activeRun: activeRun || null,
    characterID: characterID || 0,
    shipID: shipID || 0,
    instanceID:
      normalizePositiveInteger(activeRun && activeRun.instanceID) ||
      sceneInstanceID ||
      0,
    reason: activeRun ? "ABYSSAL_ACTIVE_RUN" : "ABYSSAL_SCENE_AUTHORITY",
  };
}

function isSessionShipCapsuleBeforeDestruction(session) {
  const activeShip = session && session.characterID
    ? getActiveShipRecord(session.characterID)
    : null;
  if (activeShip && isCapsuleTypeID(activeShip.typeID)) {
    return true;
  }
  const shipID = normalizePositiveInteger(
    session && session._space && session._space.shipID ||
      session && (session.shipID || session.shipid || session.activeShipID),
  );
  const attachedEntity = shipID
    ? spaceRuntime.getEntity(session, shipID)
    : null;
  return Boolean(attachedEntity && isCapsuleTypeID(attachedEntity.typeID));
}

function handleSuicideCommand(
  session,
  chatHub,
  options,
  dependencies = {},
) {
  if (!isSpaceSessionReady(session)) {
    return handledResult(
      chatHub,
      session,
      options,
      "You must be in space before using /suicide.",
    );
  }

  const abyssalMgrService =
    dependencies.abyssalMgrService || AbyssalMgrService;
  const destroyShip = dependencies.destroySessionShip || destroySessionShip;
  const abyssalAuthority = resolveAbyssalSuicideAuthority(
    session,
    abyssalMgrService,
  );
  const destroyedShipWasCapsule =
    typeof dependencies.isSessionShipCapsuleBeforeDestruction === "function"
      ? dependencies.isSessionShipCapsuleBeforeDestruction(session)
      : isSessionShipCapsuleBeforeDestruction(session);
  const destroyResult = destroyShip(session, {
    sessionChangeReason: "selfdestruct",
    ...(abyssalAuthority
      ? {
          suppressWreck: true,
          destructionReason: "abyssal-self-destruct",
        }
      : {}),
  });
  if (!destroyResult.success || !destroyResult.data) {
    return handledResult(
      chatHub,
      session,
      options,
      destroyResult.errorMsg === "ALREADY_IN_CAPSULE"
        ? "You are already in a capsule."
        : "Ship self-destruction failed.",
    );
  }

  syncInventoryChangesToSession(session, destroyResult.data.wreckChanges || []);
  syncInventoryChangesToSession(session, destroyResult.data.corpseChanges || []);
  if (destroyResult.data.destroyedShipContentChangesSyncedToSession !== true) {
    syncInventoryChangesToSession(session, destroyResult.data.movedChanges || []);
    syncInventoryChangesToSession(session, destroyResult.data.destroyChanges || []);
  }

  let abyssalTerminalResult = null;
  if (
    abyssalAuthority &&
    abyssalMgrService &&
    typeof abyssalMgrService.handleSessionShipDestroyed === "function"
  ) {
    try {
      abyssalTerminalResult = abyssalMgrService.handleSessionShipDestroyed(
        session,
        {
          reason: "abyssal-self-destruct",
          destructionResult: destroyResult,
          destroyedCapsule:
            destroyedShipWasCapsule || Boolean(destroyResult.data.corpse),
        },
      );
    } catch (error) {
      log.warn(
        `[ChatCommands] Abyssal /suicide terminal continuation failed ` +
          `char=${abyssalAuthority.characterID} ship=${abyssalAuthority.shipID} ` +
          `instance=${abyssalAuthority.instanceID} ` +
          `reason=${error && error.message || "UNKNOWN"}`,
      );
    }
  }

  // A destroyed pod leaves a corpse instead of a wreck, and a destroyed hull
  // leaves the pilot in a capsule instead of docked.
  const abyssalTerminalHandlingActive = Boolean(
    abyssalTerminalResult && abyssalTerminalResult.active,
  );
  const debris = abyssalTerminalHandlingActive
    ? null
    : destroyResult.data.wreck || destroyResult.data.corpse || null;
  const survivor = abyssalTerminalHandlingActive
    ? null
    : destroyResult.data.capsule || destroyResult.data.ship || null;
  return handledResult(
    chatHub,
    session,
    options,
    [
      `Self-destructed ship ${destroyResult.data.destroyedShipID}.`,
      debris
        ? `${destroyResult.data.wreck ? "Wreck" : "Corpse"}: ${debris.itemName} (${debris.itemID}).`
        : "No debris left behind.",
      survivor
        ? `${destroyResult.data.capsule ? "Capsule" : "Ship"}: ${survivor.itemName} (${survivor.itemID}).`
        : "",
      abyssalTerminalHandlingActive
        ? "Abyssal run terminal cleanup requested."
        : "",
    ].filter(Boolean).join(" "),
  );
}

function handleDeathTestCommand(session, argumentText, chatHub, options) {
  if (!isSpaceSessionReady(session)) {
    return handledResult(
      chatHub,
      session,
      options,
      "You must be in space before using /deathtest.",
    );
  }

  const parsed = parseOptionalTypeAndCount(argumentText);
  let shipType = null;
  if (parsed.typeName) {
    const lookup = resolveShipByName(parsed.typeName);
    if (!lookup.success || !lookup.match) {
      const message =
        lookup.errorMsg === "SHIP_NOT_FOUND"
          ? `Ship type not found: ${parsed.typeName}.${formatSuggestions(lookup.suggestions)}`
          : `Ship type is ambiguous: ${parsed.typeName}.${formatSuggestions(lookup.suggestions)}`;
      return handledResult(chatHub, session, options, message.trim());
    }
    shipType = lookup.match;
  } else {
    shipType = resolveShipByTypeID(session.shipTypeID || (session._space && session._space.shipTypeID));
    if (!shipType) {
      const activeShip = getActiveShipRecord(session.characterID);
      shipType = activeShip ? resolveShipByTypeID(activeShip.typeID) : null;
    }
  }

  const spawnResult = spawnShipDeathTestField(session, {
    shipType,
    count: parsed.count,
  });
  if (!spawnResult.success || !spawnResult.data) {
    return handledResult(
      chatHub,
      session,
      options,
      "Death-test hull spawning failed.",
    );
  }

  if (spawnResult.data.completionPromise && chatHub) {
    const feedbackChannel = getFeedbackChannel(options);
    spawnResult.data.completionPromise
      .then((result) => {
        if (!result || !session || !session.characterID) {
          return;
        }
        chatHub.sendSystemMessage(
          session,
          `Detonated ${result.destroyed.length}/${result.spawnedCount} ${result.shipType.name} hulls into wrecks.`,
          feedbackChannel,
        );
      })
      .catch((error) => {
        log.warn(`[ChatCommands] /deathtest completion failed: ${error.message}`);
      });
  }

  return handledResult(
    chatHub,
    session,
    options,
    `Spawned ${spawnResult.data.spawned.length} ${spawnResult.data.shipType.name} hulls across 20 km. Detonation in ${(spawnResult.data.delayMs / 1000).toFixed(1)}s sim time.`,
  );
}

function formatStructureDeathTestError(errorMsg, parsed) {
  const token = String(parsed && parsed.typeToken || "").trim();
  if (errorMsg === "STRUCTURE_TYPE_REQUIRED") {
    return buildStructureDeathTestUsage();
  }
  if (errorMsg === "FOB_ALIAS_AMBIGUOUS") {
    return "FOB is ambiguous. Use /deathstructure bloodraiderfob, /deathstructure guristasfob, /deathstructure guristasinsurgencyfob, or /deathstructure angelfob.";
  }
  if (errorMsg === "STRUCTURE_SPAWN_FAILED") {
    return "Structure death-test spawning failed before any structures were created.";
  }
  if (errorMsg === "ANCHOR_ENTITY_NOT_FOUND") {
    return "Structure death-test needs your current ship ball as a spawn anchor.";
  }
  if (errorMsg === "ABYSSAL_DEPLOYMENT_FORBIDDEN") {
    return "Persistent structure death tests are unavailable in Abyssal Deadspace.";
  }
  if (errorMsg === "STRUCTURE_TYPE_NOT_FOUND") {
    return `Structure type not found: ${token || "unknown"}.`;
  }
  if (errorMsg === "ITEM_NOT_FOUND") {
    return `Structure type not found: ${token}.${formatSuggestions(parsed && parsed.suggestions)}`;
  }
  if (errorMsg === "AMBIGUOUS_ITEM_NAME") {
    return `Structure type is ambiguous: ${token}.${formatSuggestions(parsed && parsed.suggestions)}`;
  }
  return `Structure death-test failed: ${errorMsg || "UNKNOWN_ERROR"}.`;
}

function handleStructureDeathTestCommand(session, argumentText, chatHub, options) {
  if (!isSpaceSessionReady(session)) {
    return handledResult(
      chatHub,
      session,
      options,
      "You must be in space before using /deathstructure.",
    );
  }

  const parsed = parseStructureDeathTestArgs(argumentText);
  if (!parsed.typeToken) {
    return handledResult(chatHub, session, options, buildStructureDeathTestUsage());
  }

  const spawnResult = spawnStructureDeathTestField(session, {
    typeToken: parsed.typeToken,
    count: parsed.count,
    delayMs:
      parsed.delaySeconds === null || parsed.delaySeconds === undefined
        ? undefined
        : parsed.delaySeconds * 1000,
  });
  if (!spawnResult.success || !spawnResult.data) {
    return handledResult(
      chatHub,
      session,
      options,
      formatStructureDeathTestError(spawnResult.errorMsg, {
        ...parsed,
        suggestions: spawnResult.suggestions || [],
      }),
    );
  }

  if (spawnResult.data.completionPromise && chatHub) {
    const feedbackChannel = getFeedbackChannel(options);
    spawnResult.data.completionPromise
      .then((result) => {
        if (!result || !session || !session.characterID) {
          return;
        }
        const wreckSummary = result.wreckType
          ? ` Wreck type: ${result.wreckType.name} (${result.wreckType.typeID}).`
          : "";
        chatHub.sendSystemMessage(
          session,
          `Detonated ${result.destroyed.length}/${result.spawnedCount} ${result.typeRecord.name} structure${result.spawnedCount === 1 ? "" : "s"}.${wreckSummary}`,
          feedbackChannel,
        );
      })
      .catch((error) => {
        log.warn(`[ChatCommands] /deathstructure completion failed: ${error.message}`);
      });
  }

  const wreckSummary = spawnResult.data.wreckType
    ? ` Expected wreck: ${spawnResult.data.wreckType.name} (${spawnResult.data.wreckType.typeID}).`
    : " No structure wreck type is mapped; destruction will use the normal fallback path.";
  return handledResult(
    chatHub,
    session,
    options,
    `Spawned ${spawnResult.data.spawned.length} ${spawnResult.data.typeRecord.name} structure${spawnResult.data.spawned.length === 1 ? "" : "s"} across ${(spawnResult.data.radiusMeters / 1000).toFixed(0)} km. Detonation in ${(spawnResult.data.delayMs / 1000).toFixed(1)}s sim time.${wreckSummary}`,
  );
}

module.exports = {
  resolveAbyssalSuicideAuthority,
  isSessionShipCapsuleBeforeDestruction,
  handleSuicideCommand,
  handleDeathTestCommand,
  handleStructureDeathTestCommand,
};
