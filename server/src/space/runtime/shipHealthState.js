"use strict";

module.exports = {
  broadcastDamageStateChange,
  buildShipHealthAttributeSnapshotFromDamageResult,
  buildShipHealthTransitionResult,
  healShipResourcesForSession,
  notifyShipHealthAttributesToSession,
};

const runtimeEntryDirname = require("path").resolve(__dirname, "..");
const path = require("path");
const log = require(path.join(runtimeEntryDirname, "../utils/logger"));
const {
  CAPSULE_TYPE_ID,
  CAPSULE_TYPE_ID_GOLDEN,
  ITEM_FLAGS,
  updateShipItem,
  updateInventoryItem,
  removeInventoryItem,
  getShipConditionState,
  normalizeShipConditionState,
  getItemMetadata,
  pruneExpiredSpaceItems,
} = require(path.join(runtimeEntryDirname, "../services/inventory/itemStore"));
const {
  buildDamageStatePresentationUpdates,
} = require(path.join(
  runtimeEntryDirname,
  "./destiny/presentation/specialFxPayloads.js",
));
const {
  currentFileTime,
  buildFiletimeLong,
  buildMarshalReal,
} = require(path.join(runtimeEntryDirname, "../services/_shared/serviceHelpers"));
const {
  applyDamageToEntity,
  applyResolvedDamageAmountToEntity,
  buildLiveDamageState,
  hasDamageableHealth,
  getEntityCurrentHealthLayers,
  getEntityMaxHealthLayers,
  sumDamageVector,
} = require(path.join(runtimeEntryDirname, "./combat/damage"));
const {
  buildAttributeChange,
  notifyAttributeChanges,
  notifyCapacitorChangeToSession,
} = require("./attributeChangeNotification");
const {
  isReadyForDestiny,
  sessionMatchesIdentity,
} = require("./destinyDeliveryEligibility");
const {
  ATTRIBUTE_SHIP_ARMOR_DAMAGE,
  ATTRIBUTE_SHIP_DAMAGE,
  ATTRIBUTE_SHIP_SHIELD_CHARGE,
} = require("./dogmaAttributeIds");
const {
  getEntityCapacitorAmount,
  setEntityCapacitorRatio,
} = require("./entityCapacitor");
const {
  getOwningSessionForEntity,
} = require("./entityOwnerSession");
const {
  persistDynamicEntity,
} = require("./entitySpacePersistence");
const {
  roundNumber,
  toFiniteNumber,
  toInt,
} = require("../../common/numbers");
const {
  buildMissileSessionSnapshot,
  isMissileDebugEnabled,
  logMissileDebug,
  summarizeMissileUpdatesForLog,
  summarizeRuntimeEntityForMissileDebug,
} = require("./runtimeDebugInstrumentation");
const {
  getSceneKeyForSession,
  normalizeSceneText,
} = require("./sceneIdentity");
const {
  resolveSessionNotificationFileTime,
} = require("./sessionNotificationTime");
const {
  ensureEntityTargetingState,
} = require("./targeting");

function buildShipHealthAttributeSnapshotFromDamageResult(damageResult) {
  const damageData =
    damageResult && damageResult.success === true && damageResult.data
      ? damageResult.data
      : null;
  if (!damageData) {
    return null;
  }

  const maxLayers = damageData.maxLayers || {};
  const beforeLayers = damageData.beforeLayers || {};
  const afterLayers = damageData.afterLayers || {};
  const beforeConditionState = damageData.beforeConditionState || null;
  const afterConditionState = damageData.afterConditionState || null;
  const maxArmorHP = Math.max(0, toFiniteNumber(maxLayers.armor, 0));
  const previousArmorDamage =
    beforeConditionState && Number.isFinite(Number(beforeConditionState.armorDamage))
      ? maxArmorHP * Math.max(
        0,
        toFiniteNumber(beforeConditionState.armorDamage, 0),
      )
      : Math.max(
        0,
        maxArmorHP - toFiniteNumber(beforeLayers.armor, 0),
      );
  const nextArmorDamage =
    afterConditionState && Number.isFinite(Number(afterConditionState.armorDamage))
      ? maxArmorHP * Math.max(
        0,
        toFiniteNumber(afterConditionState.armorDamage, 0),
      )
      : Math.max(
        0,
        maxArmorHP - toFiniteNumber(afterLayers.armor, 0),
      );
  return {
    shieldCharge: {
      previous: roundNumber(toFiniteNumber(beforeLayers.shield, 0), 6),
      next: roundNumber(toFiniteNumber(afterLayers.shield, 0), 6),
    },
    armorDamage: {
      previous: roundNumber(previousArmorDamage, 6),
      next: roundNumber(nextArmorDamage, 6),
    },
    structureDamage: {
      previous: roundNumber(
        Math.max(
          0,
          toFiniteNumber(maxLayers.structure, 0) - toFiniteNumber(beforeLayers.structure, 0),
        ),
        6,
      ),
      next: roundNumber(
        Math.max(
          0,
          toFiniteNumber(maxLayers.structure, 0) - toFiniteNumber(afterLayers.structure, 0),
        ),
        6,
      ),
    },
  };
}

function buildShipHealthTransitionResult(entity, previousConditionState = null) {
  if (!entity) {
    return null;
  }

  const normalizedPreviousConditionState = normalizeShipConditionState(
    previousConditionState === null || previousConditionState === undefined
      ? entity.conditionState
      : previousConditionState,
  );
  const maxLayers = getEntityMaxHealthLayers(entity);
  const beforeLayers = getEntityCurrentHealthLayers(
    {
      ...entity,
      conditionState: normalizedPreviousConditionState,
    },
    maxLayers,
  );
  const afterLayers = getEntityCurrentHealthLayers(entity, maxLayers);

  return {
    success: true,
    data: {
      maxLayers: {
        shield: roundNumber(toFiniteNumber(maxLayers.shield, 0), 6),
        armor: roundNumber(toFiniteNumber(maxLayers.armor, 0), 6),
        structure: roundNumber(toFiniteNumber(maxLayers.structure, 0), 6),
      },
      beforeLayers: {
        shield: roundNumber(toFiniteNumber(beforeLayers.shield, 0), 6),
        armor: roundNumber(toFiniteNumber(beforeLayers.armor, 0), 6),
        structure: roundNumber(toFiniteNumber(beforeLayers.structure, 0), 6),
      },
      afterLayers: {
        shield: roundNumber(toFiniteNumber(afterLayers.shield, 0), 6),
        armor: roundNumber(toFiniteNumber(afterLayers.armor, 0), 6),
        structure: roundNumber(toFiniteNumber(afterLayers.structure, 0), 6),
      },
      beforeConditionState: {
        ...normalizedPreviousConditionState,
      },
      afterConditionState: {
        ...normalizeShipConditionState(entity.conditionState),
      },
      destroyed: false,
    },
  };
}

function notifyShipHealthAttributesToSession(
  session,
  entity,
  damageResult,
  whenMs = null,
) {
  if (!session || !entity) {
    return false;
  }

  const shipID = toInt(entity.itemID, 0);
  const snapshot = buildShipHealthAttributeSnapshotFromDamageResult(damageResult);
  if (shipID <= 0 || !snapshot) {
    return false;
  }

  let timestamp;
  if (whenMs != null) {
    timestamp = resolveSessionNotificationFileTime(session, whenMs);
  } else if (session && session._space && session._space.simFileTime) {
    timestamp = resolveSessionNotificationFileTime(session);
  } else {
    log.warn("notifyShipHealthAttributesToSession: no sim time source, using wallclock fallback");
    timestamp = currentFileTime();
  }

  const changes = [];
  const candidates = [
    [
      ATTRIBUTE_SHIP_SHIELD_CHARGE,
      snapshot.shieldCharge.next,
      snapshot.shieldCharge.previous,
    ],
    [
      ATTRIBUTE_SHIP_ARMOR_DAMAGE,
      snapshot.armorDamage.next,
      snapshot.armorDamage.previous,
    ],
    [
      ATTRIBUTE_SHIP_DAMAGE,
      snapshot.structureDamage.next,
      snapshot.structureDamage.previous,
    ],
  ];

  for (const [attributeID, nextValue, previousValue] of candidates) {
    if (attributeID <= 0 || Number(nextValue) === Number(previousValue)) {
      continue;
    }
    changes.push(
      buildAttributeChange(
        session,
        shipID,
        attributeID,
        nextValue,
        previousValue,
        timestamp,
      ),
    );
  }

  return notifyAttributeChanges(session, changes);
}

function healShipResourcesForSession(session, scene, entity, options = {}) {
  if (!entity || entity.kind !== "ship") {
    return {
      success: false,
      errorMsg: "SHIP_NOT_FOUND",
    };
  }

  const ownerSession = session || entity.session || null;
  const previousConditionState = normalizeShipConditionState(entity.conditionState);
  const previousChargeAmount = getEntityCapacitorAmount(entity);
  const healedConditionState = normalizeShipConditionState({
    ...previousConditionState,
    damage: 0,
    charge: 1,
    armorDamage: 0,
    shieldCharge: 1,
  });

  entity.conditionState = healedConditionState;
  setEntityCapacitorRatio(entity, healedConditionState.charge);
  persistDynamicEntity(entity);

  const nextConditionState = normalizeShipConditionState(entity.conditionState);
  const healthTransitionResult = buildShipHealthTransitionResult(
    entity,
    previousConditionState,
  );
  const healthChanged =
    Math.abs(
      toFiniteNumber(previousConditionState.shieldCharge, 0) -
        toFiniteNumber(nextConditionState.shieldCharge, 0),
    ) > 1e-6 ||
    Math.abs(
      toFiniteNumber(previousConditionState.armorDamage, 0) -
        toFiniteNumber(nextConditionState.armorDamage, 0),
    ) > 1e-6 ||
    Math.abs(
      toFiniteNumber(previousConditionState.damage, 0) -
        toFiniteNumber(nextConditionState.damage, 0),
    ) > 1e-6;
  const resolvedWhenMs =
    options.whenMs !== undefined && options.whenMs !== null
      ? toFiniteNumber(options.whenMs, Date.now())
      : scene
        ? scene.getCurrentSimTimeMs()
        : Date.now();

  if (ownerSession) {
    notifyShipHealthAttributesToSession(
      ownerSession,
      entity,
      healthTransitionResult,
      resolvedWhenMs,
    );
    notifyCapacitorChangeToSession(
      ownerSession,
      entity,
      resolvedWhenMs,
      previousChargeAmount,
    );
  }

  const deliveredCount =
    scene && healthChanged
      ? broadcastDamageStateChange(scene, entity, resolvedWhenMs)
      : 0;

  const canRefreshOwnerDamagePresentation =
    scene &&
    healthChanged &&
    ownerSession &&
    isReadyForDestiny(ownerSession) &&
    (
      !entity.session ||
      sessionMatchesIdentity(ownerSession, entity.session)
    );
  const shouldRefreshOwnerDamagePresentation =
    options.refreshOwnerDamagePresentation !== false &&
    canRefreshOwnerDamagePresentation;
  if (shouldRefreshOwnerDamagePresentation) {
    // Pilot HUD health already rides dogma attribute updates, but the ego ship's
    // in-space impact visuals can still need a fresh SetState re-read of the
    // authoritative damage-state map. Keep this owner-only because observers
    // already update from OnDamageStateChange. Callers can disable it for
    // live operator/debug actions like /heal where a full SetState rebase is
    // riskier than leaving stale impact visuals until the next normal refresh.
    scene.sendStateRefresh(ownerSession, {
      reason: "damage-presentation",
    });
  }

  return {
    success: true,
    data: {
      entity,
      whenMs: resolvedWhenMs,
      previousChargeAmount: roundNumber(previousChargeAmount, 6),
      currentChargeAmount: roundNumber(getEntityCapacitorAmount(entity), 6),
      previousConditionState,
      currentConditionState: nextConditionState,
      healthChanged,
      deliveredCount,
    },
  };
}

// A Ball's damage state changed (OnDamageStateChange): to its Grid bubble's
// history, its owner included. A Gameplay event.
function broadcastDamageStateChange(scene, entity) {
  if (!scene || !entity) {
    return 0;
  }
  const stamp = scene.nextDestinyStamp;
  const updates = buildDamageStatePresentationUpdates({
    stamp,
    entityID: entity.itemID,
    damageState: buildLiveDamageState(entity, scene.getCurrentFileTime()),
  });
  return scene.queueBallHistory(entity, updates) === null ? 0 : 1;
}
