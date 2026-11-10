"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// Nonterminal administrative return: durable intent precedes movement;
// the move receipt precedes outcome recording and terminal artifact cleanup.
function validateAbyssalStartupReturn({
  hasImmutableAbyssalRunOutcome,
  hasPendingAbyssalTerminalCleanup,
  log,
}, context) {
  const { instanceID, pocketState, shipID, characterID } = context;
  // This helper is only for nonterminal administrative recovery. Keep this
  // guard even though startup reconciliation checks terminal state first, so a
  // future caller cannot accidentally convert a lethal outcome into a return.
  if (
    hasImmutableAbyssalRunOutcome(pocketState) ||
    hasPendingAbyssalTerminalCleanup(pocketState)
  ) {
    log.error(
      `[AbyssalStartup] rejected unsafe terminal safe-return ` +
        `instance=${instanceID} character=${characterID} ship=${shipID} ` +
        `outcome=${normalizeText(pocketState && pocketState.runOutcome, "none")}`,
    );
    return {
      success: false,
      skipped: true,
      moved: false,
      shipID,
      characterID,
      errorMsg: "ABYSSAL_TERMINAL_RUN_NOT_ELIGIBLE_FOR_SAFE_RETURN",
    };
  }

  if (shipID <= 0 || toInt(pocketState && pocketState.sourceSolarSystemID, 0) <= 0) {
    return {
      success: false,
      skipped: false,
      moved: false,
      shipID,
      characterID,
      errorMsg: "INCOMPLETE_PERSISTED_RUN_IDENTITY",
    };
  }
  return null;
}

function resolveAbyssalStartupReturnShip({
  listUniquePositiveInts,
  updatePocketState,
  recordAbyssalRunOutcome,
  cleanupAbyssalRun,
  getCharacterID,
}, context) {
  let { pocketState, shipID } = context;
  const { instance, instanceID, characterID, session, deps, reason } = context;
  let shipItem = deps.findItemById(shipID);
  let replacementShipAdopted = false;
  if (!shipItem) {
    // The original participant hull may be unavailable during recovery of a
    // nonterminal interrupted run. Only adopt a replacement vessel when it is
    // authoritatively located inside this exact run. Never move a replacement
    // vessel that is already outside the run.
    const characterRecord = characterID > 0 && typeof deps.getCharacterRecord === "function"
      ? deps.getCharacterRecord(characterID)
      : null;
    const replacementShipID = toInt(
      characterRecord && characterRecord.shipID,
      toInt(
        session && session._space && session._space.shipID,
        toInt(session && (session.shipID || session.shipid || session.activeShipID), 0),
      ),
    );
    const replacementShipItem = replacementShipID > 0
      ? deps.findItemById(replacementShipID)
      : null;
    const replacementSystemID = toInt(
      replacementShipItem && replacementShipItem.spaceState && replacementShipItem.spaceState.systemID,
      toInt(replacementShipItem && replacementShipItem.locationID, 0),
    );
    const replacementLocationID = toInt(replacementShipItem && replacementShipItem.locationID, 0);
    const replacementSceneKey = normalizeText(
      replacementShipItem && replacementShipItem.spaceState && replacementShipItem.spaceState.sceneKey ||
        replacementShipItem && replacementShipItem.sceneKey,
      "",
    );
    const expectedSceneKey = instanceID > 0 ? `abyssal-run:${instanceID}` : "";
    const hostLocationIDs = new Set(listUniquePositiveInts([
      pocketState && pocketState.abyssalLocationID,
      pocketState && pocketState.solarSystemID,
      instance && instance.solarSystemID,
    ]));
    const replacementInsideRun = Boolean(
      replacementShipItem &&
      (
        hostLocationIDs.has(replacementSystemID) ||
        hostLocationIDs.has(replacementLocationID) ||
        (expectedSceneKey && replacementSceneKey === expectedSceneKey)
      )
    );
    if (replacementInsideRun) {
      shipID = replacementShipID;
      shipItem = replacementShipItem;
      replacementShipAdopted = true;
      pocketState = updatePocketState(instanceID, { shipID }) || {
        ...pocketState,
        shipID,
      };
    } else {
      const safePocketState = recordAbyssalRunOutcome(
        pocketState,
        "cluster_shutdown_returned",
        deps,
        {
          reason: normalizeText(reason, "server-restart-reset"),
          rewardEligible: false,
          deathApplied: false,
        },
      ) || pocketState;
      const cleanupResult = cleanupAbyssalRun(safePocketState, deps, {
        reason: "cluster-shutdown-return",
        session: session && getCharacterID(session) === characterID ? session : null,
      });
      if (!cleanupResult || cleanupResult.success !== true) {
        return {
          success: false,
          skipped: false,
          moved: false,
          shipID: replacementShipID || shipID,
          characterID,
          cleanupResult,
          errorMsg: normalizeText(
            cleanupResult && cleanupResult.errorMsg,
            "ABYSSAL_STARTUP_TERMINAL_CLEANUP_FAILED",
          ),
        };
      }
      return {
        success: true,
        skipped: false,
        moved: false,
        alreadyAtReturnTarget: true,
        shipID: replacementShipID || shipID,
        characterID,
        cleanupResult,
      };
    }
  }
  Object.assign(context, { pocketState, shipID, replacementShipAdopted });
  return null;
}

function stageAbyssalStartupReturn({
  cloneValue,
  buildPlaceholderReturnSpaceState,
  updatePocketState,
  ensureAbyssalPocketPersistenceReady,
}, context) {
  const { pocketState, instanceID, shipID, characterID, deps, reason } = context;
  const existingRecoveryState =
    pocketState.startupRecoveryState &&
    typeof pocketState.startupRecoveryState === "object"
      ? cloneValue(pocketState.startupRecoveryState)
      : {};
  const idempotencyKey = normalizeText(
    existingRecoveryState.idempotencyKey,
    `abyssal-startup-return:${instanceID}:${characterID}:${shipID}`,
  );
  const returnSpaceState =
    existingRecoveryState.returnSpaceState &&
    typeof existingRecoveryState.returnSpaceState === "object"
      ? cloneValue(existingRecoveryState.returnSpaceState)
      : buildPlaceholderReturnSpaceState(pocketState);
  const stagedAtMs = toInt(
    existingRecoveryState.stagedAtMs,
    toInt(deps.now(), Date.now()),
  );
  const stagedPocketState = updatePocketState(instanceID, {
    startupRecoveryState: {
      schemaVersion: 1,
      state: "pending",
      idempotencyKey,
      reason: normalizeText(reason, "server-restart-reset"),
      characterID,
      shipID,
      instanceID,
      traceItemID: toInt(pocketState.traceItemID, 0),
      returnSpaceState: cloneValue(returnSpaceState),
      stagedAtMs,
      attemptCount: toInt(existingRecoveryState.attemptCount, 0) + 1,
      moveCommittedAtMs: toInt(existingRecoveryState.moveCommittedAtMs, 0),
      cleanupCompletedAtMs: 0,
      rewardEligible: false,
    },
  }) || pocketState;
  const stagedPersistenceResult = ensureAbyssalPocketPersistenceReady(
    stagedPocketState,
    deps,
  );
  if (!stagedPersistenceResult || stagedPersistenceResult.success !== true) {
    return {
      success: false,
      skipped: false,
      moved: false,
      shipID,
      characterID,
      errorMsg: "ABYSSAL_STARTUP_RECOVERY_STAGE_PERSIST_FAILED",
    };
  }
  Object.assign(context, { existingRecoveryState, idempotencyKey, returnSpaceState, stagedPocketState });
  return null;
}

function moveAbyssalStartupReturnShip({
  getCharacterID,
  evacuateAbyssalRunSession,
  normalizeLowerText,
  log,
}, context) {
  const { instance, session, characterID, shipID, deps, reason, stagedPocketState,
    idempotencyKey, returnSpaceState, existingRecoveryState } = context;
  const evacuationSession = session && getCharacterID(session) === characterID
    ? session
    : null;
  const evacuationResult = evacuateAbyssalRunSession(
    evacuationSession,
    stagedPocketState,
    reason,
    deps,
    {
      cleanupRun: false,
      tombstoneState: "pending",
      idempotencyKey,
      returnSpaceStateOverride: returnSpaceState,
      alreadyMoveCommitted:
        normalizeLowerText(existingRecoveryState.state, "") === "ship-moved",
      hostLocationID: toInt(stagedPocketState && stagedPocketState.solarSystemID, 0),
    },
  );
  if (!evacuationResult || evacuationResult.success !== true) {
    log.warn(
      `[AbyssalMgr] Server restart evacuation failed char=${characterID} ` +
        `ship=${shipID} instance=${toInt(instance && instance.instanceID, 0)} ` +
        `reason=${evacuationResult && evacuationResult.errorMsg || "POCKET_EVICTION_MOVE_FAILED"}`,
    );
    return {
      success: false,
      skipped: false,
      moved: false,
      shipID,
      characterID,
      errorMsg: evacuationResult && evacuationResult.errorMsg || "POCKET_EVICTION_MOVE_FAILED",
    };
  }
  Object.assign(context, { evacuationSession, evacuationResult });
  return null;
}

function commitAbyssalStartupReturnMove({
  updatePocketState,
  cloneValue,
  ensureAbyssalPocketPersistenceReady,
}, context) {
  const { instanceID, characterID, shipID, deps, stagedPocketState,
    evacuationResult, replacementShipAdopted } = context;
  let movedPocketState = updatePocketState(instanceID, {
    startupRecoveryState: {
      ...cloneValue(stagedPocketState.startupRecoveryState),
      state: "ship-moved",
      moveCommittedAtMs: toInt(deps.now(), Date.now()),
      returnSpaceState: cloneValue(evacuationResult.returnSpaceState),
      rewardEligible: false,
    },
  }) || stagedPocketState;
  if (replacementShipAdopted) {
    movedPocketState = updatePocketState(instanceID, {
      weatherRemovalState: {
        schemaVersion: 1,
        status: "completed",
        instanceID,
        characterID,
        shipID,
        traceItemID: toInt(movedPocketState && movedPocketState.traceItemID, 0),
        reason: "startup-replacement-ship-not-weather-target",
        verified: true,
        completedAtMs: toInt(deps.now(), Date.now()),
      },
    }) || movedPocketState;
  }
  const moveReceiptPersistenceResult = ensureAbyssalPocketPersistenceReady(
    movedPocketState,
    deps,
  );
  if (!moveReceiptPersistenceResult || moveReceiptPersistenceResult.success !== true) {
    return {
      success: false,
      skipped: false,
      moved: evacuationResult.moved !== false,
      // The ship is out of the pocket; only the receipt/teardown is unfinished.
      returnCommitted: true,
      shipID,
      characterID,
      returnSpaceState: evacuationResult.returnSpaceState,
      errorMsg: "ABYSSAL_STARTUP_MOVE_RECEIPT_PERSIST_FAILED",
    };
  }
  context.movedPocketState = movedPocketState;
  return null;
}

function finishAbyssalStartupReturn({
  recordAbyssalRunOutcome,
  cleanupAbyssalRun,
  findAbyssalRecoveryTombstone,
  updateAbyssalRecoveryTombstoneState,
  log,
  formatVectorForLog,
}, context) {
  let { movedPocketState } = context;
  const { instance, instanceID, characterID, shipID, deps, reason, evacuationSession,
    evacuationResult, stagedPocketState } = context;
  movedPocketState = recordAbyssalRunOutcome(
    movedPocketState,
    "cluster_shutdown_returned",
    deps,
    {
      reason: normalizeText(reason, "server-restart-reset"),
      rewardEligible: false,
      deathApplied: false,
    },
  ) || movedPocketState;
  const cleanupResult = cleanupAbyssalRun(movedPocketState, deps, {
    reason: "cluster-shutdown-return",
    session: evacuationSession,
  });
  if (!cleanupResult || cleanupResult.success !== true) {
    return {
      success: false,
      skipped: false,
      moved: evacuationResult.moved !== false,
      // The ship is out of the pocket; only the receipt/teardown is unfinished.
      returnCommitted: true,
      shipID,
      characterID,
      returnSpaceState: evacuationResult.returnSpaceState,
      cleanupResult,
      errorMsg: normalizeText(
        cleanupResult && cleanupResult.errorMsg,
        "ABYSSAL_STARTUP_TERMINAL_CLEANUP_FAILED",
      ),
    };
  }
  const tombstone = findAbyssalRecoveryTombstone({
    characterID,
    shipID,
    hostLocationID: toInt(stagedPocketState && stagedPocketState.solarSystemID, 0),
  });
  if (tombstone && toInt(tombstone.runID, 0) === instanceID) {
    updateAbyssalRecoveryTombstoneState(tombstone, "complete", {
      cleanupCompletedAtMs: toInt(deps.now(), Date.now()),
    });
  }

  log.info(
    `[AbyssalMgr] Server restart evacuation char=${characterID} ` +
      `ship=${shipID} instance=${toInt(instance && instance.instanceID, 0)} ` +
      `returnSystem=${toInt(evacuationResult.returnSystemID, 0)} ` +
      `returnPos=${formatVectorForLog(evacuationResult.returnSpaceState && evacuationResult.returnSpaceState.position)} ` +
      `sourcePos=${formatVectorForLog(stagedPocketState.sourceShipPosition)} ` +
      `alreadyReturned=${evacuationResult.alreadyAtReturnTarget === true}`,
  );
  return {
    success: true,
    skipped: false,
    moved: evacuationResult.moved !== false,
    alreadyAtReturnTarget: evacuationResult.alreadyAtReturnTarget === true,
    shipID,
    characterID,
    returnSpaceState: evacuationResult.returnSpaceState,
    cleanupResult,
  };
}

function evacuateShipFromPurgedPlaceholderPocket({
  getDependencies,
  getActivePocketStateByInstanceID,
  buildPocketStateFromInstance,
  validateAbyssalStartupReturn,
  resolveAbyssalStartupReturnShip,
  stageAbyssalStartupReturn,
  moveAbyssalStartupReturnShip,
  commitAbyssalStartupReturnMove,
  finishAbyssalStartupReturn,
},
  instance,
  session = null,
  deps = getDependencies(),
  reason = "server-restart-reset",
) {
  const instanceID = toInt(instance && instance.instanceID, 0);

  // Prefer the latest registered state. The instance argument may be the older
  // startup snapshot from before reconciliation updated the active run.
  let pocketState =
    getActivePocketStateByInstanceID(instanceID) ||
    buildPocketStateFromInstance(instance, null);
  let shipID = toInt(pocketState && pocketState.shipID, 0);
  const characterID = toInt(pocketState && pocketState.characterID, 0);
  const context = { instance, session, deps, reason, instanceID, pocketState, shipID, characterID };
  for (const step of [
    validateAbyssalStartupReturn,
    resolveAbyssalStartupReturnShip,
    stageAbyssalStartupReturn,
    moveAbyssalStartupReturnShip,
    commitAbyssalStartupReturnMove,
  ]) {
    const result = step(context);
    if (result) return result;
  }
  return finishAbyssalStartupReturn(context);
}

// Capture supplied capabilities once, as the original closure did. Internal
// callbacks are bound once per instance; no runtime state lives in this wiring.
function createAbyssalStartupReturn({
  hasImmutableAbyssalRunOutcome,
  hasPendingAbyssalTerminalCleanup,
  log,
  listUniquePositiveInts,
  updatePocketState,
  recordAbyssalRunOutcome,
  cleanupAbyssalRun,
  getCharacterID,
  cloneValue,
  buildPlaceholderReturnSpaceState,
  ensureAbyssalPocketPersistenceReady,
  evacuateAbyssalRunSession,
  normalizeLowerText,
  findAbyssalRecoveryTombstone,
  updateAbyssalRecoveryTombstoneState,
  formatVectorForLog,
  getDependencies,
  getActivePocketStateByInstanceID,
  buildPocketStateFromInstance,
}) {

  const ports = {
    hasImmutableAbyssalRunOutcome,
    hasPendingAbyssalTerminalCleanup,
    log,
    listUniquePositiveInts,
    updatePocketState,
    recordAbyssalRunOutcome,
    cleanupAbyssalRun,
    getCharacterID,
    cloneValue,
    buildPlaceholderReturnSpaceState,
    ensureAbyssalPocketPersistenceReady,
    evacuateAbyssalRunSession,
    normalizeLowerText,
    findAbyssalRecoveryTombstone,
    updateAbyssalRecoveryTombstoneState,
    formatVectorForLog,
    getDependencies,
    getActivePocketStateByInstanceID,
    buildPocketStateFromInstance,
  };
  ports.validateAbyssalStartupReturn = validateAbyssalStartupReturn.bind(null, ports);
  ports.resolveAbyssalStartupReturnShip = resolveAbyssalStartupReturnShip.bind(null, ports);
  ports.stageAbyssalStartupReturn = stageAbyssalStartupReturn.bind(null, ports);
  ports.moveAbyssalStartupReturnShip = moveAbyssalStartupReturnShip.bind(null, ports);
  ports.commitAbyssalStartupReturnMove = commitAbyssalStartupReturnMove.bind(null, ports);
  ports.finishAbyssalStartupReturn = finishAbyssalStartupReturn.bind(null, ports);
  ports.evacuateShipFromPurgedPlaceholderPocket = evacuateShipFromPurgedPlaceholderPocket.bind(null, ports);
  Object.freeze(ports);
  return { evacuateShipFromPurgedPlaceholderPocket: ports.evacuateShipFromPurgedPlaceholderPocket };
}

module.exports = { createAbyssalStartupReturn };
