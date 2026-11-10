"use strict";

module.exports = {
  buildAbyssalRuntimeArtifactDestructionContext,
  noteAbyssalNpcStandingsSuppression,
  notifyAbyssalEntityDestroyedSafe,
  notifyAbyssalEnvironmentalObjectDestroyedSafe,
  notifyAbyssalNpcDestroyedFromContext,
  notifyAbyssalNpcsDestroyedFromContexts,
  resolveAbyssalNpcRuntimePolicy,
  resolveAbyssalNpcStandingsSuppressionResult,
};

const runtimeEntryDirname = require("path").resolve(__dirname, "..");
const path = require("path");
const log = require(path.join(runtimeEntryDirname, "../utils/logger"));
const {
  resolveExactAbyssalNpcOutcomeContext,
} = require(path.join(
  runtimeEntryDirname,
  "../services/_shared/abyssalNpcOutcomePolicy.js",
));
const {
  getAbyssalMgrServiceModule,
} = require("./abyssalServicePort");
const {
  toInt,
} = require("../../common/numbers");
const {
  normalizeSceneText,
} = require("./sceneIdentity");
const {
  DEFAULT_RIGHT,
  cloneVector,
} = require("../../common/vector");

function buildAbyssalRuntimeArtifactDestructionContext(scene, entity, options = {}) {
  return {
    instanceID: toInt(entity && entity.evejsAbyssalInstanceID, 0),
    itemID: toInt(entity && entity.itemID, 0),
    typeID: toInt(entity && entity.typeID, 0),
    artifactKind: entity && entity.evejsAbyssalArtifactKind,
    artifactState: entity && entity.evejsAbyssalArtifactState,
    roomIndex: toInt(
      entity && entity.evejsAbyssalArtifactState &&
        entity.evejsAbyssalArtifactState.roomIndex,
      0,
    ),
    position: cloneVector(entity && entity.position),
    direction: cloneVector(entity && entity.direction, DEFAULT_RIGHT),
    sceneKey: scene && scene.sceneKey,
    claimOperationID: normalizeSceneText(options.claimOperationID, ""),
  };
}

function notifyAbyssalEntityDestroyedSafe(scene, entity, options = {}) {
  if (!scene || !entity || toInt(entity && entity.evejsAbyssalInstanceID, 0) <= 0) {
    return null;
  }
  try {
    const environmentalDestroyResult = notifyAbyssalEnvironmentalObjectDestroyedSafe(
      scene,
      entity,
      { reason: "entity-destroyed" },
    );
    if (environmentalDestroyResult && environmentalDestroyResult.handled === true) {
      return {
        environmentalObjectNotified: true,
        result: environmentalDestroyResult,
      };
    }
    const abyssalMgrService = getAbyssalMgrServiceModule();
    if (
      abyssalMgrService &&
      typeof abyssalMgrService.handleAbyssalNpcDestroyed === "function" &&
      (entity.evejsAbyssalNpc === true || entity.nativeNpc === true)
    ) {
      const npcDestroyResult = abyssalMgrService.handleAbyssalNpcDestroyed({
        instanceID: toInt(entity.evejsAbyssalInstanceID, 0),
        itemID: toInt(entity.itemID, 0),
        typeID: toInt(entity.typeID, 0),
        roomIndex: toInt(entity.evejsAbyssalRoomIndex, 0),
        sceneKey: scene.sceneKey,
      });
      if (npcDestroyResult && npcDestroyResult.success === true) {
        return {
          objectiveNotified: true,
          result: npcDestroyResult,
        };
      }
    }
    if (
      options.suppressRewardMaterialization !== true &&
      abyssalMgrService &&
      typeof abyssalMgrService.handleAbyssalRuntimeArtifactDestroyed === "function" &&
      (
        entity.evejsAbyssalRewardCache === true ||
        entity.evejsAbyssalExtractionNode === true
      )
    ) {
      const artifactResult = abyssalMgrService.handleAbyssalRuntimeArtifactDestroyed(
        buildAbyssalRuntimeArtifactDestructionContext(scene, entity, {
          claimOperationID: options.claimOperationID,
        }),
      );
      return {
        artifactNotified: Boolean(artifactResult && artifactResult.success === true),
        result: artifactResult || null,
        errorMsg:
          artifactResult && artifactResult.success !== true
            ? normalizeSceneText(
                artifactResult.errorMsg,
                "ABYSSAL_REWARD_ARTIFACT_HANDLER_FAILED",
              )
            : null,
      };
    }
  } catch (error) {
    log.warn(`[SpaceRuntime] Abyssal entity destruction hook failed: ${error.message}`);
  }
  return null;
}

function notifyAbyssalEnvironmentalObjectDestroyedSafe(scene, entity, options = {}) {
  if (
    !scene ||
    !entity ||
    entity.evejsAbyssalEnvironmentalObject !== true ||
    entity.evejsAbyssalEnvironmentalMechanicsEnabled !== true ||
    toInt(entity.evejsAbyssalInstanceID, 0) <= 0
  ) {
    return null;
  }
  if (entity.evejsAbyssalEnvironmentalDestructionNotified === true) {
    return {
      success: true,
      handled: true,
      cleaned: 0,
      reason: "ALREADY_NOTIFIED",
    };
  }
  try {
    const abyssalMgrService = getAbyssalMgrServiceModule();
    if (
      !abyssalMgrService ||
      typeof abyssalMgrService.handleAbyssalEnvironmentalObjectDestroyed !== "function"
    ) {
      return null;
    }
    const result = abyssalMgrService.handleAbyssalEnvironmentalObjectDestroyed({
      instanceID: toInt(entity.evejsAbyssalInstanceID, 0),
      itemID: toInt(entity.itemID, 0),
      typeID: toInt(entity.typeID, 0),
      roomIndex: toInt(entity.evejsAbyssalRoomIndex, 0),
      sceneKey: normalizeSceneText(scene.sceneKey, ""),
      reason: normalizeSceneText(options.reason, "entity-destroyed"),
    });
    if (result && result.success === true && result.handled === true) {
      entity.evejsAbyssalEnvironmentalDestructionNotified = true;
      entity.persistSpaceState = false;
    }
    return result || null;
  } catch (error) {
    log.warn(`[SpaceRuntime] Abyssal environmental destruction hook failed: ${error.message}`);
    return null;
  }
}

function notifyAbyssalNpcDestroyedFromContext(context = {}, options = {}) {
  const abyssalMgrService = getAbyssalMgrServiceModule();
  if (!abyssalMgrService) {
    return {
      handled: false,
      newlyRecorded: false,
      objectiveComplete: false,
      result: "callback-missing",
    };
  }
  if (options.queuePendingOnly === true) {
    if (typeof abyssalMgrService.queuePendingAbyssalNpcDestroyed !== "function") {
      return {
        success: false,
        handled: false,
        pending: false,
        result: "pending-queue-missing",
        errorMsg: "ABYSSAL_NPC_PENDING_QUEUE_UNAVAILABLE",
      };
    }
    try {
      return abyssalMgrService.queuePendingAbyssalNpcDestroyed(
        {
          ...context,
          nowMs: options.nowMs,
        },
        {
          reason: normalizeSceneText(
            options.pendingReason,
            "npc-destruction-batch-pending",
          ),
          nowMs: options.nowMs,
          suppressLog: options.suppressPendingLog === true,
        },
      );
    } catch (error) {
      log.warn(
        `[SpaceRuntime] Abyssal NPC pending destruction queue failed ` +
          `npc=${toInt(context && context.npcID, 0)} ` +
          `run=${toInt(context && context.abyssalRunID, 0)} ` +
          `reason=${error.message}`,
      );
      return {
        success: false,
        handled: false,
        pending: false,
        result: "pending-queue-error",
        errorMsg: error.message,
      };
    }
  }
  if (typeof abyssalMgrService.handleAbyssalNpcDestroyed !== "function") {
    return {
      handled: false,
      newlyRecorded: false,
      objectiveComplete: false,
      result: "callback-missing",
    };
  }
  try {
    const result = abyssalMgrService.handleAbyssalNpcDestroyed({
      ...context,
      nowMs: options.nowMs,
    });
    const normalizedResult = result && typeof result === "object"
      ? result
      : {
        handled: result === true,
        newlyRecorded: result === true,
        objectiveComplete: false,
        result: result === true ? "notified" : "not-tracked",
      };
    return normalizedResult;
  } catch (error) {
    if (
      abyssalMgrService &&
      typeof abyssalMgrService.queuePendingAbyssalNpcDestroyed === "function"
    ) {
      try {
        abyssalMgrService.queuePendingAbyssalNpcDestroyed(context, {
          reason: error && error.message || "callback-error",
          nowMs: options.nowMs,
        });
      } catch (queueError) {
        log.warn(
          `[SpaceRuntime] Abyssal NPC objective pending queue failed ` +
            `npc=${toInt(context && context.npcID, 0)} ` +
            `run=${toInt(context && context.abyssalRunID, 0)} ` +
            `reason=${queueError.message}`,
        );
      }
    }
    log.warn(
      `[SpaceRuntime] Abyssal NPC objective notification failed ` +
        `npc=${toInt(context && context.npcID, 0)} ` +
        `run=${toInt(context && context.abyssalRunID, 0)} ` +
        `room=${toInt(context && context.abyssalRoomIndex, 0)} ` +
        `sceneKey=${String(context && context.sceneKey || "none")} ` +
        `reason=${error && error.message || "UNKNOWN_ERROR"}`,
    );
    return {
      handled: false,
      newlyRecorded: false,
      objectiveComplete: false,
      result: "callback-error",
      pending: true,
      errorMsg: error && error.message || "UNKNOWN_ERROR",
    };
  }
}

async function notifyAbyssalNpcsDestroyedFromContexts(contexts = [], options = {}) {
  const normalizedContexts = Array.isArray(contexts)
    ? contexts.filter((context) => context && typeof context === "object")
    : [];
  if (normalizedContexts.length === 0) {
    return {
      success: true,
      handled: true,
      results: [],
      committedRunCount: 0,
      maintenancePassCount: 0,
    };
  }
  const abyssalMgrService = getAbyssalMgrServiceModule();
  if (
    abyssalMgrService &&
    typeof abyssalMgrService.handleAbyssalNpcsDestroyed === "function"
  ) {
    try {
      return await abyssalMgrService.handleAbyssalNpcsDestroyed(
        normalizedContexts.map((context) => ({
          ...context,
          nowMs: options.nowMs,
        })),
      );
    } catch (error) {
      log.warn(
        `[SpaceRuntime] Abyssal NPC destruction batch failed ` +
          `count=${normalizedContexts.length} reason=${error.message}`,
      );
    }
  }
  const results = normalizedContexts.map((context) =>
    notifyAbyssalNpcDestroyedFromContext(context, options)
  );
  return {
    success: results.every((result) => result && result.pending !== true),
    handled: results.some((result) => result && result.handled === true),
    results,
    committedRunCount: 0,
    maintenancePassCount: results.length,
    fallback: true,
  };
}

function resolveAbyssalNpcRuntimePolicy(entity) {
  const outcomeContext = resolveExactAbyssalNpcOutcomeContext(entity);
  if (outcomeContext.invalidAbyssalOutcomeAuthority === true) {
    return {
      suppressBounty: true,
      suppressWreck: true,
      suppressStandings: true,
      enforcementMode: "invalid_abyssal_outcome_authority",
    };
  }
  const policy = outcomeContext.exact === true
    ? outcomeContext.policy
    : null;
  return policy
    ? {
        suppressBounty: policy.suppressBounty === true,
        suppressWreck: policy.suppressWreck === true,
        suppressStandings: policy.suppressStandings === true,
        enforcementMode: String(policy.enforcementMode || "none"),
      }
    : {
        suppressBounty: false,
        suppressWreck: false,
        suppressStandings: false,
        enforcementMode: "none",
      };
}

function noteAbyssalNpcStandingsSuppression(entity) {
  const suppressionResult = resolveAbyssalNpcStandingsSuppressionResult(entity);
  if (!suppressionResult) {
    return null;
  }
  const logKey = `${suppressionResult.status}:${suppressionResult.reason}`;
  if (entity.evejsAbyssalStandingsSuppressionLogKey === logKey) {
    return suppressionResult;
  }
  entity.evejsAbyssalStandingsSuppressionLogKey = logKey;
  log.info(
    `[AbyssalMgr] NPC standings suppression enforced ship=${suppressionResult.shipID} ` +
      `enforcement=${suppressionResult.enforcementMode} ` +
      `status=${suppressionResult.status} reason=${suppressionResult.reason}`,
  );
  return suppressionResult;
}

function resolveAbyssalNpcStandingsSuppressionResult(entity) {
  const abyssalNpcRuntimePolicy = resolveAbyssalNpcRuntimePolicy(entity);
  if (
    !entity ||
    entity.nativeNpc !== true ||
    abyssalNpcRuntimePolicy.suppressStandings !== true
  ) {
    return null;
  }
  return {
    applicable: true,
    suppressed: true,
    enforcementMode: abyssalNpcRuntimePolicy.enforcementMode,
    status: "STANDINGS_MUTATION_SUPPRESSED",
    reason: "FACTION_KILL_STANDING_POLICY_ENFORCED",
    shipID: toInt(entity.itemID, 0),
  };
}
