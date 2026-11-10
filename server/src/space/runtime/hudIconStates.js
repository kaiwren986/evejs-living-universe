"use strict";

const { queueDogmaEvent } = require("./dogmaEvents");

module.exports = {
  applyHostileHudCycle,
  applyJammerCyclePresentation,
  buildAssistanceHudState,
  buildHostileHudState,
  buildJammerHudState,
  hasAssistanceJamState,
  hasHostileJamState,
  hasJammerHudState,
  notifyActiveAssistanceJamStatesToSession,
  notifyActiveHostileJamStatesToSession,
  notifyAssistanceHudStateToSession,
  notifyHostileHudStateToSession,
  notifyHudEwarStateToSession,
  notifyHudIconStateToSession,
  notifyHudIconStatesToSession,
  notifyHudJamStateToSession,
  notifyRefreshBuffBarToSession,
  removeJammerCyclePresentation,
  removeHostileHudState,
  resolveAssistanceJamDurationMs,
  resolveHostileJamDurationMs,
  resolveHostileJamRefreshDurationMs,
  resolveHudStateDurationMs,
  resolveJammerJamDurationMs,
  tickHudIconStateExpiries,
};

const runtimeEntryDirname = require("path").resolve(__dirname, "..");
const path = require("path");
const hudIconRuntime = require(path.join(
  runtimeEntryDirname,
  "./modules/hudIconRuntime",
));
const jammerModuleRuntime = require(path.join(
  runtimeEntryDirname,
  "./modules/jammerModuleRuntime",
));
const {
  isReadyForDestiny,
} = require("./destinyDeliveryEligibility");
const {
  toFiniteNumber,
  toInt,
} = require("../../common/numbers");
const {
  RUNTIME_TICK_INTERVAL_MS,
} = require("./runtimeClock");
const {
  resolveSessionNotificationFileTime,
} = require("./sessionNotificationTime");

const HOSTILE_JAM_REFRESH_GRACE_MS = RUNTIME_TICK_INTERVAL_MS;

const ASSISTANCE_JAM_REFRESH_GRACE_MS = RUNTIME_TICK_INTERVAL_MS;

// Only explicitly routed sessionless fighter HUD state uses this delivery ledger.
// It is transient: never persisted, and an expired/replaced state releases its
// recipient with the state itself. Ship HUD delivery keeps its existing path.
const deliveredFighterHudRecipients = new WeakMap();

function usesControlledFighterHudRecipient(targetEntity, options) {
  return targetEntity?.kind === "fighter" && !targetEntity.session &&
    options && Object.prototype.hasOwnProperty.call(options, "recipientSession");
}

function fighterHudDeliveryIdentity(session) {
  if (!session || !isReadyForDestiny(session)) return null;
  return { session, space: session._space,
    shipID: toInt(session._space.shipID || session.shipID || session.shipid, 0) };
}

function sameFighterHudRecipient(left, right) {
  return Boolean(left && right && left.session === right.session &&
    left.space === right.space && left.shipID === right.shipID);
}

function refreshControlledFighterHudRecipient(state, previousState, recipientSession, nowMs, effectState) {
  const previous = previousState ? deliveredFighterHudRecipients.get(previousState) : null;
  const current = fighterHudDeliveryIdentity(recipientSession);
  const sameRecipient = sameFighterHudRecipient(previous, current);
  if (previousState) deliveredFighterHudRecipients.delete(previousState);
  if (previous && !sameRecipient && isReadyForDestiny(previous.session)) {
    notifyHostileHudStateToSession(previous.session, previousState, false, { startTimeMs: nowMs });
  }
  if (!current) return;
  const delivered = notifyHostileHudStateToSession(current.session, state, true, {
    startTimeMs: nowMs,
    durationMs: resolveHostileJamRefreshDurationMs(effectState),
    refreshTimerOnly: sameRecipient,
  });
  if (sameRecipient || delivered) deliveredFighterHudRecipients.set(state, current);
}

function endControlledFighterHudRecipient(removedState, nowMs) {
  if (!removedState) return;
  const previous = deliveredFighterHudRecipients.get(removedState);
  deliveredFighterHudRecipients.delete(removedState);
  if (previous && isReadyForDestiny(previous.session)) {
    notifyHostileHudStateToSession(previous.session, removedState, false, { startTimeMs: nowMs });
  }
}

function hasAssistanceJamState(effectState) {
  return Boolean(
    effectState &&
      effectState.assistanceModuleEffect === true &&
      typeof effectState.assistanceJammingType === "string" &&
      effectState.assistanceJammingType.trim() !== "" &&
      toInt(effectState.targetID, 0) > 0,
  );
}

function resolveAssistanceJamDurationMs(effectState, nowMs = null) {
  const fallbackDurationMs =
    Math.max(1, toInt(effectState && effectState.durationMs, 1000)) +
    ASSISTANCE_JAM_REFRESH_GRACE_MS;
  if (nowMs === null || nowMs === undefined) {
    return fallbackDurationMs;
  }

  const remainingCycleMs = Math.max(
    1,
    toInt(effectState && effectState.nextCycleAtMs, 0) - toInt(nowMs, 0),
  );
  return remainingCycleMs + ASSISTANCE_JAM_REFRESH_GRACE_MS;
}

function buildAssistanceHudState(targetEntity, sourceEntity, effectState, nowMs) {
  return hudIconRuntime.buildAssistanceHudIconState(
    targetEntity,
    sourceEntity,
    effectState,
    nowMs,
  );
}

function hasHostileJamState(effectState) {
  return Boolean(
    effectState &&
      effectState.hostileModuleEffect === true &&
      typeof effectState.hostileJammingType === "string" &&
      effectState.hostileJammingType.trim() !== "" &&
      toInt(effectState.targetID, 0) > 0,
  );
}

function resolveHostileJamDurationMs(effectState, nowMs = null) {
  const fallbackDurationMs =
    Math.max(1, toInt(effectState && effectState.durationMs, 1000)) +
    HOSTILE_JAM_REFRESH_GRACE_MS;
  if (nowMs === null || nowMs === undefined) {
    return fallbackDurationMs;
  }

  const remainingCycleMs = Math.max(
    1,
    toInt(effectState && effectState.nextCycleAtMs, 0) - toInt(nowMs, 0),
  );
  return remainingCycleMs + HOSTILE_JAM_REFRESH_GRACE_MS;
}

function resolveHostileJamRefreshDurationMs(effectState) {
  return (
    Math.max(1, toInt(effectState && effectState.durationMs, 1000)) +
    HOSTILE_JAM_REFRESH_GRACE_MS
  );
}

function buildHostileHudState(targetEntity, sourceEntity, effectState, nowMs) {
  return hudIconRuntime.buildHostileHudIconState(
    targetEntity,
    sourceEntity,
    effectState,
    nowMs,
  );
}

function applyHostileHudCycle(targetEntity, sourceEntity, effectState, nowMs, options = {}) {
  const hudState = buildHostileHudState(targetEntity, sourceEntity, effectState, nowMs);
  if (!targetEntity || !hudState) {
    return null;
  }
  const { state, previousState } = hudIconRuntime.upsertHudIconState(targetEntity, hudState);
  if (usesControlledFighterHudRecipient(targetEntity, options)) {
    refreshControlledFighterHudRecipient(state, previousState, options.recipientSession, nowMs, effectState);
    return state;
  }
  const targetSession = targetEntity.session || options.recipientSession || null;
  if (targetSession && isReadyForDestiny(targetSession)) {
    notifyHostileHudStateToSession(targetSession, state, true, {
      startTimeMs: nowMs,
      // This entry point starts a new cycle; fighters do not carry a fitted
      // module's nextCycleAtMs. Every timer covers the full cycle plus grace.
      durationMs: resolveHostileJamRefreshDurationMs(effectState),
      // An unpruned record still represents the client's tactical icon, even
      // at its cycle boundary. Leave other sources' expiry to the expiry pass.
      refreshTimerOnly: Boolean(previousState),
    });
  }
  return state;
}

function removeHostileHudState(targetEntity, sourceEntity, effectState, nowMs, options = {}) {
  if (!targetEntity) {
    return null;
  }
  const removedState = hudIconRuntime.removeHudIconState(
    targetEntity,
    buildHostileHudState(targetEntity, sourceEntity, effectState, nowMs),
  );
  if (usesControlledFighterHudRecipient(targetEntity, options)) {
    endControlledFighterHudRecipient(removedState, nowMs);
    return removedState;
  }
  const targetSession = targetEntity.session || options.recipientSession || null;
  if (removedState && targetSession && isReadyForDestiny(targetSession)) {
    notifyHostileHudStateToSession(targetSession, removedState, false, {
      startTimeMs: nowMs,
    });
  }
  return removedState;
}

function hasJammerHudState(effectState) {
  return Boolean(
    effectState &&
      effectState.jammerModuleEffect === true &&
      typeof effectState.hostileJammingType === "string" &&
      effectState.hostileJammingType.trim() !== "" &&
      toInt(effectState.targetID, 0) > 0,
  );
}

function resolveJammerJamDurationMs(effectState, nowMs = null) {
  const explicitJamDurationMs = Math.max(
    0,
    toInt(effectState && effectState.jamDurationMs, 0),
  );
  const fallbackDurationMs = Math.max(
    1,
    explicitJamDurationMs || toInt(effectState && effectState.durationMs, 1000),
  );
  if (nowMs === null || nowMs === undefined) {
    return fallbackDurationMs;
  }

  if (explicitJamDurationMs > 0) {
    return explicitJamDurationMs;
  }

  // A jam lasts until the next cycle. At a cycle boundary the next cycle is
  // not scheduled yet, so the jam runs the whole cycle (TQ: 20000.0 for a
  // 20 s ECM, TheBlockadeLevel1).
  const untilNextCycleMs =
    toInt(effectState && effectState.nextCycleAtMs, 0) - toInt(nowMs, 0);
  return untilNextCycleMs > 0 ? untilNextCycleMs : fallbackDurationMs;
}

function buildJammerHudState(targetEntity, sourceEntity, effectState, nowMs) {
  return hudIconRuntime.buildJammerHudIconState(
    targetEntity,
    sourceEntity,
    effectState,
    nowMs,
  );
}

function applyJammerCyclePresentation(
  scene,
  sourceEntity,
  effectState,
  nowMs,
  cycleResult,
) {
  if (!scene || !sourceEntity || !effectState || !cycleResult || !cycleResult.data) {
    return {
      targetEntity: null,
      targetSession: null,
      jamApplied: false,
      previousJamApplied: false,
    };
  }

  const targetEntity =
    cycleResult.data.targetEntity
      ? cycleResult.data.targetEntity
      : scene.getEntityByID(toInt(effectState.targetID, 0));
  const targetSession =
    targetEntity && targetEntity.session
      ? targetEntity.session
      : null;
  const previousJamApplied = Boolean(cycleResult.data.previousJamApplied === true);
  const jamApplied = Boolean(cycleResult.data.jamApplied === true);
  const hudSyncResult =
    targetEntity && jamApplied
      ? hudIconRuntime.upsertHudIconState(
        targetEntity,
        buildJammerHudState(targetEntity, sourceEntity, effectState, nowMs),
      )
      : { state: null };

  if (targetSession && isReadyForDestiny(targetSession)) {
    if (jamApplied && hudSyncResult.state) {
      notifyHostileHudStateToSession(targetSession, hudSyncResult.state, true, {
        startTimeMs: nowMs,
        durationMs: resolveJammerJamDurationMs(effectState, nowMs),
        refreshTimerOnly: previousJamApplied,
      });
    } else if (previousJamApplied && hasJammerHudState(effectState) && targetEntity) {
      // Remove the state as the jam ends, so the expiry tick does not end it
      // a second time (TQ sends one OnJamEnd).
      const removedHudState = hudIconRuntime.removeHudIconState(
        targetEntity,
        buildJammerHudState(targetEntity, sourceEntity, effectState, nowMs),
      );
      if (removedHudState) {
        notifyHostileHudStateToSession(targetSession, removedHudState, false, {
          startTimeMs: nowMs,
        });
      }
    }
  }

  return {
    targetEntity,
    targetSession,
    jamApplied,
    previousJamApplied,
  };
}

function removeJammerCyclePresentation(
  scene,
  sourceEntity,
  effectState,
  nowMs,
) {
  if (!scene || !sourceEntity || !effectState) {
    return {
      targetEntity: null,
      targetSession: null,
      removedHudState: null,
      removalResult: null,
    };
  }

  const targetEntity = scene.getEntityByID(toInt(effectState.targetID, 0));
  const targetSession = targetEntity && targetEntity.session ? targetEntity.session : null;
  const removalResult = jammerModuleRuntime.removeJammerModuleState({
    targetEntity,
    sourceEntity,
    effectState,
    nowMs,
  });
  // A jammer stopped mid-cycle leaves the icon up until the cycle ends.
  const removedHudState = targetEntity
    ? hudIconRuntime.releaseHudIconStateAtCycleEnd(
      targetEntity,
      buildJammerHudState(targetEntity, sourceEntity, effectState, nowMs),
      scene.getCurrentSimTimeMs(),
    )
    : null;
  if (targetSession && isReadyForDestiny(targetSession) && removedHudState) {
    notifyHostileHudStateToSession(targetSession, removedHudState, false, {
      startTimeMs: nowMs,
    });
  }
  return {
    targetEntity,
    targetSession,
    removedHudState,
    removalResult,
  };
}

function resolveHudStateDurationMs(hudState, nowMs = null) {
  const resolvedNowMs =
    nowMs === null || nowMs === undefined
      ? Date.now()
      : toFiniteNumber(nowMs, Date.now());
  return Math.max(
    1,
    toInt(
      toFiniteNumber(hudState && hudState.expiresAtMs, 0) - resolvedNowMs,
      1,
    ),
  );
}

// The direct HUD notification OnRefreshBuffBar goes through `send`: at once
// by default; a SetState's reseed defers it until its batch has left
// (scene/presentation.js).
function sendNow(session, name, idType, args) {
  session.sendNotification(name, idType, args);
}

function notifyRefreshBuffBarToSession(session, send = sendNow) {
  if (
    !session ||
    typeof session.sendNotification !== "function" ||
    (session.socket && session.socket.destroyed)
  ) {
    return false;
  }

  send(session, "OnRefreshBuffBar", "clientID", []);
  return true;
}

function notifyHudJamStateToSession(
  session,
  hudState,
  active,
  options = {},
) {
  if (
    !session ||
    typeof session.sendNotification !== "function" ||
    !hudState ||
    (session.socket && session.socket.destroyed)
  ) {
    return false;
  }

  const sourceBallID = toInt(hudState.sourceBallID, 0);
  const moduleID = toInt(hudState.moduleID, 0);
  const targetBallID = toInt(hudState.targetBallID, 0);
  const jammingType = String(hudState.jammingType || "").trim();
  if (sourceBallID <= 0 || moduleID <= 0 || targetBallID <= 0 || jammingType === "") {
    return false;
  }

  if (active === true) {
    const startTimeMs =
      options.startTimeMs === undefined || options.startTimeMs === null
        ? toFiniteNumber(hudState.startedAtMs, Date.now())
        : toFiniteNumber(options.startTimeMs, Date.now());
    queueDogmaEvent(session, "OnJamStart", [
      sourceBallID,
      moduleID,
      targetBallID,
      jammingType,
      resolveSessionNotificationFileTime(session, startTimeMs),
      Math.max(
        1,
        toInt(
          options.durationMs,
          resolveHudStateDurationMs(hudState, startTimeMs),
        ),
      ),
    ]);
    return true;
  }

  // TQ never sends OnJamEnd: the client ends each jam itself when the
  // duration in OnJamStart runs out (godma.py StopJam). Golden logs
  // TheBlockadeLevel1, "Minmatar - Tutorial - Career missions part 1" and
  // "Interstellar Railroad (4 of 4)": 17 packed OnJamStart, no packed
  // OnJamEnd, every OnJamEnd a client ScatterEvent. Sending one too made the
  // client end each jam twice.
  return false;
}

// OnEwarStart and OnEwarEnd are Dogma events: TQ packs both into the
// DoDestinyUpdate or OnMultiEvent event list and never sends them alone
// (golden logs TheBlockadeLevel1, The Seven's Brothel, "Minmatar - Tutorial -
// Career missions part 1": 15 starts and 14 ends, all packed).
function notifyHudEwarStateToSession(session, hudState, active) {
  if (
    !session ||
    typeof session.sendNotification !== "function" ||
    !hudState ||
    (session.socket && session.socket.destroyed)
  ) {
    return false;
  }

  if (
    !hudState.deliveryProfile ||
    hudState.deliveryProfile.usesTacticalEwar !== true
  ) {
    return false;
  }

  const sourceBallID = toInt(hudState.sourceBallID, 0);
  const moduleID = toInt(hudState.moduleID, 0);
  const targetBallID = toInt(hudState.targetBallID, 0);
  const jammingType = String(hudState.jammingType || "").trim();
  if (sourceBallID <= 0 || moduleID <= 0 || targetBallID <= 0 || jammingType === "") {
    return false;
  }

  queueDogmaEvent(session, active === true ? "OnEwarStart" : "OnEwarEnd", [
    sourceBallID,
    moduleID,
    targetBallID,
    jammingType,
  ]);
  return true;
}

function notifyHudIconStateToSession(
  session,
  hudState,
  active,
  options = {},
) {
  if (!hudState) {
    return false;
  }

  let delivered = false;
  if (hudState.deliveryProfile && hudState.deliveryProfile.usesJamTimer === true) {
    delivered = notifyHudJamStateToSession(session, hudState, active, options) || delivered;
  }
  if (
    hudState.deliveryProfile &&
    hudState.deliveryProfile.usesTacticalEwar === true &&
    options.refreshTimerOnly !== true
  ) {
    delivered = notifyHudEwarStateToSession(session, hudState, active) || delivered;
  }
  if (delivered && options.refreshBuffBar !== false) {
    notifyRefreshBuffBarToSession(session, options.send);
  }
  return delivered;
}

function notifyHudIconStatesToSession(
  scene,
  session,
  egoEntity,
  options = {},
) {
  if (!scene || !session || !egoEntity || !isReadyForDestiny(session)) {
    return 0;
  }

  const deliveryTimeMs =
    options.nowMs === null || options.nowMs === undefined
      ? scene.getCurrentSimTimeMs()
      : toFiniteNumber(options.nowMs, scene.getCurrentSimTimeMs());
  const kind = options.kind ? String(options.kind) : null;
  let delivered = 0;
  for (const hudState of hudIconRuntime.listActiveHudIconStates(
    egoEntity,
    deliveryTimeMs,
    kind ? { kind } : {},
  )) {
    if (notifyHudIconStateToSession(session, hudState, true, {
      startTimeMs: deliveryTimeMs,
      durationMs: resolveHudStateDurationMs(hudState, deliveryTimeMs),
      send: options.send,
    })) {
      delivered += 1;
    }
  }
  return delivered;
}

function notifyAssistanceHudStateToSession(
  session,
  hudState,
  active,
  options = {},
) {
  return notifyHudIconStateToSession(session, hudState, active, {
    ...options,
    refreshBuffBar:
      options.refreshBuffBar === undefined ? false : options.refreshBuffBar,
  });
}

function notifyHostileHudStateToSession(
  session,
  hudState,
  active,
  options = {},
) {
  return notifyHudIconStateToSession(session, hudState, active, {
    ...options,
    refreshBuffBar:
      options.refreshBuffBar === undefined ? false : options.refreshBuffBar,
  });
}

function notifyActiveAssistanceJamStatesToSession(
  scene,
  session,
  egoEntity,
  _visibleEntities = [],
  nowMs = null,
  options = {},
) {
  return notifyHudIconStatesToSession(scene, session, egoEntity, {
    nowMs,
    kind: hudIconRuntime.HUD_ICON_KIND_ASSISTANCE,
    send: options.send,
  });
}

function notifyActiveHostileJamStatesToSession(
  scene,
  session,
  egoEntity,
  _visibleEntities = [],
  nowMs = null,
  options = {},
) {
  const hostile = notifyHudIconStatesToSession(scene, session, egoEntity, {
    nowMs,
    kind: hudIconRuntime.HUD_ICON_KIND_HOSTILE,
    send: options.send,
  });
  // Persistent environmental EWAR has no module-cycle jam timer, but must
  // also be restored after SetState or a ship swap resets the client's HUD.
  return hostile + notifyHudIconStatesToSession(scene, session, egoEntity, {
    nowMs,
    kind: hudIconRuntime.HUD_ICON_KIND_FIELD,
    send: options.send,
  });
}

function tickHudIconStateExpiries(scene, nowMs) {
  if (!scene || !(scene.sessions instanceof Map) || scene.sessions.size <= 0) {
    return 0;
  }

  let delivered = 0;
  const resolvedNowMs = Math.max(0, toFiniteNumber(nowMs, Date.now()));
  for (const session of scene.sessions.values()) {
    if (!session || !isReadyForDestiny(session)) {
      continue;
    }
    const egoEntity = scene.getShipEntityForSession(session);
    if (!egoEntity) {
      continue;
    }
    const pruneResult = hudIconRuntime.pruneExpiredHudIconStates(
      egoEntity,
      resolvedNowMs,
    );
    for (const removedHudState of pruneResult.removed) {
      if (
        String(removedHudState && removedHudState.jammingType || "") ===
          jammerModuleRuntime.ECM_JAMMING_TYPE
      ) {
        jammerModuleRuntime.recomputeEntityJammedState(egoEntity, resolvedNowMs);
      }
      if (notifyHudIconStateToSession(session, removedHudState, false, {
        startTimeMs: resolvedNowMs,
      })) {
        delivered += 1;
      }
    }
  }
  return delivered;
}

Object.assign(module.exports, {
  ASSISTANCE_JAM_REFRESH_GRACE_MS,
  HOSTILE_JAM_REFRESH_GRACE_MS,
});
