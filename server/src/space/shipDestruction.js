"use strict";

const {
  toFiniteNumber,
} = require("../common/numbers");

const path = require("path");

const log = require(path.join(__dirname, "../utils/logger"));
const { random } = require(path.join(__dirname, "../common/random"));
const spaceRuntime = require(path.join(__dirname, "./runtime"));
const spatialTrace = require(path.join(__dirname, "../network/spatialTrace"));
const {
  ejectSessionForShipDestruction,
  rebuildDockedSessionAtStation,
  repairSameSceneSessionViewState,
} = require(path.join(__dirname, "./transitions"));
const {
  getEntityMapKey,
} = require(path.join(__dirname, "./destiny/identity/entityID"));
const {
  buildChildEntityScopeMetadata,
} = require(path.join(
  __dirname,
  "./destiny/identity/interactionScope.js",
));
const {
  ITEM_FLAGS,
  createSpaceItemForOwner,
  findShipItemById,
  isCapsuleTypeID,
  removeInventoryItem,
} = require(path.join(__dirname, "../services/inventory/itemStore"));
const {
  emitFittingTransactionForSession,
  emitItemsChangedBatchForSession,
  getCharacterRecord,
  getActiveShipRecord,
} = require(path.join(__dirname, "../services/character/characterState"));
const {
  getSpaceDebrisLifetimeMs,
} = require(path.join(__dirname, "../services/inventory/spaceDebrisState"));
const {
  resolveLocationDeathOutcome,
  prepareLocationDeathOutcome,
  applyPreparedLocationDeathOutcome,
} = require(path.join(__dirname, "../services/killmail/deathOutcomeResolver"));
const itemCustody = require("../services/inventory/itemCustody");
const deathItemCustody = require("../services/inventory/deathItemCustody");
const { getWallclockNowMs, toFileTimeFromMs } = require("./runtime/runtimeClock");
const {
  resolveShipByTypeID,
} = require(path.join(__dirname, "../services/chat/shipTypeRegistry"));
const {
  buildDunRotationFromDirection,
  resolveEntityWreckType,
  resolveShipWreckType,
} = require(path.join(__dirname, "./wreckUtils"));
const {
  resolveCorpseType,
} = require(path.join(__dirname, "./corpseUtils"));
const {
  LOOT_CUSTOM_INFO_KEY,
  buildSpaceLootRightsSnapshot,
  resolveCharacterSpaceLootContext,
} = require(path.join(
  __dirname,
  "../services/_shared/spaceLootEntitlement",
));

const DEFAULT_DEATH_TEST_COUNT = 6;
const DEFAULT_DEATH_TEST_RADIUS_METERS = 20_000;
const DEFAULT_DEATH_TEST_DELAY_MS = 2_000;
const DESTRUCTION_EFFECT_EXPLOSION = 3;

const pendingDeathTests = new Map();
let nextPendingDeathTestID = 1;
let pendingDeathTestTimer = null;

function prepareDurableShipDeath(shipEntity, shipRecord, key, scene, session) {
  const capsule = isCapsuleTypeID(shipRecord.typeID);
  const suppressWreck = !capsule && scene.sceneKind === "abyssal";
  const pilotCharacterID = Number(shipEntity.pilotCharacterID || shipEntity.characterID ||
    session?.characterID || shipRecord.ownerID);
  const character = require("../services/character/characterState").peekCharacterRecord(pilotCharacterID) || {};
  const debrisType = capsule ? resolveCorpseType(character.gender ?? character.genderID)
    : resolveShipWreckType(shipEntity.typeID);
  if (!debrisType) throw new Error(capsule ? "CORPSE_TYPE_NOT_FOUND" : "WRECK_TYPE_NOT_FOUND");
  const now = scene.getCurrentSimTimeMs();
  const debrisOptions = { ...buildChildEntityScopeMetadata(shipEntity),
    itemName: capsule ? character.characterName || debrisType.name : debrisType.name,
    position: cloneVector(shipEntity.position), direction: normalizeVector(shipEntity.direction, { x: 1, y: 0, z: 0 }),
    velocity: { x: 0, y: 0, z: 0 }, targetPoint: cloneVector(shipEntity.position),
    mode: "STOP", speedFraction: 0, createdAtMs: now,
    expiresAtMs: now + getSpaceDebrisLifetimeMs(), launcherID: shipEntity.itemID,
    dunRotation: buildDunRotationFromDirection(shipEntity.direction) };
  if (!capsule) {
    debrisOptions.customInfo = JSON.stringify({ [LOOT_CUSTOM_INFO_KEY]:
      buildSpaceLootRightsSnapshot(resolveCharacterSpaceLootContext(pilotCharacterID, {
        session, characterRecord: character,
        corporationID: shipEntity.corporationID, allianceID: shipEntity.allianceID,
        warFactionID: shipEntity.warFactionID })) });
    debrisOptions.spaceRadius = toFiniteNumber(shipEntity.radius, 0);
    debrisOptions.conditionState = { damage: 0, charge: 1, armorDamage: 0, shieldCharge: 0, incapacitated: false };
  }
  return { key, capsule, suppressWreck, shipRecord, pilotCharacterID, debrisTypeID: debrisType.typeID,
    systemID: scene.systemID, sceneDescriptor: scene.sceneDescriptor,
    debrisOptions, homeStationID: capsule ? resolvePodRespawnStationID(session) : null,
    destroyedAtFiletime: String(toFileTimeFromMs(getWallclockNowMs())),
    victimCorporationID: character.corporationID || null, victimAllianceID: character.allianceID || null,
    loot: prepareLocationDeathOutcome(shipRecord.itemID, { seed: key, forceAllDestroyed: capsule || suppressWreck }) };
}

function createPreparedDeathDebris(plan) {
  const result = itemCustody.transfer({ to: itemCustody.custodyRef.inSpace(
    plan.shipRecord.ownerID, plan.systemID), actor: plan.shipRecord.ownerID,
    reason: itemCustody.CUSTODY_REASON.DEATH_DEBRIS_CREATE,
    items: { typeID: plan.debrisTypeID, quantity: 1, options: plan.debrisOptions },
    idempotencyKey: `${plan.key}:debris` });
  if (!result.success) return result;
  const itemID = Number(result.data.item?.itemID || result.data.receipt?.resultData?.itemIDs?.[0]);
  return { success: true, data: result.data.item || { itemID }, changes: result.data.changes || [] };
}

// Recovery settles inventory and insurance without manufacturing a new scene
// or running another pilot ship swap. The same custody receipts are used by
// the normal, visible destruction path below.
function settleDurableShipDeath(plan) {
  const debris = plan.suppressWreck ? { success: true, data: { itemID: null } } : createPreparedDeathDebris(plan);
  if (!debris.success) return debris;
  const outcome = applyPreparedLocationDeathOutcome(plan.loot, debris.data.itemID);
  if (!outcome.success) return outcome;
  const removed = deathItemCustody.destroyItem({ item: plan.shipRecord, operationID: plan.key });
  if (!removed.success) return removed;
  const insurance = require("../services/insurance/insuranceRuntime").handleShipDestroyed({
    shipID: plan.shipRecord.itemID, typeID: plan.shipRecord.typeID,
    ownerID: plan.shipRecord.ownerID, ownerCharacterID: plan.pilotCharacterID || plan.shipRecord.ownerID,
    pilotCharacterID: plan.pilotCharacterID || plan.shipRecord.ownerID, solarSystemID: plan.systemID,
    lossID: plan.key, destroyedAtFiletime: plan.destroyedAtFiletime });
  if (!insurance.success) return insurance;
  return { success: true, data: { debrisID: debris.data.itemID, lootOutcome: outcome.data } };
}

function finishDurableShipDeathHandoff(plan) {
  const pilotCharacterID = plan.pilotCharacterID || plan.shipRecord.ownerID;
  // Corporate custody and pilot authority are separate. Reading a corporate
  // hull through the character-owned inventory helper can provision a spare
  // ship before this accepted death hands its actual pilot into a capsule.
  const activeShipID = pilotCharacterID !== plan.shipRecord.ownerID
    ? require("../services/character/characterState").peekCharacterRecord(pilotCharacterID)?.shipID
    : getActiveShipRecord(pilotCharacterID)?.itemID;
  if (plan.capsule || Number(activeShipID) !== Number(plan.shipRecord.itemID))
    return { success: true };
  const store = require("../services/inventory/itemStore");
  const capsule = store.ensureCapsuleForCharacter(pilotCharacterID, plan.systemID);
  if (!capsule.success) return capsule;
  const moved = store.moveShipToSpace(capsule.data.itemID, plan.systemID, {
    ...plan.shipRecord.spaceState, position: plan.debrisOptions.position,
    direction: plan.debrisOptions.direction, velocity: { x: 0, y: 0, z: 0 },
    mode: "STOP", speedFraction: 0 });
  if (!moved.success) return moved;
  return store.setActiveShipForCharacter(pilotCharacterID, moved.data.itemID);
}

function finishDurablePodDeath(plan, liveSession = null) {
  const characterID = plan.pilotCharacterID || plan.shipRecord.ownerID;
  const record = getCharacterRecord(characterID);
  const docked = Number(record.stationID || record.structureID || 0) === Number(plan.homeStationID) &&
    getActiveShipRecord(characterID)?.itemID !== plan.shipRecord.itemID;
  const placement = record.authoredAirTutorial?.encounter?.combat?.deaths?.pod?.homeCloneReceipt;
  const hazardPlacement = plan.durablePodDeathKey && record.durablePodDeathReceipts?.[plan.durablePodDeathKey]?.placement;
  const placed = plan.airDeathKey ? placement?.key === plan.airDeathKey : Boolean(hazardPlacement);
  // This offline continuation is never registered as an in-space pilot. The
  // journal has already authorized the death; station/character owners carry
  // out the same home-clone rebuild used by the live path.
  const session = liveSession || { characterID, shipID: plan.shipRecord.itemID,
    sendNotification() {}, sendSessionChange() {} };
  try {
    // Character normalization can already select a spare docked capsule after
    // the original pod is removed. AIR still needs its explicit clone receipt.
    if (plan.airDeathKey ? !placed : plan.durablePodDeathKey ? !placed && !docked : !docked) {
      const rebuilt = rebuildDockedSessionAtStation(session, plan.homeStationID, {
        emitNotifications: Boolean(liveSession), boardNewbieShip: true, logSelection: false,
        airDeathKey: plan.airDeathKey, durablePodDeathKey: plan.durablePodDeathKey,
        durableRecovery: Boolean(plan.airDeathKey || plan.durablePodDeathKey) });
      if (!rebuilt.success) return rebuilt;
    }
    if (plan.durablePodDeathKey && !hazardPlacement) {
      const characterOwner = require("../services/character/characterState");
      const saved = characterOwner.updateCharacterRecord(characterID, current => {
        current.durablePodDeathReceipts ||= {};
        const receipt = current.durablePodDeathReceipts[plan.durablePodDeathKey] ||= {};
        receipt.placement = { stationID: plan.homeStationID,
          capsuleID: getActiveShipRecord(characterID)?.itemID || null };
        return current;
      });
      if (!saved.success) return saved;
      const flushed = require("../gameStore").flushTableSync("characters");
      if (!flushed.success) return flushed;
    }
    // A crash can commit clone placement before the native corvette provision.
    // Resume only that recorded capsule; never replace a later player-owned hull.
    const replacementCapsuleID = plan.airDeathKey ? placement?.capsuleID : hazardPlacement?.capsuleID;
    if (placed && getActiveShipRecord(characterID)?.itemID === replacementCapsuleID) {
      const applied = require("../services/character/characterState").applyCharacterToSession(session, characterID, { emitNotifications: false });
      if (!applied.success) return applied;
      const boarded = require("../services/dogma/dogmaService").boardNewbieShipForSession(session, {
        emitNotifications: Boolean(liveSession), logSelection: false, durableRecovery: true,
      });
      if (!boarded.success) return boarded;
    }
    return require("../services/station/jumpCloneRuntime").clearActiveImplantsForPodDeath(session, {
      characterID, locationID: plan.systemID, destroyerID: characterID,
      airDeathKey: plan.airDeathKey,
      durableDeathKey: plan.durablePodDeathKey,
      originalImplants: plan.cloneImplants,
      emitNotifications: Boolean(liveSession) });
  } finally {
    if (!liveSession) require("../services/chat/sessionRegistry").deindexCharacterSession(session);
  }
}

function handleInsuranceShipDestroyedSafe(
  systemID,
  shipEntity,
  options = {},
  shipRecord = null,
) {
  if (!shipEntity || shipEntity.kind !== "ship") {
    return null;
  }

  try {
    const insuranceRuntime = require(path.join(
      __dirname,
      "../services/insurance/insuranceRuntime",
    ));
    if (typeof insuranceRuntime.handleShipDestroyed !== "function") {
      return null;
    }
    return insuranceRuntime.handleShipDestroyed({
      shipID: shipEntity.itemID,
      itemID: shipEntity.itemID,
      typeID: shipEntity.typeID,
      ownerID:
        (shipRecord && shipRecord.ownerID) ||
        shipEntity.ownerID ||
        options.ownerID ||
        options.ownerCharacterID,
      ownerCharacterID:
        options.ownerCharacterID ||
        shipEntity.pilotCharacterID ||
        shipEntity.characterID ||
        shipEntity.ownerID,
      pilotCharacterID:
        shipEntity.pilotCharacterID ||
        shipEntity.characterID ||
        options.ownerCharacterID,
      corporationID:
        options.corporationID ||
        shipEntity.corporationID ||
        (shipRecord && shipRecord.corporationID) ||
        0,
      systemID,
      lossID: options.lossID,
      destroyedAtFiletime: options.destroyedAtFiletime,
      attackerEntity: options.attackerEntity || null,
      insuranceSuppressedReason: options.insuranceSuppressedReason || null,
      isConcordLoss: options.isConcordLoss === true,
      skipInsurance: options.skipInsurance === true,
    });
  } catch (error) {
    log.warn(
      `[ShipDestruction] Insurance payout hook failed ship=${shipEntity.itemID}: ${error.message}`,
    );
    return null;
  }
}

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function cloneVector(vector, fallback = { x: 0, y: 0, z: 0 }) {
  return {
    x: toFiniteNumber(vector && vector.x, fallback.x),
    y: toFiniteNumber(vector && vector.y, fallback.y),
    z: toFiniteNumber(vector && vector.z, fallback.z),
  };
}

function addVectors(left, right) {
  return {
    x: toFiniteNumber(left && left.x, 0) + toFiniteNumber(right && right.x, 0),
    y: toFiniteNumber(left && left.y, 0) + toFiniteNumber(right && right.y, 0),
    z: toFiniteNumber(left && left.z, 0) + toFiniteNumber(right && right.z, 0),
  };
}

function scaleVector(vector, scalar) {
  return {
    x: toFiniteNumber(vector && vector.x, 0) * scalar,
    y: toFiniteNumber(vector && vector.y, 0) * scalar,
    z: toFiniteNumber(vector && vector.z, 0) * scalar,
  };
}

function normalizeVector(vector, fallback = { x: 1, y: 0, z: 0 }) {
  const resolved = cloneVector(vector, fallback);
  const length = Math.sqrt(
    (resolved.x ** 2) + (resolved.y ** 2) + (resolved.z ** 2),
  );
  if (!Number.isFinite(length) || length <= 0) {
    return { ...fallback };
  }
  return {
    x: resolved.x / length,
    y: resolved.y / length,
    z: resolved.z / length,
  };
}

function distance(left, right) {
  const dx = toFiniteNumber(left && left.x, 0) - toFiniteNumber(right && right.x, 0);
  const dy = toFiniteNumber(left && left.y, 0) - toFiniteNumber(right && right.y, 0);
  const dz = toFiniteNumber(left && left.z, 0) - toFiniteNumber(right && right.z, 0);
  return Math.sqrt((dx ** 2) + (dy ** 2) + (dz ** 2));
}

function buildRandomDirection(baseDirection) {
  const forward = normalizeVector(baseDirection, { x: 1, y: 0, z: 0 });
  const angle = random() * Math.PI * 2;
  const vertical = (random() - 0.5) * 0.3;
  return normalizeVector({
    x: forward.x + Math.cos(angle),
    y: forward.y + vertical,
    z: forward.z + Math.sin(angle),
  }, forward);
}

function buildShipDeathPositions(anchorEntity, count, radiusMeters) {
  const anchorPosition = cloneVector(anchorEntity && anchorEntity.position);
  const anchorDirection = normalizeVector(
    anchorEntity && anchorEntity.direction,
    { x: 1, y: 0, z: 0 },
  );
  const positions = [];
  const maxRadius = Math.max(3_000, toFiniteNumber(radiusMeters, DEFAULT_DEATH_TEST_RADIUS_METERS));

  for (let index = 0; index < count; index += 1) {
    let accepted = null;
    for (let attempt = 0; attempt < 48; attempt += 1) {
      const direction = buildRandomDirection(anchorDirection);
      const offset = 3_000 + (random() * Math.max(0, maxRadius - 3_000));
      const candidate = addVectors(anchorPosition, scaleVector(direction, offset));
      const collides = positions.some((existing) => distance(existing, candidate) < 1_500);
      if (!collides) {
        accepted = candidate;
        break;
      }
    }
    if (!accepted) {
      break;
    }
    positions.push(accepted);
  }

  return positions;
}

function resolveShipDestructionScene(systemID, shipEntity, options = {}) {
  const entityID = toPositiveInt(shipEntity && shipEntity.itemID, 0);
  const containsExactEntity = (scene) => Boolean(
    scene &&
    entityID > 0 &&
    typeof scene.getEntityByID === "function" &&
    scene.getEntityByID(entityID) === shipEntity
  );

  if (Object.prototype.hasOwnProperty.call(options, "scene")) {
    return containsExactEntity(options.scene) ? options.scene : null;
  }
  if (Object.prototype.hasOwnProperty.call(options, "sceneDescriptor")) {
    if (
      !options.sceneDescriptor ||
      typeof spaceRuntime.getSceneByDescriptor !== "function"
    ) {
      return null;
    }
    const descriptorScene = spaceRuntime.getSceneByDescriptor(options.sceneDescriptor);
    return containsExactEntity(descriptorScene) ? descriptorScene : null;
  }

  // Runtime entity ownership is authoritative when present. Never fall back
  // to the first same-ID scene or a shared numeric host if that exact scene is
  // stale or unavailable.
  const entitySceneKey = String(shipEntity && shipEntity.sceneKey || "").trim();
  if (entitySceneKey) {
    const ownedScene =
      spaceRuntime.scenes && typeof spaceRuntime.scenes.get === "function"
        ? spaceRuntime.scenes.get(entitySceneKey) || null
        : null;
    return containsExactEntity(ownedScene) ? ownedScene : null;
  }
  if (
    shipEntity &&
    typeof spaceRuntime.findSceneContainingDynamicEntity === "function"
  ) {
    const entityScene = spaceRuntime.findSceneContainingDynamicEntity(shipEntity.itemID);
    if (containsExactEntity(entityScene)) {
      return entityScene;
    }
  }
  const numericScene = spaceRuntime.ensureScene(systemID);
  return containsExactEntity(numericScene) ? numericScene : null;
}

function releaseControlledCraftForDestroyedShip(systemID, shipEntity, options = {}) {
  const numericSystemID = toPositiveInt(systemID, 0);
  if (!numericSystemID || !shipEntity || shipEntity.kind !== "ship") {
    return;
  }

  const scene = resolveShipDestructionScene(numericSystemID, shipEntity, options);
  if (!scene) {
    return;
  }

  try {
    const droneRuntime = require(path.join(__dirname, "../services/drone/droneRuntime"));
    if (droneRuntime && typeof droneRuntime.handleControllerLost === "function") {
      droneRuntime.handleControllerLost(scene, shipEntity, {
        lifecycleReason: "ship-destroyed",
        attemptBayRecovery: false,
      });
    }
  } catch (error) {
    log.warn(`[ShipDestruction] Drone cleanup failed for ship=${shipEntity.itemID}: ${error.message}`);
  }

  try {
    const fighterRuntime = require(path.join(__dirname, "../services/fighter/fighterRuntime"));
    if (fighterRuntime && typeof fighterRuntime.handleControllerLost === "function") {
      fighterRuntime.handleControllerLost(scene, shipEntity, {
        lifecycleReason: "ship-destroyed",
        attemptTubeRecovery: false,
      });
    }
  } catch (error) {
    log.warn(`[ShipDestruction] Fighter cleanup failed for ship=${shipEntity.itemID}: ${error.message}`);
  }
}

function clearPendingDeathTestTimer() {
  if (!pendingDeathTestTimer) {
    return;
  }
  clearInterval(pendingDeathTestTimer);
  pendingDeathTestTimer = null;
}

function ensurePendingDeathTestTimer() {
  if (pendingDeathTestTimer) {
    return;
  }
  pendingDeathTestTimer = setInterval(() => {
    try {
      processPendingDeathTests();
    } catch (error) {
      log.warn(`[ShipDestruction] Pending death-test processing failed: ${error.message}`);
    }
  }, 100);
  if (pendingDeathTestTimer && typeof pendingDeathTestTimer.unref === "function") {
    pendingDeathTestTimer.unref();
  }
}

function processPendingDeathTests() {
  if (pendingDeathTests.size <= 0) {
    clearPendingDeathTestTimer();
    return 0;
  }

  let processedCount = 0;
  for (const [pendingID, pending] of [...pendingDeathTests.entries()]) {
    if (!pending) {
      pendingDeathTests.delete(pendingID);
      continue;
    }

    const pendingScene = pending.sceneDescriptor
      ? spaceRuntime.getSceneByDescriptor(pending.sceneDescriptor)
      : spaceRuntime.ensureScene(pending.systemID);
    const currentSimTimeMs = pendingScene
      ? pendingScene.getCurrentSimTimeMs()
      : Number.POSITIVE_INFINITY;
    if (currentSimTimeMs < pending.completeAtSimMs) {
      continue;
    }

    pendingDeathTests.delete(pendingID);
    processedCount += 1;

    const scene = pendingScene;
    const destroyed = [];
    for (const spawnedEntityID of pending.spawnedEntityIDs) {
      const liveEntity = scene ? scene.getEntityByID(spawnedEntityID) : null;
      if (!liveEntity) {
        continue;
      }
      const destroyResult = destroyShipEntityWithWreck(
        pending.systemID,
        liveEntity,
        {
          scene: scene || undefined,
          sceneDescriptor: pending.sceneDescriptor || undefined,
          ownerCharacterID: pending.ownerCharacterID,
        },
      );
      if (destroyResult.success) {
        destroyed.push({
          shipID: liveEntity.itemID,
          wreckID: destroyResult.data.wreck.itemID,
        });
      }
    }

    pending.resolve({
      shipType: pending.shipType,
      spawnedCount: pending.spawnedCount,
      destroyed,
    });
  }

  if (pendingDeathTests.size <= 0) {
    clearPendingDeathTestTimer();
  }
  return processedCount;
}

function queuePendingDeathTest({
  systemID,
  sceneDescriptor = null,
  ownerCharacterID,
  shipType,
  spawnedEntityIDs,
  spawnedCount,
  delayMs,
}) {
  const scene = sceneDescriptor
    ? spaceRuntime.getSceneByDescriptor(sceneDescriptor)
    : spaceRuntime.ensureScene(systemID);
  const currentSimTimeMs = scene
    ? scene.getCurrentSimTimeMs()
    : spaceRuntime.getSimulationTimeMsForSystem(systemID);
  const pendingID = nextPendingDeathTestID++;
  let resolvePromise = null;
  const completionPromise = new Promise((resolve) => {
    resolvePromise = resolve;
  });

  pendingDeathTests.set(pendingID, {
    systemID,
    sceneDescriptor: scene && scene.sceneDescriptor || sceneDescriptor || null,
    ownerCharacterID,
    shipType,
    spawnedEntityIDs: [...spawnedEntityIDs],
    spawnedCount,
    completeAtSimMs: currentSimTimeMs + Math.max(0, toFiniteNumber(delayMs, 0)),
    resolve: resolvePromise,
  });
  ensurePendingDeathTestTimer();
  processPendingDeathTests();

  return {
    completionPromise,
    completeAtSimMs: currentSimTimeMs + Math.max(0, toFiniteNumber(delayMs, 0)),
  };
}

// Tears the destroyed hull out of the scene and, when it is a persisted item,
// out of inventory too. Shared by the wreck and the pod/corpse paths so both
// keep the same explosion FX and the same session-owned/transient branches.
function removeDestroyedShipEntityFromSpace(
  numericSystemID,
  shipEntity,
  options = {},
  contentDestroyChanges = [],
) {
  if (options.deathReceipt) {
    const removed = spaceRuntime.removeDynamicEntity(numericSystemID, shipEntity.itemID, {
      sceneDescriptor: options.sceneDescriptor, allowSessionOwned: false,
      terminalDestructionEffectID: DESTRUCTION_EFFECT_EXPLOSION,
      forceVisibleSessions: options.forceVisibleSessions });
    if (!removed.success) return removed;
    const itemResult = deathItemCustody.destroyItem({ item: options.deathReceipt.shipRecord,
      operationID: options.deathReceipt.key });
    if (!itemResult.success) return itemResult;
    return { success: true, destroyChanges: [...contentDestroyChanges, ...(itemResult.data?.changes || [])] };
  }
  if (shipEntity.persistSpaceState === true && !shipEntity.session) {
    const destroyResult = spaceRuntime.removeDynamicEntity(
      numericSystemID,
      shipEntity.itemID,
      {
        sceneDescriptor: options.sceneDescriptor,
        allowSessionOwned: false,
        terminalDestructionEffectID: DESTRUCTION_EFFECT_EXPLOSION,
        forceVisibleSessions: options.forceVisibleSessions,
      },
    );
    if (!destroyResult.success) {
      return destroyResult;
    }

    const removeShipItemResult = removeInventoryItem(shipEntity.itemID, {
      removeContents: false,
    });
    if (!removeShipItemResult.success) {
      return removeShipItemResult;
    }

    return {
      success: true,
      destroyChanges: [
        ...contentDestroyChanges,
        ...(
          destroyResult.data && Array.isArray(destroyResult.data.changes)
            ? destroyResult.data.changes
            : []
        ),
        ...(
          removeShipItemResult.data && Array.isArray(removeShipItemResult.data.changes)
            ? removeShipItemResult.data.changes
            : []
        ),
      ],
    };
  }

  const destroyResult = shipEntity.persistSpaceState === true
    ? spaceRuntime.destroyDynamicInventoryEntity(
        numericSystemID,
        shipEntity.itemID,
        {
          sceneDescriptor: options.sceneDescriptor,
          removeContents: false,
          terminalDestructionEffectID: DESTRUCTION_EFFECT_EXPLOSION,
        },
      )
    : spaceRuntime.removeDynamicEntity(
        numericSystemID,
        shipEntity.itemID,
        {
          sceneDescriptor: options.sceneDescriptor,
          allowSessionOwned: false,
          terminalDestructionEffectID: DESTRUCTION_EFFECT_EXPLOSION,
          forceVisibleSessions: options.forceVisibleSessions,
        },
      );
  if (!destroyResult.success) {
    return destroyResult;
  }
  return {
    success: true,
    destroyChanges: [
      ...contentDestroyChanges,
      ...(
        destroyResult.data && Array.isArray(destroyResult.data.changes)
          ? destroyResult.data.changes
          : []
      ),
    ],
  };
}

function destroyShipEntityWithWreck(systemID, shipEntity, options = {}) {
  const numericSystemID = toPositiveInt(systemID, 0);
  if (shipEntity && shipEntity.nativeNpc === true) {
    const {
      destroyNativeNpcEntityWithWreck,
    } = require(path.join(__dirname, "./npc/nativeNpcWreckService"));
    return destroyNativeNpcEntityWithWreck(numericSystemID, shipEntity, options);
  }

  const ownerCharacterID = toPositiveInt(
    options.ownerCharacterID ||
      options.characterID ||
      (shipEntity && shipEntity.pilotCharacterID) ||
      (shipEntity && shipEntity.characterID) ||
      (shipEntity && shipEntity.ownerID),
    0,
  );
  if (!numericSystemID || !shipEntity || shipEntity.kind !== "ship") {
    return {
      success: false,
      errorMsg: "SHIP_NOT_FOUND",
    };
  }
  if (!ownerCharacterID) {
    return {
      success: false,
      errorMsg: "OWNER_CHARACTER_REQUIRED",
    };
  }

  if (options.suppressWreck === true) {
    return destroyShipEntityWithoutWreck(numericSystemID, shipEntity, {
      ...options,
      removeContents: options.removeContents !== false,
    });
  }

  const destructionScene = resolveShipDestructionScene(
    numericSystemID,
    shipEntity,
    options,
  );
  if (!destructionScene) {
    return {
      success: false,
      errorMsg: "SHIP_SCENE_NOT_FOUND",
    };
  }
  const destructionOptions = {
    ...options,
    scene: destructionScene,
    sceneDescriptor: destructionScene.sceneDescriptor || options.sceneDescriptor,
  };

  releaseControlledCraftForDestroyedShip(
    numericSystemID,
    shipEntity,
    destructionOptions,
  );

  const shipRecord =
    options.shipRecord ||
    (shipEntity.persistSpaceState === true
      ? getActiveShipRecord(ownerCharacterID)
      : findShipItemById(shipEntity.itemID)) ||
    null;
  const wreckLootContext = resolveCharacterSpaceLootContext(
    ownerCharacterID,
    {
      session: options.lootOwnerSession,
      corporationID: shipEntity.corporationID,
      allianceID: shipEntity.allianceID,
      warFactionID: shipEntity.warFactionID,
    },
  );
  const wreckType = resolveShipWreckType(shipEntity.typeID);
  if (!wreckType) {
    return {
      success: false,
      errorMsg: "WRECK_TYPE_NOT_FOUND",
    };
  }

  const now =
    destructionScene && typeof destructionScene.getCurrentSimTimeMs === "function"
      ? destructionScene.getCurrentSimTimeMs()
      : spaceRuntime.getSimulationTimeMsForSystem(numericSystemID);
  const wreckCreateResult = options.deathReceipt ? createPreparedDeathDebris(options.deathReceipt) : createSpaceItemForOwner(
    ownerCharacterID,
    numericSystemID,
    wreckType,
    {
      ...buildChildEntityScopeMetadata(shipEntity),
      itemName: wreckType.name,
      position: cloneVector(shipEntity.position),
      direction: normalizeVector(shipEntity.direction, { x: 1, y: 0, z: 0 }),
      velocity: { x: 0, y: 0, z: 0 },
      targetPoint: cloneVector(shipEntity.position),
      mode: "STOP",
      speedFraction: 0,
      transient: shipEntity.transient === true,
      createdAtMs: now,
      expiresAtMs: now + getSpaceDebrisLifetimeMs(),
      launcherID: shipEntity.itemID,
      customInfo: JSON.stringify({
        [LOOT_CUSTOM_INFO_KEY]:
          buildSpaceLootRightsSnapshot(wreckLootContext),
      }),
      spaceRadius: toFiniteNumber(shipEntity.radius, 0),
      dunRotation: buildDunRotationFromDirection(shipEntity.direction),
      conditionState: {
        damage: 0,
        charge: 1,
        armorDamage: 0,
        shieldCharge: 0,
        incapacitated: false,
      },
    },
  );
  if (!wreckCreateResult.success || !wreckCreateResult.data) {
    return {
      success: false,
      errorMsg: "WRECK_CREATE_FAILED",
    };
  }

  const wreckItem = wreckCreateResult.data;
  if (spatialTrace.isEnabled()) {
    spatialTrace.recordWreckRecordCreated(
      destructionScene,
      {
        ...wreckItem,
        wreckID: wreckItem.itemID,
        sourceEntityID: shipEntity.itemID,
        systemID: numericSystemID,
        launcherID:
          wreckItem.spaceState && wreckItem.spaceState.launcherID !== undefined
            ? wreckItem.spaceState.launcherID
            : shipEntity.itemID,
      },
      {
        persistenceKind: shipEntity.transient === true
          ? "inventory-transient-record"
          : "inventory-persisted-record",
      },
    );
  }
  const deathOutcomeResult = options.deathReceipt
    ? applyPreparedLocationDeathOutcome(options.deathReceipt.loot, wreckItem.itemID)
    : shipRecord
    ? resolveLocationDeathOutcome(shipRecord.itemID, {
        rootLootLocationID: wreckItem.itemID,
        seed: `ship:${shipEntity.itemID}:${now}`,
      })
    : {
        success: true,
        data: {
          items: [],
          movedChanges: [],
          destroyChanges: [],
        },
      };
  const killmailItems =
    deathOutcomeResult &&
    deathOutcomeResult.success &&
    deathOutcomeResult.data &&
    Array.isArray(deathOutcomeResult.data.items)
      ? deathOutcomeResult.data.items
      : [];
  const movedChanges =
    deathOutcomeResult &&
    deathOutcomeResult.success &&
    deathOutcomeResult.data &&
    Array.isArray(deathOutcomeResult.data.movedChanges)
      ? deathOutcomeResult.data.movedChanges
      : [];
  const contentDestroyChanges =
    deathOutcomeResult &&
    deathOutcomeResult.success &&
    deathOutcomeResult.data &&
    Array.isArray(deathOutcomeResult.data.destroyChanges)
      ? deathOutcomeResult.data.destroyChanges
      : [];

  const removeEntityResult = removeDestroyedShipEntityFromSpace(
    numericSystemID,
    shipEntity,
    destructionOptions,
    contentDestroyChanges,
  );
  if (!removeEntityResult.success) {
    return removeEntityResult;
  }
  const destroyChanges = removeEntityResult.destroyChanges;

  const wreckSpawnResult = spaceRuntime.spawnDynamicInventoryEntity(
    numericSystemID,
    wreckItem.itemID,
    {
      sceneDescriptor: destructionOptions.sceneDescriptor,
      // Replacement wrecks are a follow-on to an already visible destruction
      // event, not a fresh scene bootstrap. Sending them on the lighter
      // immediate lane avoids bootstrap-acquire backsteps when several hulls
      // die in the same tick, which is exactly what /deathtest does.
      broadcastOptions: {
        deferUntilVisibilitySync:
          options.deferWreckBroadcastUntilVisibilitySync === true,
        freshAcquire: false,
      },
    },
  );
  if (!wreckSpawnResult.success) {
    return wreckSpawnResult;
  }

  log.info(
    `[ShipDestruction] Destroyed ship=${shipEntity.itemID} type=${shipEntity.typeID} wreck=${wreckItem.itemID} system=${numericSystemID}`,
  );

  if (options.deferInsurancePayout !== true) {
    handleInsuranceShipDestroyedSafe(
      numericSystemID,
      shipEntity,
      options,
      shipRecord,
    );
  }

  return {
    success: true,
    data: {
      wreck: wreckItem,
      wreckSuppressed: false,
      shipID: shipEntity.itemID,
      movedChanges,
      destroyChanges,
      lootOutcome: {
        items: killmailItems,
      },
      wreckChanges:
        wreckCreateResult.changes ||
        (wreckCreateResult.data && wreckCreateResult.data.changes) ||
        [],
    },
  };
}

function destroyShipEntityWithoutWreck(systemID, shipEntity, options = {}) {
  const numericSystemID = toPositiveInt(systemID, 0);
  if (!numericSystemID || !shipEntity || shipEntity.kind !== "ship") {
    return {
      success: false,
      errorMsg: "SHIP_NOT_FOUND",
    };
  }

  const destructionScene = resolveShipDestructionScene(
    numericSystemID,
    shipEntity,
    options,
  );
  if (!destructionScene) {
    return {
      success: false,
      errorMsg: "SHIP_SCENE_NOT_FOUND",
    };
  }
  const destructionOptions = {
    ...options,
    scene: destructionScene,
    sceneDescriptor: destructionScene.sceneDescriptor || options.sceneDescriptor,
  };

  releaseControlledCraftForDestroyedShip(
    numericSystemID,
    shipEntity,
    destructionOptions,
  );

  if (shipEntity.nativeNpc === true) {
    const {
      destroyNativeNpcController,
    } = require(path.join(__dirname, "./npc/nativeNpcService"));
    const destroyResult = destroyNativeNpcController({
      entityID: shipEntity.itemID,
      itemID: shipEntity.itemID,
      systemID: numericSystemID,
    }, {
      sceneDescriptor: destructionOptions.sceneDescriptor,
      removeContents: destructionOptions.removeContents !== false,
      suppressWreck: destructionOptions.suppressWreck === true,
      terminalDestructionEffectID: destructionOptions.terminalDestructionEffectID,
      destructionReason: destructionOptions.destructionReason,
      notifyNpcDestroyed: destructionOptions.notifyNpcDestroyed,
    });
    if (!destroyResult || destroyResult.success !== true) {
      return destroyResult || {
        success: false,
        errorMsg: "NPC_NOT_FOUND",
      };
    }
    return {
      success: true,
      data: {
        shipID: shipEntity.itemID,
        wreck: null,
        wreckSuppressed: options.suppressWreck === true,
        nativeNpc: true,
        objectiveNotified: destroyResult.data && destroyResult.data.objectiveNotified === true,
        objectiveNotificationResult:
          destroyResult.data && destroyResult.data.objectiveNotificationResult,
        destructionContext: destroyResult.data && destroyResult.data.destructionContext,
        lootOutcome: {
          items: [],
        },
        changes: [],
      },
    };
  }

  if (options.deathReceipt && options.deathReceipt.suppressWreck) {
    const outcome = applyPreparedLocationDeathOutcome(options.deathReceipt.loot, null);
    const removed = removeDestroyedShipEntityFromSpace(numericSystemID, shipEntity,
      destructionOptions, outcome.data.destroyChanges);
    if (!removed.success) return removed;
    return { success: true, data: { shipID: shipEntity.itemID, wreck: null,
      wreckSuppressed: true, lootOutcome: { items: outcome.data.items },
      destroyChanges: removed.destroyChanges, movedChanges: [], wreckChanges: [] } };
  }
  const deathOutcomeResult =
    options.removeContents === true
      ? resolveLocationDeathOutcome(shipEntity.itemID, {
          forceAllDestroyed: true,
          seed: `ship-destroyed:${shipEntity.itemID}:${numericSystemID}`,
        })
      : {
          success: true,
          data: {
            items: [],
            destroyChanges: [],
          },
        };
  const killmailItems =
    deathOutcomeResult &&
    deathOutcomeResult.success &&
    deathOutcomeResult.data &&
    Array.isArray(deathOutcomeResult.data.items)
      ? deathOutcomeResult.data.items
      : [];
  const contentDestroyChanges =
    deathOutcomeResult &&
    deathOutcomeResult.success &&
    deathOutcomeResult.data &&
    Array.isArray(deathOutcomeResult.data.destroyChanges)
      ? deathOutcomeResult.data.destroyChanges
      : [];
  const removeEntityResult = spaceRuntime.removeDynamicEntity(
    numericSystemID,
    shipEntity.itemID,
    {
      sceneDescriptor: destructionOptions.sceneDescriptor,
      allowSessionOwned: destructionOptions.allowSessionOwned === true,
      terminalDestructionEffectID: toPositiveInt(
        options.terminalDestructionEffectID,
        DESTRUCTION_EFFECT_EXPLOSION,
      ),
    },
  );
  if (!removeEntityResult.success) {
    return removeEntityResult;
  }

  const removeShipItemResult = removeInventoryItem(shipEntity.itemID, {
    removeContents: options.removeContents === true,
  });
  if (!removeShipItemResult.success) {
    return removeShipItemResult;
  }

  handleInsuranceShipDestroyedSafe(numericSystemID, shipEntity, options, null);

  return {
    success: true,
    data: {
      shipID: shipEntity.itemID,
      wreck: null,
      wreckSuppressed: options.suppressWreck === true,
      lootOutcome: {
        items: killmailItems,
      },
      changes: [
        ...contentDestroyChanges,
        ...(
          removeShipItemResult.data &&
          Array.isArray(removeShipItemResult.data.changes)
            ? removeShipItemResult.data.changes
            : []
        ),
      ],
    },
  };
}

// Mirrors the wreck path: the corpse row is created before the pod is torn out
// of space so a create failure aborts before anything is destroyed, but the
// corpse entity only spawns afterwards so observers see the explosion first.
function createPodDeathCorpseItem(
  numericSystemID,
  capsuleEntity,
  ownerCharacterID,
  options = {},
) {
  const characterRecord = getCharacterRecord(ownerCharacterID) || {};
  const corpseType = resolveCorpseType(
    characterRecord.gender !== undefined
      ? characterRecord.gender
      : characterRecord.genderID,
  );
  if (!corpseType) {
    return {
      success: false,
      errorMsg: "CORPSE_TYPE_NOT_FOUND",
    };
  }

  const scene = resolveShipDestructionScene(
    numericSystemID,
    capsuleEntity,
    options,
  );
  const now =
    scene && typeof scene.getCurrentSimTimeMs === "function"
      ? scene.getCurrentSimTimeMs()
      : spaceRuntime.getSimulationTimeMsForSystem(numericSystemID);
  const corpseCreateResult = options.deathReceipt ? createPreparedDeathDebris(options.deathReceipt) : createSpaceItemForOwner(
    ownerCharacterID,
    numericSystemID,
    corpseType,
    {
      ...buildChildEntityScopeMetadata(capsuleEntity),
      // The client resolves a corpse label through the pilot name rather than
      // the type name (clientcodegrabber/latest/eve/client/script/util/
      // contractutils.py GetCorpseName), so carry the victim's name on the item.
      itemName: characterRecord.characterName || corpseType.name,
      position: cloneVector(capsuleEntity.position),
      direction: normalizeVector(capsuleEntity.direction, { x: 1, y: 0, z: 0 }),
      velocity: { x: 0, y: 0, z: 0 },
      targetPoint: cloneVector(capsuleEntity.position),
      mode: "STOP",
      speedFraction: 0,
      transient: capsuleEntity.transient === true,
      createdAtMs: now,
      expiresAtMs: now + getSpaceDebrisLifetimeMs(),
      launcherID: capsuleEntity.itemID,
      dunRotation: buildDunRotationFromDirection(capsuleEntity.direction),
    },
  );
  if (!corpseCreateResult.success || !corpseCreateResult.data) {
    return {
      success: false,
      errorMsg: corpseCreateResult.errorMsg || "CORPSE_CREATE_FAILED",
    };
  }

  return {
    success: true,
    data: {
      corpse: corpseCreateResult.data,
      corpseChanges:
        corpseCreateResult.changes ||
        (corpseCreateResult.data && corpseCreateResult.data.changes) ||
        [],
    },
  };
}

function spawnPodDeathCorpseEntity(numericSystemID, corpseItem, options = {}) {
  const corpseSpawnResult = spaceRuntime.spawnDynamicInventoryEntity(
    numericSystemID,
    corpseItem.itemID,
    {
      sceneDescriptor: options.sceneDescriptor,
      // The corpse follows an explosion the grid has already seen, so it rides
      // the same lighter lane replacement wrecks use rather than a fresh
      // scene bootstrap acquire.
      broadcastOptions: {
        deferUntilVisibilitySync:
          options.deferCorpseBroadcastUntilVisibilitySync === true,
        freshAcquire: false,
      },
    },
  );
  if (!corpseSpawnResult.success) {
    removeInventoryItem(corpseItem.itemID, { removeContents: false });
    return {
      success: false,
      errorMsg: corpseSpawnResult.errorMsg || "CORPSE_SPAWN_FAILED",
    };
  }
  return {
    success: true,
  };
}

// TQ pods leave a corpse, not a wreck. The Mysterious Capsule Wreck only shows
// up while a Crimson Harvest style event is running, so the ordinary pod death
// destroys the capsule and drops a scoopable corpse in its place.
function destroyCapsuleEntityWithCorpse(systemID, capsuleEntity, options = {}) {
  const numericSystemID = toPositiveInt(systemID, 0);
  if (!numericSystemID || !capsuleEntity || capsuleEntity.kind !== "ship") {
    return {
      success: false,
      errorMsg: "SHIP_NOT_FOUND",
    };
  }

  const ownerCharacterID = toPositiveInt(
    options.ownerCharacterID ||
      options.characterID ||
      capsuleEntity.pilotCharacterID ||
      capsuleEntity.characterID ||
      capsuleEntity.ownerID,
    0,
  );
  if (!ownerCharacterID) {
    return {
      success: false,
      errorMsg: "OWNER_CHARACTER_REQUIRED",
    };
  }

  const destructionScene = resolveShipDestructionScene(
    numericSystemID,
    capsuleEntity,
    options,
  );
  if (!destructionScene) {
    return {
      success: false,
      errorMsg: "SHIP_SCENE_NOT_FOUND",
    };
  }
  const destructionOptions = {
    ...options,
    scene: destructionScene,
    sceneDescriptor: destructionScene.sceneDescriptor || options.sceneDescriptor,
  };

  releaseControlledCraftForDestroyedShip(
    numericSystemID,
    capsuleEntity,
    destructionOptions,
  );

  const shipRecord =
    options.shipRecord ||
    (capsuleEntity.persistSpaceState === true
      ? getActiveShipRecord(ownerCharacterID)
      : findShipItemById(capsuleEntity.itemID)) ||
    null;
  const now =
    destructionScene && typeof destructionScene.getCurrentSimTimeMs === "function"
      ? destructionScene.getCurrentSimTimeMs()
      : spaceRuntime.getSimulationTimeMsForSystem(numericSystemID);
  // A pod has no cargo and its implants are character state rather than items,
  // so nothing drops. Anything that did somehow end up inside is destroyed
  // instead of being left orphaned at a location that is about to vanish.
  const deathOutcomeResult = options.deathReceipt
    ? applyPreparedLocationDeathOutcome(options.deathReceipt.loot, null)
    : shipRecord
    ? resolveLocationDeathOutcome(shipRecord.itemID, {
        forceAllDestroyed: true,
        seed: `pod:${capsuleEntity.itemID}:${now}`,
      })
    : {
        success: true,
        data: {
          items: [],
          destroyChanges: [],
        },
      };
  const killmailItems =
    deathOutcomeResult &&
    deathOutcomeResult.success &&
    deathOutcomeResult.data &&
    Array.isArray(deathOutcomeResult.data.items)
      ? deathOutcomeResult.data.items
      : [];
  const contentDestroyChanges =
    deathOutcomeResult &&
    deathOutcomeResult.success &&
    deathOutcomeResult.data &&
    Array.isArray(deathOutcomeResult.data.destroyChanges)
      ? deathOutcomeResult.data.destroyChanges
      : [];

  const corpseCreateResult = createPodDeathCorpseItem(
    numericSystemID,
    capsuleEntity,
    ownerCharacterID,
    destructionOptions,
  );
  if (!corpseCreateResult.success) {
    // A missing corpse must not strand the pilot in a destroyed pod, so the
    // pod death continues and only the corpse is skipped.
    log.warn(
      `[ShipDestruction] Corpse creation failed for char=${ownerCharacterID} pod=${capsuleEntity.itemID}: ${corpseCreateResult.errorMsg}`,
    );
  }

  const removeEntityResult = removeDestroyedShipEntityFromSpace(
    numericSystemID,
    capsuleEntity,
    destructionOptions,
    contentDestroyChanges,
  );
  if (!removeEntityResult.success) {
    if (corpseCreateResult.success) {
      removeInventoryItem(corpseCreateResult.data.corpse.itemID, {
        removeContents: false,
      });
    }
    return removeEntityResult;
  }

  let corpseItem = corpseCreateResult.success
    ? corpseCreateResult.data.corpse
    : null;
  if (corpseItem) {
    const corpseSpawnResult = spawnPodDeathCorpseEntity(
      numericSystemID,
      corpseItem,
      {
        sceneDescriptor: destructionOptions.sceneDescriptor,
        deferCorpseBroadcastUntilVisibilitySync:
          options.deferWreckBroadcastUntilVisibilitySync === true,
      },
    );
    if (!corpseSpawnResult.success) {
      log.warn(
        `[ShipDestruction] Corpse spawn failed for char=${ownerCharacterID} pod=${capsuleEntity.itemID}: ${corpseSpawnResult.errorMsg}`,
      );
      corpseItem = null;
    }
  }
  log.info(
    `[ShipDestruction] Destroyed capsule=${capsuleEntity.itemID} char=${ownerCharacterID} corpse=${corpseItem ? corpseItem.itemID : "none"} system=${numericSystemID}`,
  );

  if (options.deferInsurancePayout !== true) {
    handleInsuranceShipDestroyedSafe(
      numericSystemID,
      capsuleEntity,
      options,
      shipRecord,
    );
  }

  return {
    success: true,
    data: {
      wreck: null,
      corpse: corpseItem,
      shipID: capsuleEntity.itemID,
      movedChanges: [],
      destroyChanges: removeEntityResult.destroyChanges,
      lootOutcome: {
        items: killmailItems,
      },
      wreckChanges: [],
      corpseChanges: corpseItem ? corpseCreateResult.data.corpseChanges : [],
    },
  };
}

function reseedDestroyedPilotSession(scene, session, capsuleEntity) {
  if (!scene || !session || !session._space || !capsuleEntity) {
    return false;
  }

  // The eject (ejectSession) has made the pod the session's ego with no
  // SetState: the pod reaches its pilot in its Grid bubble's next add (a
  // same-scene swap). Only stale view flags are repaired here; nothing is
  // sent.
  repairSameSceneSessionViewState(session);
  return true;
}

function purgeDestroyedShipEntityFromScene(scene, shipID) {
  if (
    !scene ||
    typeof scene.purgeDestroyedShipEntityTopology !== "function"
  ) {
    return false;
  }
  return scene.purgeDestroyedShipEntityTopology(shipID);
}

function getAttachedSessionShipDestructionContext(session) {
  if (!session || !session._space) {
    return {
      scene: null,
      entity: null,
      systemID: 0,
    };
  }

  const systemID = toPositiveInt(session._space.systemID, 0);
  const scene = systemID > 0
    ? spaceRuntime.getSceneForSession(session)
    : null;
  const entity =
    scene && session._space
      ? scene.getEntityByID(toPositiveInt(session._space.shipID, 0))
      : null;
  return {
    scene,
    entity: entity && entity.kind === "ship" ? entity : null,
    systemID,
  };
}

function resolvePodDeathDestroyerID(options = {}, session = null) {
  const attackerEntity = options.attackerEntity || null;
  return toPositiveInt(
    (attackerEntity && (
      attackerEntity.pilotCharacterID ||
      attackerEntity.characterID ||
      attackerEntity.ownerID
    )) || options.destroyerID,
    toPositiveInt(session && session.characterID, 0),
  );
}

// Podding destroys the active clone's destructible implants. The clone runtime
// owns the removal, the clone-destroyed events and the dogma resync; it must
// never take the pod death down with it if any of that fails.
function clearPodDeathImplantsSafe(session, options = {}) {
  try {
    const jumpCloneRuntime = require(path.join(
      __dirname,
      "../services/station/jumpCloneRuntime",
    ));
    if (typeof jumpCloneRuntime.clearActiveImplantsForPodDeath !== "function") {
      return null;
    }
    return jumpCloneRuntime.clearActiveImplantsForPodDeath(session, options);
  } catch (error) {
    log.warn(
      `[ShipDestruction] Pod death implant clearing failed for char=${options.characterID || (session && session.characterID)}: ${error.message}`,
    );
    return null;
  }
}

function resolvePodRespawnStationID(session) {
  const characterRecord = getCharacterRecord(session && session.characterID) || {};
  const homeStationID = Number(
    characterRecord.homeStationID ||
    characterRecord.cloneStationID ||
    (session && session.homeStationID) ||
    (session && session.homestationid) ||
    (session && session.cloneStationID) ||
    (session && session.clonestationid) ||
    60003760,
  ) || 60003760;
  // Required here rather than at the top so this module's load order does not
  // change.
  const {
    isHomeStationLost,
    resolveSchoolHQStationID,
  } = require(path.join(__dirname, "../services/character/homeStationRuntime"));
  if (!isHomeStationLost(homeStationID)) {
    return homeStationID;
  }
  // No clone can wake in a structure that was destroyed or removed. Retail
  // falls back to the character's school station.
  return resolveSchoolHQStationID(characterRecord, session) || 60003760;
}

function destroyAttachedSessionCapsuleFallback(session, options = {}) {
  if (!session || !session.characterID || !session._space) {
    return {
      success: false,
      errorMsg: "NOT_IN_SPACE",
    };
  }

  const {
    scene,
    entity: attachedCapsuleEntity,
    systemID,
  } = getAttachedSessionShipDestructionContext(session);
  if (!scene || !attachedCapsuleEntity || !isCapsuleTypeID(attachedCapsuleEntity.typeID)) {
    return {
      success: false,
      errorMsg: "CAPSULE_ENTITY_NOT_FOUND",
    };
  }

  session.sessionChangeReason = options.sessionChangeReason || "selfdestruct";
  const abandonedCapsuleEntity = spaceRuntime.disembarkSession(session, {
    broadcast: false,
  });
  if (!abandonedCapsuleEntity) {
    return {
      success: false,
      errorMsg: "CAPSULE_ENTITY_NOT_FOUND",
    };
  }

  const destroyResult = destroyCapsuleEntityWithCorpse(
    systemID,
    abandonedCapsuleEntity,
    {
      scene,
      sceneDescriptor: scene.sceneDescriptor,
      ownerCharacterID: session.characterID,
      shipRecord: {
        itemID: abandonedCapsuleEntity.itemID,
        typeID: abandonedCapsuleEntity.typeID,
        locationID: systemID,
        ownerID: session.characterID,
      },
    },
  );
  if (!destroyResult.success) {
    log.warn(
      `[ShipDestruction] Fallback capsule destroy cleanup failed for char=${session.characterID} pod=${abandonedCapsuleEntity.itemID} error=${destroyResult.errorMsg}`,
    );
    return destroyResult;
  }

  let respawnResult = null;
  if (options.emitNotifications !== false) {
    sendPodDeathNotifications(session, abandonedCapsuleEntity.itemID);
  }
  if (getCharacterRecord(session.characterID)) {
    const targetStationID = resolvePodRespawnStationID(session);
    respawnResult = rebuildDockedSessionAtStation(session, targetStationID, {
      emitNotifications: options.emitNotifications !== false,
      logSelection: true,
      boardNewbieShip: true,
      newbieShipLogLabel: "PodRespawnFallback",
    });
    if (!respawnResult.success || !respawnResult.data) {
      return respawnResult;
    }
    log.info(
      `[ShipDestruction] Fallback-podded ${session.characterName || session.characterID} pod=${abandonedCapsuleEntity.itemID} station=${targetStationID} ship=${respawnResult.data.ship && respawnResult.data.ship.itemID}`,
    );
    clearPodDeathImplantsSafe(session, {
      characterID: session.characterID,
      locationID: systemID,
      destroyerID: resolvePodDeathDestroyerID(options, session),
      emitNotifications: options.emitNotifications !== false,
    });
  }

  return {
    success: true,
    data: {
      station: respawnResult && respawnResult.data ? respawnResult.data.station : null,
      capsule: respawnResult && respawnResult.data ? respawnResult.data.capsule : null,
      ship: respawnResult && respawnResult.data ? respawnResult.data.ship : null,
      destroyedShipID: abandonedCapsuleEntity.itemID,
      wreck: destroyResult.data ? destroyResult.data.wreck || null : null,
      corpse: destroyResult.data ? destroyResult.data.corpse || null : null,
      corpseChanges:
        destroyResult.data && Array.isArray(destroyResult.data.corpseChanges)
          ? destroyResult.data.corpseChanges
          : [],
      movedChanges:
        destroyResult.data && Array.isArray(destroyResult.data.movedChanges)
          ? destroyResult.data.movedChanges
          : [],
      destroyChanges:
        destroyResult.data && Array.isArray(destroyResult.data.destroyChanges)
          ? destroyResult.data.destroyChanges
          : [],
      wreckChanges:
        destroyResult.data && Array.isArray(destroyResult.data.wreckChanges)
          ? destroyResult.data.wreckChanges
          : [],
      boundResult: respawnResult && respawnResult.data ? respawnResult.data.boundResult : null,
      transientSessionFallback: true,
    },
  };
}

function emitShipDeathInventoryChangeForSession(session, change) {
  if (!change || !change.item) {
    return false;
  }
  return emitItemsChangedBatchForSession(session, [change], {
    idType: "charid",
  });
}

function emitShipDeathInventoryChangesForSession(session, changes = []) {
  let emittedCount = 0;
  for (const change of Array.isArray(changes) ? changes : []) {
    if (emitShipDeathInventoryChangeForSession(session, change)) {
      emittedCount += 1;
    }
  }
  return emittedCount;
}

function emitDestroyedShipContentChangesForSession(
  session,
  destroyedShipID,
  destroyData = {},
  options = {},
) {
  if (!session || !destroyData) {
    return 0;
  }
  const changes = [
    ...(Array.isArray(destroyData.movedChanges) ? destroyData.movedChanges : []),
    ...(Array.isArray(destroyData.destroyChanges) ? destroyData.destroyChanges : []),
  ];
  if (changes.length === 0) {
    return 0;
  }
  if (
    emitFittingTransactionForSession(session, destroyedShipID, changes, {
      shipItem: options.shipRecord || null,
    })
  ) {
    return changes.length;
  }
  return emitShipDeathInventoryChangesForSession(session, changes);
}

function destroySessionShip(session, options = {}) {
  if (!session || !session.characterID || !session._space) {
    return {
      success: false,
      errorMsg: "NOT_IN_SPACE",
    };
  }

  const activeShip = getActiveShipRecord(session.characterID);
  if (!activeShip) {
    const { entity: attachedEntity } = getAttachedSessionShipDestructionContext(session);
    if (attachedEntity && isCapsuleTypeID(attachedEntity.typeID)) {
      return destroyAttachedSessionCapsuleFallback(session, options);
    }
    return {
      success: false,
      errorMsg: "SHIP_NOT_FOUND",
    };
  }

  require("./transientStargates").prepareShipDestruction(session);
  if (isCapsuleTypeID(activeShip.typeID)) {
    return destroySessionCapsuleToHomeStation(session, activeShip, options);
  }

  session.sessionChangeReason = options.sessionChangeReason || "selfdestruct";
  const systemID = toPositiveInt(
    session._space && session._space.systemID,
    toPositiveInt(activeShip.locationID, 0),
  );
  let destroyResult = null;
  let destructionScene = null;
  let syncedDestroyedShipContentChangeCount = 0;
  const ejectResult = ejectSessionForShipDestruction(session, {
    refreshAbandonedShipViewForVictim: false,
    syncAllSessionsVisibilityAfterSwap: false,
    sendEjectSpecialFx: false,
    disconnectBoundObjectsBeforeSwap: true,
    sameSceneShipSwapSessionId: 0n,
    beforeSameSceneShipSwapNotificationPlanFlush({
      scene,
      abandonedShipEntity,
    }) {
      destructionScene = scene || null;
      if (!scene || !abandonedShipEntity) {
        destroyResult = {
          success: false,
          errorMsg: "ABANDONED_SHIP_NOT_FOUND",
        };
        return { success: true };
      }
      destroyResult = destroyShipEntityWithWreck(systemID, abandonedShipEntity, {
        deathReceipt: options.deathReceipt,
        lossID: options.deathReceipt?.key,
        destroyedAtFiletime: options.deathReceipt?.destroyedAtFiletime,
        scene,
        sceneDescriptor: scene.sceneDescriptor,
        ownerCharacterID: session.characterID,
        lootOwnerSession: session,
        shipRecord: activeShip,
        forceVisibleSessions: [session],
        deferWreckBroadcastUntilVisibilitySync: true,
        suppressWreck: options.suppressWreck === true,
        destructionReason: options.destructionReason,
        skipInsurance: options.skipInsurance === true,
        insuranceSuppressedReason: options.insuranceSuppressedReason,
      });
      if (destroyResult.success) {
        syncedDestroyedShipContentChangeCount =
          emitDestroyedShipContentChangesForSession(
            session,
            activeShip.itemID,
            destroyResult.data || {},
            { shipRecord: activeShip },
          );
      }
      return { success: true };
    },
  });
  if (!ejectResult.success || !ejectResult.data) {
    return ejectResult;
  }

  if (!destroyResult) {
    return {
      success: false,
      errorMsg: "SHIP_DESTRUCTION_NOT_RUN",
    };
  }
  if (!destroyResult.success) {
    return destroyResult;
  }

  const scene = destructionScene || spaceRuntime.getSceneForSession(session);
  purgeDestroyedShipEntityFromScene(scene, activeShip.itemID);

  const capsuleEntity =
    scene && session && session._space
      ? scene.getEntityByID(getEntityMapKey(session._space.shipID))
      : null;
  if (capsuleEntity && session && session._space) {
    reseedDestroyedPilotSession(scene, session, capsuleEntity);
  }

  return {
    success: true,
    data: {
      capsule: ejectResult.data.capsule,
      wreck: destroyResult.data.wreck,
      wreckSuppressed: destroyResult.data.wreckSuppressed === true,
      destroyedShipID: activeShip.itemID,
      // ⚠ THE KILLMAIL'S ITEMS COME FROM HERE, AND ONLY FROM HERE.
      //
      // Dropping lootOutcome makes resolveKillmailItems fall back to scanning
      // the WRECK, and anything moved into a wreck sits at the hangar flag — so
      // every fitted module was recorded as cargo and the loss report's
      // "simulate fit" could only ever draw an empty hull. A player ship is the
      // only kind carrying a session, which is why this hit player losses alone.
      lootOutcome: destroyResult.data.lootOutcome,
      movedChanges: destroyResult.data.movedChanges,
      destroyChanges: destroyResult.data.destroyChanges,
      wreckChanges: destroyResult.data.wreckChanges,
      destroyedShipContentChangesSyncedToSession: true,
      syncedDestroyedShipContentChangeCount,
      boundResult: ejectResult.data.boundResult,
    },
  };
}

function destroyAbandonedCapsuleItem(capsuleID, systemID) {
  const capsuleItem = findShipItemById(capsuleID);
  if (
    !capsuleItem ||
    toPositiveInt(capsuleItem.locationID, 0) !== toPositiveInt(systemID, 0)
  ) {
    return false;
  }
  const result = deathItemCustody.destroyItem({
    item: capsuleItem,
    operationID: `pod:${capsuleID}`,
  });
  if (!result.success) {
    log.warn(
      `[ShipDestruction] Destroyed pod item could not be removed pod=${capsuleID}: ${result.errorMsg}`,
    );
  }
  return result.success;
}

// A live pilot's pod death, told as TQ tells it once the pod's destruction
// has gone out: OnPodDeath and OnPlayerPodDeath to the character, then
// OnPodKilled(podID) to the client (golden log "Minmatar - Tutorial - Career
// missions part 1"). OnPlayerPodDeath runs the client's death sequence (the
// pod explodes, the camera shakes, the scene is kept for the transition:
// evespacescene/playerdeath.py); OnPodKilled records the pod (gameui.py).
function sendPodDeathNotifications(session, podID) {
  if (!session || typeof session.sendNotification !== "function") {
    return false;
  }
  session.sendNotification("OnPodDeath", "charid", []);
  session.sendNotification("OnPlayerPodDeath", "charid", []);
  session.sendNotification("OnPodKilled", "clientID", [toPositiveInt(podID, 0)]);
  return true;
}

function destroySessionCapsuleToHomeStation(session, activeShip, options = {}) {
  if (!session || !session.characterID || !session._space) {
    return {
      success: false,
      errorMsg: "NOT_IN_SPACE",
    };
  }

  const systemID = toPositiveInt(
    session._space && session._space.systemID,
    toPositiveInt(activeShip && activeShip.locationID, 0),
  );
  const scene = spaceRuntime.getSceneForSession(session);
  if (!scene) {
    return {
      success: false,
      errorMsg: "SCENE_NOT_FOUND",
    };
  }

  const characterRecord = getCharacterRecord(session.characterID) || {};
  const targetStationID = resolvePodRespawnStationID(session);

  session.sessionChangeReason = options.sessionChangeReason || "selfdestruct";
  const abandonedCapsuleEntity = spaceRuntime.disembarkSession(session, {
    broadcast: false,
  });
  if (!abandonedCapsuleEntity) {
    return {
      success: false,
      errorMsg: "CAPSULE_ENTITY_NOT_FOUND",
    };
  }

  const destroyResult = destroyCapsuleEntityWithCorpse(
    systemID,
    abandonedCapsuleEntity,
    {
      scene,
      sceneDescriptor: scene.sceneDescriptor,
      ownerCharacterID: session.characterID,
      shipRecord: activeShip,
      deathReceipt: options.deathReceipt,
      lossID: options.deathReceipt?.key,
      destroyedAtFiletime: options.deathReceipt?.destroyedAtFiletime,
    },
  );
  if (!destroyResult.success) {
    log.warn(
      `[ShipDestruction] Capsule destroy cleanup failed for char=${session.characterID} pod=${abandonedCapsuleEntity.itemID} error=${destroyResult.errorMsg}`,
    );
  }

  if (options.emitNotifications !== false) {
    sendPodDeathNotifications(session, abandonedCapsuleEntity.itemID);
  }
  const respawnResult = rebuildDockedSessionAtStation(session, targetStationID, {
    emitNotifications: options.emitNotifications !== false,
    logSelection: true,
    boardNewbieShip: true,
    newbieShipLogLabel: "PodRespawn",
    airDeathKey: options.deathReceipt?.airDeathKey,
    durablePodDeathKey: options.deathReceipt?.durablePodDeathKey,
    durableRecovery: Boolean(options.deathReceipt?.airDeathKey || options.deathReceipt?.durablePodDeathKey),
  });
  if (!respawnResult.success || !respawnResult.data) {
    return respawnResult;
  }
  // A death receipt has already destroyed the pod's item. Without one (a pod
  // self-destruct, an Abyssal timeout, a GM kill) only its ball is gone, and an
  // item left in space would come back as a pilotless capsule.
  if (!options.deathReceipt) {
    destroyAbandonedCapsuleItem(abandonedCapsuleEntity.itemID, systemID);
  }

  log.info(
    `[ShipDestruction] Podded ${session.characterName || session.characterID} pod=${abandonedCapsuleEntity.itemID} station=${targetStationID} ship=${respawnResult.data.ship && respawnResult.data.ship.itemID}`,
  );

  // Run after the clone rebuild so the clone-cache invalidations carry the
  // station the pilot actually woke up in.
  clearPodDeathImplantsSafe(session, {
    characterID: session.characterID,
    locationID: systemID,
    destroyerID: resolvePodDeathDestroyerID(options, session),
    airDeathKey: options.deathReceipt?.airDeathKey,
    durableDeathKey: options.deathReceipt?.durablePodDeathKey,
    originalImplants: options.deathReceipt?.cloneImplants,
    emitNotifications: options.emitNotifications !== false,
  });

  return {
    success: true,
    data: {
      station: respawnResult.data.station,
      capsule: respawnResult.data.capsule,
      ship: respawnResult.data.ship,
      destroyedShipID: activeShip.itemID,
      wreck:
        destroyResult.success && destroyResult.data
          ? destroyResult.data.wreck || null
          : null,
      corpse:
        destroyResult.success && destroyResult.data
          ? destroyResult.data.corpse || null
          : null,
      corpseChanges:
        destroyResult.success &&
        destroyResult.data &&
        Array.isArray(destroyResult.data.corpseChanges)
          ? destroyResult.data.corpseChanges
          : [],
      // Carried for the same reason as the ship-death return above: the killmail
      // reads its items from here, and the wreck fallback loses every slot flag.
      lootOutcome:
        destroyResult.success && destroyResult.data
          ? destroyResult.data.lootOutcome
          : undefined,
      movedChanges:
        destroyResult.success &&
        destroyResult.data &&
        Array.isArray(destroyResult.data.movedChanges)
          ? destroyResult.data.movedChanges
          : [],
      destroyChanges:
        destroyResult.success &&
        destroyResult.data &&
        Array.isArray(destroyResult.data.destroyChanges)
          ? destroyResult.data.destroyChanges
          : [],
      wreckChanges:
        destroyResult.success &&
        destroyResult.data &&
        Array.isArray(destroyResult.data.wreckChanges)
          ? destroyResult.data.wreckChanges
          : [],
      boundResult: respawnResult.data.boundResult,
    },
  };
}

function spawnShipDeathTestField(session, options = {}) {
  if (!session || !session.characterID || !session._space) {
    return {
      success: false,
      errorMsg: "NOT_IN_SPACE",
    };
  }

  const systemID = toPositiveInt(session._space.systemID, 0);
  const scene = spaceRuntime.getSceneForSession(session);
  const anchorEntity = spaceRuntime.getEntity(session, session._space.shipID);
  if (!scene || !anchorEntity) {
    return {
      success: false,
      errorMsg: "SHIP_NOT_FOUND",
    };
  }

  const count = toPositiveInt(options.count, DEFAULT_DEATH_TEST_COUNT);
  const radiusMeters = Math.max(
    3_000,
    toFiniteNumber(options.radiusMeters, DEFAULT_DEATH_TEST_RADIUS_METERS),
  );
  const delayMs = Math.max(
    0,
    toFiniteNumber(options.delayMs, DEFAULT_DEATH_TEST_DELAY_MS),
  );
  const shipType =
    options.shipType ||
    resolveShipByTypeID(options.typeID) ||
    resolveShipByTypeID(anchorEntity.typeID) ||
    null;
  if (!shipType) {
    return {
      success: false,
      errorMsg: "SHIP_TYPE_NOT_FOUND",
    };
  }

  const positions = buildShipDeathPositions(anchorEntity, count, radiusMeters);
  const spawned = [];
  for (const position of positions) {
    const spawnResult = spaceRuntime.spawnDynamicShip(systemID, {
      typeID: shipType.typeID,
      groupID: shipType.groupID,
      categoryID: shipType.categoryID || 6,
      itemName: shipType.name,
      ownerID: 0,
      characterID: 0,
      corporationID: 0,
      allianceID: 0,
      warFactionID: 0,
      position,
      direction: buildRandomDirection(anchorEntity.direction),
      velocity: { x: 0, y: 0, z: 0 },
      targetPoint: position,
      mode: "STOP",
      speedFraction: 0,
      conditionState: {
        damage: 0,
        charge: 1,
        armorDamage: 0,
        shieldCharge: 1,
        incapacitated: false,
      },
    }, {
      sceneDescriptor: scene.sceneDescriptor || undefined,
    });
    if (spawnResult.success && spawnResult.data && spawnResult.data.entity) {
      spawned.push(spawnResult.data.entity);
    }
  }

  const scheduledDetonation = queuePendingDeathTest({
    systemID,
    sceneDescriptor: scene.sceneDescriptor || null,
    ownerCharacterID: session.characterID,
    shipType,
    spawnedEntityIDs: spawned.map((entity) => entity.itemID),
    spawnedCount: spawned.length,
    delayMs,
  });

  return {
    success: true,
    data: {
      shipType,
      radiusMeters,
      delayMs,
      spawned,
      completionPromise: scheduledDetonation.completionPromise,
      detonateAtSimMs: scheduledDetonation.completeAtSimMs,
    },
  };
}

module.exports = {
  prepareDurableShipDeath,
  settleDurableShipDeath,
  finishDurableShipDeathHandoff,
  finishDurablePodDeath,
  destroyCapsuleEntityWithCorpse,
  destroyShipEntityWithWreck,
  destroyShipEntityWithoutWreck,
  destroySessionShip,
  spawnShipDeathTestField,
};

module.exports._testing = {
  destroyCapsuleEntityWithCorpse,
  destroyShipEntityWithWreck,
  destroyShipEntityWithoutWreck,
  resolveShipDestructionScene,
  resolveEntityWreckType,
  resolveShipWreckType,
  buildShipDeathPositions,
  processPendingDeathTests,
  purgeDestroyedShipEntityFromScene,
  clearPendingDeathTests() {
    pendingDeathTests.clear();
    clearPendingDeathTestTimer();
  },
};
