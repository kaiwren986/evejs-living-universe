"use strict";

const {
  tagUpdatesMissileLifecycleGroup,
  tagUpdatesOwnerMissileLifecycleGroup,
} = require("../dispatch/dispatchUtils");
const {
  normalizePersistentEntityID,
} = require("../identity/entityID");
const {
  normalizeDestinyStamp,
} = require("../delivery/stamps");
const {
  isTargetedLiveMissile,
} = require("../stream/ballEncoding");
const {
  resolveFreshAcquireBootstrapModeUpdates,
  stripMissileFreshAcquireModeReplayUpdates,
} = require("./freshAcquire");

function requireUpdates(result, label) {
  if (!Array.isArray(result)) {
    throw new TypeError(`${label} must return an array`);
  }
  return result;
}

function resolveExplicitBallInteractiveState(entity) {
  if (!entity || typeof entity !== "object") {
    return null;
  }
  if (entity.suppressBallInteractiveUpdate === true) {
    return null;
  }
  if (
    entity.ballInteractive === true ||
    entity.dungeonMaterializedGate === true ||
    entity.kind === "siteAccelerationGate"
  ) {
    return true;
  }
  if (entity.ballInteractive === false) {
    return false;
  }
  return null;
}

function buildBallInteractiveUpdatesForEntities(options = {}) {
  const entities = Array.isArray(options.entities) ? options.entities : [];
  const stamp = normalizeDestinyStamp(options.stamp, 0);
  const interactiveStates = entities
    .map((entity) => ({
      entityID: normalizePersistentEntityID(entity && entity.itemID),
      isInteractive: resolveExplicitBallInteractiveState(entity),
    }))
    .filter(({ entityID, isInteractive }) => (
      entityID !== null && isInteractive !== null
    ));
  if (interactiveStates.length === 0) {
    return [];
  }
  if (typeof options.buildSetBallInteractivePayload !== "function") {
    throw new TypeError(
      "interactive AddBalls presentation requires buildSetBallInteractivePayload",
    );
  }
  return interactiveStates.map(({ entityID, isInteractive }) => ({
    stamp,
    payload: options.buildSetBallInteractivePayload(entityID, isInteractive),
  }));
}

function buildInitialBootstrapAddBallsPresentationUpdate(options = {}) {
  const stamp = normalizeDestinyStamp(options.stamp, 0);
  const entities = Array.isArray(options.entities) ? options.entities : [];
  if (typeof options.buildAddBalls2Payload !== "function") {
    throw new TypeError(
      "initial bootstrap AddBalls presentation requires buildAddBalls2Payload",
    );
  }
  return {
    stamp,
    payload: options.buildAddBalls2Payload(
      stamp,
      entities,
      options.simFileTime ?? 0,
    ),
  };
}

function buildInitialBootstrapSetStatePresentationUpdate(options = {}) {
  const stamp = normalizeDestinyStamp(options.stamp, 0);
  const entities = Array.isArray(options.entities) ? options.entities : [];
  if (typeof options.buildSetStatePayload !== "function") {
    throw new TypeError(
      "initial bootstrap SetState presentation requires buildSetStatePayload",
    );
  }
  return {
    stamp,
    payload: options.buildSetStatePayload(
      stamp,
      options.system,
      options.egoEntityID,
      entities,
      options.simFileTime ?? 0,
      Array.isArray(options.dbuffStateEntries)
        ? options.dbuffStateEntries
        : [],
      Array.isArray(options.effectStateEntries)
        ? options.effectStateEntries
        : [],
    ),
  };
}

// The LaunchMissile that follows a missile's add, on its launch tick only:
// the add stamped with the missile's effect stamp, applied with the
// launch in that tick's doPreTick. On the client LaunchMissile is the native
// PyLaunchMissile (carbon-destiny v2.1.1 Thunkers.cpp L855-L944), which puts
// the missile back at its launcher and resets its effect stamp; the ball
// record already carries its target, owner and effect stamp (L3037-L3048),
// and retail's bubble add is the record alone. So an Observer that acquires
// a missile already moved by an Evolve continues it from where it is.
function buildMissileLaunchActionUpdates(options = {}) {
  const entities = Array.isArray(options.entities) ? options.entities : [];
  const missileEntities = entities.filter(
    (entity) => entity && entity.kind === "missile",
  );
  if (missileEntities.length === 0) {
    return [];
  }
  if (typeof options.buildLaunchMissilePayload !== "function") {
    throw new TypeError(
      "missile AddBalls presentation requires buildLaunchMissilePayload",
    );
  }

  const stamp = normalizeDestinyStamp(options.stamp, 0);
  const updates = [];
  for (const entity of missileEntities) {
    if (!isTargetedLiveMissile(entity)) {
      continue;
    }
    const launchTick = Number(entity.effectStamp);
    if (!Number.isFinite(launchTick) || stamp > launchTick) {
      continue;
    }
    const entityID = normalizePersistentEntityID(entity.itemID);
    const targetID = normalizePersistentEntityID(entity.targetEntityID);
    const ownerID = normalizePersistentEntityID(entity.sourceShipID);
    // An invalidated deferred snapshot is intentionally targetless GOTO/FREE.
    // It materializes without a stale LaunchMissile action.
    if (entityID === null || targetID === null || ownerID === null) {
      continue;
    }
    updates.push({
      stamp,
      payload: options.buildLaunchMissilePayload(entityID, targetID, ownerID),
    });
  }
  return updates;
}

function buildAddBallsPresentationUpdates(options = {}) {
  const stamp = normalizeDestinyStamp(options.stamp, 0);
  const entities = Array.isArray(options.entities) ? options.entities : [];
  if (typeof options.buildAddBalls2Payload !== "function") {
    throw new TypeError(
      "buildAddBallsPresentationUpdates requires buildAddBalls2Payload",
    );
  }
  if (typeof options.buildPrimeUpdatesForEntities !== "function") {
    throw new TypeError(
      "buildAddBallsPresentationUpdates requires buildPrimeUpdatesForEntities",
    );
  }
  if (typeof options.buildModeUpdates !== "function") {
    throw new TypeError(
      "buildAddBallsPresentationUpdates requires buildModeUpdates",
    );
  }
  if (
    options.replayActiveSpecialFx === true &&
    typeof options.buildActiveSpecialFxReplayUpdates !== "function"
  ) {
    throw new TypeError(
      "active FX AddBalls presentation requires buildActiveSpecialFxReplayUpdates",
    );
  }
  const buildPrimeUpdatesForEntities = options.buildPrimeUpdatesForEntities;
  const buildModeUpdates = options.buildModeUpdates;
  const buildActiveSpecialFxReplayUpdates =
    options.buildActiveSpecialFxReplayUpdates;

  const addBallsUpdate = {
    stamp,
    payload: options.buildAddBalls2Payload(
      stamp,
      entities,
      options.simFileTime || 0,
    ),
  };

  let updates = [addBallsUpdate];
  updates.push(...buildBallInteractiveUpdatesForEntities({
    entities,
    stamp,
    buildSetBallInteractivePayload: options.buildSetBallInteractivePayload,
  }));
  updates.push(...requireUpdates(
    buildPrimeUpdatesForEntities(entities, stamp),
    "buildPrimeUpdatesForEntities",
  ));

  const modeUpdates = [];
  for (const entity of entities) {
    modeUpdates.push(...requireUpdates(
      buildModeUpdates(entity, stamp),
      "buildModeUpdates",
    ));
  }
  const bootstrapModeUpdates = resolveFreshAcquireBootstrapModeUpdates(
    entities,
    modeUpdates,
  );
  if (bootstrapModeUpdates.length > 0) {
    updates.push(...bootstrapModeUpdates);
  }

  if (options.replayActiveSpecialFx === true) {
    const activeSpecialFxReplayUpdates = requireUpdates(
      buildActiveSpecialFxReplayUpdates(
        entities,
        stamp,
        options.presentationRawSimTimeMs,
        {
          scene: options.scene || null,
          session: options.session || null,
        },
      ),
      "buildActiveSpecialFxReplayUpdates",
    );
    updates.push(...activeSpecialFxReplayUpdates);
  }

  // On its launch tick a missile's add is followed by its LaunchMissile, the
  // final dependent action on the same stamp; a missile acquired in flight
  // flies on from its ball record.
  updates.push(...buildMissileLaunchActionUpdates({
    buildLaunchMissilePayload: options.buildLaunchMissilePayload,
    entities,
    stamp,
  }));

  const containsFreshAcquireMissiles = entities.some(
    (entity) => entity && entity.kind === "missile",
  );
  if (containsFreshAcquireMissiles) {
    updates = tagUpdatesMissileLifecycleGroup(updates);
    updates = stripMissileFreshAcquireModeReplayUpdates(entities, updates);
    if (options.containsOwnerLaunchedMissiles === true) {
      updates = tagUpdatesOwnerMissileLifecycleGroup(updates);
    }
  }

  return {
    containsFreshAcquireMissiles,
    updates,
  };
}

module.exports = {
  buildAddBallsPresentationUpdates,
  buildBallInteractiveUpdatesForEntities,
  buildInitialBootstrapAddBallsPresentationUpdate,
  buildInitialBootstrapSetStatePresentationUpdate,
};
