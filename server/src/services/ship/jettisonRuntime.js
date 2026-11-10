"use strict";

const path = require("path");
const log = require(path.join(__dirname, "../../utils/logger"));
const {
  ITEM_FLAGS,
  findItemById,
  isCargoContainerInventoryItem,
  listContainerItems,
} = require(path.join(__dirname, "../inventory/itemStore"));
const itemCustody = require(path.join(__dirname, "../inventory/itemCustody"));
const {
  resolveItemByName,
} = require(path.join(__dirname, "../inventory/itemTypeRegistry"));
const {
  isDisposableJetcanRecord,
} = require(path.join(__dirname, "../inventory/cargoLootAuthority"));
const spaceRuntime = require(path.join(__dirname, "../../space/runtime"));
const {
  buildChildEntityScopeMetadata,
} = require(path.join(
  __dirname,
  "../../space/destiny/identity/interactionScope.js",
));
const {
  resolveAbyssalPlayerLaunchScope,
} = require(path.join(__dirname, "../_shared/abyssalPlayerLaunchScope"));
const {
  LOOT_CUSTOM_INFO_KEY,
  buildSpaceLootRightsSnapshot,
} = require(path.join(__dirname, "../_shared/spaceLootEntitlement"));

// CCP parity: jetcans last exactly 2 hours from creation, regardless of
// whether items are added or removed.
const JETCAN_LIFETIME_MS = 2 * 60 * 60 * 1000;
// Creating another jetcan is rate-limited per active session. Players can
// continue adding cargo to an existing can while this timer is active.
const JETTISON_COOLDOWN_MS = 3 * 60 * 1000;

const JETCAN_CONTAINER_NAME = "Cargo Container";
const JETTISON_EFFECT_GUID = "effects.Jettison";
const JETCAN_DESTRUCTION_EFFECT_ID = 3;
const JETCAN_REMOVED_JUNK_LOCATION_ID = 10;
// Retail jetcans store contained rows with flagID 0. The active-ship cargo
// move notification in the golden trace reports {3: canID, 4: 0}.
const JETCAN_CONTENT_FLAG_ID = 0;
// Mirrors inventorycommon.const.jettisonableFlags in the client for ordinary
// ship inventory jettison into a jetcan.
const JETTISONABLE_FLAG_IDS = new Set([
  ITEM_FLAGS.CARGO_HOLD,
  ITEM_FLAGS.GENERAL_MINING_HOLD,
  136, // flagSpecializedMineralHold
  143, // flagSpecializedAmmoHold
  149, // flagSpecializedPlanetaryCommoditiesHold
  172, // flagStructureFuel
  ITEM_FLAGS.SPECIALIZED_GAS_HOLD,
  ITEM_FLAGS.SPECIALIZED_ICE_HOLD,
  ITEM_FLAGS.SPECIALIZED_ASTEROID_HOLD,
  ITEM_FLAGS.COLONY_RESOURCES_HOLD,
  188, // flagExpeditionHold
].map((flagID) => Number(flagID))
  .filter((flagID) => Number.isFinite(flagID) && flagID > 0));

function isJettisonableShipFlag(flagID) {
  return JETTISONABLE_FLAG_IDS.has(Number(flagID) || 0);
}

// --- Private vector helpers (inlined — not exported from any shared module) ---

function getCharacterState() {
  return require(path.join(__dirname, "../character/characterState"));
}

function getFleetRuntime() {
  return require(path.join(__dirname, "../fleets/fleetRuntime"));
}

function getAbyssalMgrService() {
  return require("../../abyssal").jettisonIntegration;
}

// Lazy: cargoContainerRuntime requires this module for isJettisonableShipFlag,
// so requiring it at the top level here would close the cycle.
function getCargoContainerRuntime() {
  return require(path.join(__dirname, "./cargoContainerRuntime"));
}

function hasExplicitSessionSceneIdentity(session) {
  return Boolean(
    session &&
      session._space &&
      (
        String(session._space.sceneKey || session.spaceSceneKey || "").trim() ||
        String(session._space.sceneKind || "").trim().toLowerCase() === "abyssal" ||
        Number(session._space.instanceID || session.spaceInstanceID || 0) > 0
      )
  );
}

function resolveJettisonSceneForSession(session, systemID, entityID = 0) {
  const numericEntityID = Number(entityID) || 0;
  const sessionScene =
    typeof spaceRuntime.getSceneForSession === "function"
      ? spaceRuntime.getSceneForSession(session)
      : null;
  if (
    sessionScene &&
    (
      numericEntityID <= 0 ||
      typeof sessionScene.getEntityByID !== "function" ||
      sessionScene.getEntityByID(numericEntityID)
    )
  ) {
    return sessionScene;
  }

  if (
    numericEntityID > 0 &&
    typeof spaceRuntime.findSceneContainingDynamicEntity === "function"
  ) {
    const containingScene =
      spaceRuntime.findSceneContainingDynamicEntity(numericEntityID);
    if (containingScene) {
      return containingScene;
    }
  }

  if (sessionScene) {
    return sessionScene;
  }
  // An explicit scene key/instance is authoritative. Falling back to a
  // solar-system scene here would leak an Abyssal can into the synthetic host
  // location, so fail closed until that exact scene is available.
  if (hasExplicitSessionSceneIdentity(session)) {
    return null;
  }
  return typeof spaceRuntime.ensureScene === "function"
    ? spaceRuntime.ensureScene(Number(systemID) || 0)
    : null;
}

function getJettisonSceneDescriptor(scene, systemID) {
  return scene && scene.sceneDescriptor
    ? scene.sceneDescriptor
    : Number(systemID) || 0;
}

function emitItemsChangedForSession(...args) {
  const characterState = getCharacterState();
  return typeof characterState.emitItemsChangedForSession === "function"
    ? characterState.emitItemsChangedForSession(...args)
    : false;
}

function syncInventoryItemForSession(...args) {
  const characterState = getCharacterState();
  return typeof characterState.syncInventoryItemForSession === "function"
    ? characterState.syncInventoryItemForSession(...args)
    : false;
}

function buildRemovedJetcanNotificationState(item) {
  if (!item || typeof item !== "object") {
    return null;
  }

  return {
    ...item,
    locationID: JETCAN_REMOVED_JUNK_LOCATION_ID,
    flagID: 0,
    quantity: -1,
    stacksize: 1,
    singleton: 1,
    clientCustomInfo: null,
  };
}

function normalizeSpaceVector(v, fallback = { x: 1, y: 0, z: 0 }) {
  const x = Number(v && v.x || 0);
  const y = Number(v && v.y || 0);
  const z = Number(v && v.z || 0);
  const len = Math.sqrt(x * x + y * y + z * z);
  if (len === 0) {
    return { ...fallback };
  }
  return { x: x / len, y: y / len, z: z / len };
}

function addVectors(a, b) {
  return {
    x: Number(a && a.x || 0) + Number(b && b.x || 0),
    y: Number(a && a.y || 0) + Number(b && b.y || 0),
    z: Number(a && a.z || 0) + Number(b && b.z || 0),
  };
}

function scaleVector(v, scalar) {
  const s = Number(scalar) || 0;
  return {
    x: Number(v && v.x || 0) * s,
    y: Number(v && v.y || 0) * s,
    z: Number(v && v.z || 0) * s,
  };
}

function getJetcanSessionLootContext(session) {
  const fleetID = resolveJetcanSessionFleetID(session);
  return {
    corporationID: Number(
      session && (
        session.corporationID ||
        session.corpid ||
        session.corpID ||
        session._character && session._character.corporationID
      ),
    ) || 0,
    allianceID: Number(
      session && (
        session.allianceID ||
        session.allianceid ||
        session._character && session._character.allianceID
      ),
    ) || 0,
    warFactionID: Number(
      session && (
        session.warFactionID ||
        session.warfactionid ||
        session._character && session._character.warFactionID
      ),
    ) || 0,
    fleetID,
  };
}

function resolveJetcanSessionFleetID(session) {
  const characterRecord = session && session._character ? session._character : {};
  const directFleetID = Number(
    session
      ? session.fleetid ?? session.fleetID ?? characterRecord.fleetid ?? characterRecord.fleetID
      : 0,
  ) || 0;
  if (directFleetID > 0) {
    return directFleetID;
  }

  const characterID = Number(
    session
      ? session.characterID ?? session.charid ?? characterRecord.characterID ?? characterRecord.charid
      : 0,
  ) || 0;
  if (characterID <= 0) {
    return 0;
  }

  try {
    const fleetRuntime = getFleetRuntime();
    if (fleetRuntime && typeof fleetRuntime.getSessionFleetState === "function") {
      const state = fleetRuntime.getSessionFleetState(session);
      const stateFleetID = Number(state && state.fleetid) || 0;
      if (stateFleetID > 0) {
        return stateFleetID;
      }
    }
    if (fleetRuntime && typeof fleetRuntime.getFleetForCharacter === "function") {
      const fleet = fleetRuntime.getFleetForCharacter(characterID);
      const runtimeFleetID = Number(fleet && fleet.fleetID) || 0;
      if (runtimeFleetID > 0) {
        return runtimeFleetID;
      }
    }
    const mappedFleetID = Number(
      fleetRuntime &&
      fleetRuntime.runtimeState &&
      fleetRuntime.runtimeState.characterToFleet instanceof Map
        ? fleetRuntime.runtimeState.characterToFleet.get(characterID)
        : 0,
    ) || 0;
    return mappedFleetID > 0 ? mappedFleetID : 0;
  } catch (_) {
    // ignored: no fleet runtime or mapping means no fleet (0)
    return 0;
  }
}

function buildJetcanLootCustomInfo(session) {
  const context = getJetcanSessionLootContext(session);
  const customInfo = {
    [LOOT_CUSTOM_INFO_KEY]: buildSpaceLootRightsSnapshot(context),
  };

  const shipID = Number(
    session && session._space && session._space.shipID
      ? session._space.shipID
      : session && session.shipID,
  ) || 0;
  const abyssalMgrService = shipID > 0 ? getAbyssalMgrService() : null;
  const activeRun =
    abyssalMgrService &&
    typeof abyssalMgrService.getActiveAbyssalRunForShipID === "function"
      ? abyssalMgrService.getActiveAbyssalRunForShipID(shipID)
      : null;
  if (activeRun && Number(activeRun.instanceID) > 0) {
    const roomIndex = Number(
      activeRun.roomState && activeRun.roomState.currentRoomIndex,
    ) || 0;
    customInfo.evejsAbyssalJettisonContainer = {
      instanceID: Number(activeRun.instanceID) || 0,
      roomIndex,
      traceItemID: Number(activeRun.traceItemID) || 0,
      characterID: Number(session && session.characterID) || 0,
      shipID,
      solarSystemID: Number(
        session && session._space && session._space.systemID
          ? session._space.systemID
          : session && (session.solarsystemid2 || session.solarsystemid),
      ) || 0,
      placeholderContent: true,
    };
  }

  return Object.keys(customInfo).length > 0
    ? JSON.stringify(customInfo)
    : "";
}

function buildNearbySpawnState(
  shipEntity,
  distanceMeters = 275,
  launchScopeMetadata = {},
) {
  const position = {
    x: Number(shipEntity && shipEntity.position && shipEntity.position.x || 0),
    y: Number(shipEntity && shipEntity.position && shipEntity.position.y || 0),
    z: Number(shipEntity && shipEntity.position && shipEntity.position.z || 0),
  };
  const direction = normalizeSpaceVector(
    shipEntity && shipEntity.direction,
    { x: 1, y: 0, z: 0 },
  );
  return {
    ...buildChildEntityScopeMetadata(shipEntity),
    ...(launchScopeMetadata && typeof launchScopeMetadata === "object"
      ? launchScopeMetadata
      : {}),
    position: addVectors(position, scaleVector(direction, Math.max(50, Number(distanceMeters) || 275))),
    velocity: { x: 0, y: 0, z: 0 },
    direction,
    mode: "STOP",
    speedFraction: 0,
  };
}

function syncChangesToSession(session, changes = [], options = {}) {
  for (const change of Array.isArray(changes) ? changes : []) {
    if (!change || !change.item) {
      continue;
    }
    if (options.emitItemsChanged === true) {
      emitItemsChangedForSession(
        session,
        change.item,
        change.previousData || change.previousState || {},
        {
          idType: options.idType,
          locationContext: options.locationContext,
        },
      );
      continue;
    }
    syncInventoryItemForSession(
      session,
      change.item,
      change.previousData || change.previousState || {},
      { emitCfgLocation: true },
    );
  }
}

function hydrateJetcanSessionContext(session, entity) {
  if (!entity) {
    return;
  }
  const context = getJetcanSessionLootContext(session);
  if (context.corporationID > 0) {
    entity.corporationID = context.corporationID;
    entity.lootRightCorpID = context.corporationID;
  }
  if (context.allianceID > 0) {
    entity.allianceID = context.allianceID;
  }
  if (context.warFactionID > 0) {
    entity.warFactionID = context.warFactionID;
  }
  entity.lootRightFleetID = context.fleetID > 0 ? context.fleetID : null;
}

function broadcastJetcanPresentation(session, systemID, containerID) {
  const scene = resolveJettisonSceneForSession(session, systemID);
  if (!scene) {
    return {
      success: false,
      errorMsg: "SCENE_NOT_FOUND",
    };
  }

  const sceneDescriptor = getJettisonSceneDescriptor(scene, systemID);
  const spawnResult = spaceRuntime.spawnDynamicInventoryEntity(
    sceneDescriptor,
    containerID,
    {
      sceneDescriptor: scene.sceneDescriptor || undefined,
      broadcast: false,
    },
  );
  if (!spawnResult || !spawnResult.success) {
    return spawnResult || {
      success: false,
      errorMsg: "SPAWN_FAILED",
    };
  }

  const entity =
    spawnResult.data && spawnResult.data.entity
      ? spawnResult.data.entity
      : scene.getEntityByID(containerID);
  if (!entity) {
    return {
      success: false,
      errorMsg: "ENTITY_NOT_FOUND",
    };
  }

  hydrateJetcanSessionContext(session, entity);
  // The can's add, built by the next tick's bubble update, has no loot
  // rights; they follow (announceJettisonedCargo).
  entity.deferLootRightsSlimUpdate = true;
  scene.broadcastAddBalls([entity], null, {
    freshAcquire: true,
  });
  scene.broadcastSpecialFx(entity.itemID, JETTISON_EFFECT_GUID, {
    moduleID: null,
    moduleTypeID: null,
    targetID: null,
    chargeTypeID: null,
    isOffensive: false,
    start: true,
    active: false,
    duration: -1,
  }, entity);
  return {
    success: true,
    data: {
      entity,
    },
  };
}

function broadcastJetcanLootRightsSlimUpdate(session, systemID, containerID) {
  const scene = resolveJettisonSceneForSession(
    session,
    systemID,
    containerID,
  );
  const entity = scene && scene.getEntityByID(containerID);
  if (!scene || !entity) {
    return false;
  }
  hydrateJetcanSessionContext(session, entity);
  entity.deferLootRightsSlimUpdate = false;
  scene.broadcastSlimItemChanges([entity]);
  return true;
}

// TQ (golden log "Jettison ore - deploy mobile tractor beam - let it loot -
// open cargo and then scoop cargo", ticks 29461-29463): the can's AddBalls2,
// without loot rights, and effects.Jettison leave on one tick; the cargo's
// OnItemsChanged follows that batch, and the loot rights come after it as an
// OnSlimItemChange. The cargo has moved already: only the notices wait,
// and they still go if the pilot leaves the system first.
function announceJettisonedCargo(session, systemID, containerID, cargoChanges) {
  const announce = () => {
    for (const changes of cargoChanges) {
      syncChangesToSession(session, changes, {
        emitItemsChanged: true,
        idType: "shipid",
      });
    }
    broadcastJetcanLootRightsSlimUpdate(session, systemID, containerID);
  };
  const scene = resolveJettisonSceneForSession(session, systemID, containerID);
  const observed = Boolean(
    scene &&
    typeof scene.afterDestinyBatch === "function" &&
    scene.sessions instanceof Map &&
    session &&
    scene.sessions.get(session.clientID) === session,
  );
  if (!observed || !scene.afterDestinyBatch(session, announce, { runIfLeft: true })) {
    announce();
  }
}

// --- Public API ---

/**
 * After an item is removed from a space container, check whether the container
 * is now empty. If so, remove it from the DB and despawn it from the scene
 * immediately rather than waiting for the 2-hour expiry timer.
 *
 * Only acts on actual temporary Cargo Container records (typeID 23). Other
 * expiring space inventory hosts, such as Mobile Tractor Units and wrecks,
 * must remain authoritative after their last contained item is removed.
 *
 * @param {object} session - Active player session.
 * @param {number} containerID - The item ID of the container to check.
 */
function maybeExpireEmptySpaceContainer(session, containerID) {
  const numericID = Number(containerID) || 0;
  if (numericID <= 0) {
    return;
  }

  const container = findItemById(numericID);
  if (!container) {
    return;
  }

  // Expiry metadata is shared by several space entities. Type identity is the
  // authority boundary: only the disposable jetcan type may be removed here.
  if (!isDisposableJetcanRecord(container)) {
    return;
  }

  // Check if any items remain inside, regardless of who owns them.
  const contents = listContainerItems(null, numericID, null);
  if (contents.length > 0) {
    return;
  }

  const systemID = Number(container.locationID) || 0;

  log.info(
    `[Jettison] Container ${numericID} is now empty — despawning early`,
  );

  const removeResult = itemCustody.transfer({
    items: { itemID: numericID },
    from: itemCustody.custodyRef.inSpace(
      Number(container.ownerID) || 0,
      systemID,
    ),
    to: itemCustody.custodyRef.void(),
    reason: itemCustody.CUSTODY_REASON.JETCAN_EMPTY_REMOVE,
    actor: Number(session && session.characterID) || null,
    idempotencyKey: `jetcan-empty-remove:${numericID}`,
    options: { removeContents: false },
  });
  if (!removeResult.success) {
    log.warn(
      `[Jettison] Failed to remove empty container ${numericID}: ${removeResult.errorMsg}`,
    );
    return;
  }

  // Notify the client that the container item was removed.
  for (const change of (removeResult.data && removeResult.data.changes) || []) {
    if (!change || change.removed !== true || !change.previousData) {
      continue;
    }
    const removedState = buildRemovedJetcanNotificationState(change.previousData);
    if (!removedState) {
      continue;
    }
    emitItemsChangedForSession(
      session,
      removedState,
      change.previousData,
      { idType: "charid" },
    );
  }

  const abyssalMgrService = getAbyssalMgrService();
  if (
    abyssalMgrService &&
    typeof abyssalMgrService.handleAbyssalRewardLootContainerRemoved === "function"
  ) {
    try {
      abyssalMgrService.handleAbyssalRewardLootContainerRemoved(
        container,
        "empty-container-despawn",
      );
    } catch (error) {
      log.warn(
        `[Jettison] Failed to reconcile Abyssal reward container ${numericID}: ${error && error.message || error}`,
      );
    }
  }

  // Remove the space ball from the exact authoritative scene so an Abyssal
  // container cannot leave a ghost in its isolated run.
  if (systemID > 0) {
    const scene = resolveJettisonSceneForSession(
      session,
      systemID,
      numericID,
    );
    const sceneDescriptor = getJettisonSceneDescriptor(scene, systemID);
    spaceRuntime.removeDynamicEntity(sceneDescriptor, numericID, {
      sceneDescriptor: scene && scene.sceneDescriptor || undefined,
      terminalDestructionEffectID: JETCAN_DESTRUCTION_EFFECT_ID,
      persistSpaceState: false,
    });
  }
}

/**
 * Handle the client's Jettison RPC, which covers two distinct operations:
 *
 * - Loose cargo is jettisoned into a new Cargo Container spawned 275 m ahead of
 *   the ship.
 * - A player-deployed cargo container is *launched* — it becomes the can
 *   itself, keeping its own itemID and its contents. The client reaches this
 *   through the "Launch for Self" menu entry, which TQ wires to this same RPC.
 *
 * @param {object} session - Active player session with _space context.
 * @param {number[]} itemIDs - Item IDs to jettison (must be in ship cargo hold).
 * @returns {{ success: boolean, errorMsg?: string, jettisonedToCanIDs?: number[], launchedItemIDs?: number[], notJettisonedIDs?: number[], containerID?: number }}
 */
function jettisonItemsForSession(session, itemIDs) {
  const characterID = Number(session && session.characterID) || 0;
  const space = session && session._space;
  const shipID = Number(space && space.shipID) || 0;
  const systemID = Number(space && space.systemID) || 0;

  if (!characterID || !shipID || !systemID) {
    log.warn("[Jettison] Session missing character/ship/system context");
    return { success: false, errorMsg: "INVALID_SESSION" };
  }

  if (!Array.isArray(itemIDs) || itemIDs.length === 0) {
    return {
      success: false,
      errorMsg: "NO_ITEMS",
      notJettisonedIDs: [],
    };
  }

  const requestedItemIDs = [
    ...new Set(itemIDs.map((itemID) => Number(itemID) || 0)),
  ].filter((itemID) => itemID > 0);
  if (requestedItemIDs.length === 0) {
    return {
      success: false,
      errorMsg: "NO_ITEMS",
      notJettisonedIDs: [],
    };
  }

  // Refuse before materializing a jetcan or launching a container. Custody
  // also protects the accepted tree, but a late refusal leaves an empty can.
  if (require("./airDeathRestrictions").shipPending(characterID, shipID)) {
    return {
      success: false,
      errorMsg: "SHIP_DESTRUCTION_IN_PROGRESS",
      notJettisonedIDs: requestedItemIDs,
      jettisonedToCanIDs: [],
      launchedItemIDs: [],
    };
  }

  const simTimeMs = spaceRuntime.getSimulationTimeMsForSession(
    session,
    Date.now(),
  );

  // TQ routes the client's "Launch for Self" entry for a player-deployed
  // container (menusvc -> OfferLaunchForSelf_Container) back through this very
  // RPC; there is no separate launch call on the ship moniker. So one request
  // can carry two different operations. A container must not be packed into a
  // fresh jetcan — it *becomes* the can, keeping its own itemID and contents.
  const notJettisonedIDs = [];
  const containerItemIDs = [];
  const looseItemIDs = [];
  for (const itemID of requestedItemIDs) {
    const item = findItemById(itemID);
    if (item && isCargoContainerInventoryItem(item)) {
      containerItemIDs.push(itemID);
      continue;
    }
    looseItemIDs.push(itemID);
  }

  // Reuse the deploy path Ship.Drop already uses rather than writing a second
  // "materialise a container in space". It owns the ownership/hold/assembly and
  // Abyssal-scope validation plus the spawn rollback. Deliberately no
  // IsAnchorable() exclusion: the client's other menu entry for anchorable
  // containers lands on this same function via Drop, so excluding them here
  // would only reintroduce this bug for a subset.
  const launchedItemIDs = [];
  for (const itemID of containerItemIDs) {
    let launchResult = null;
    try {
      launchResult = getCargoContainerRuntime().launchCargoContainerFromShip(
        session,
        itemID,
      );
    } catch (error) {
      launchResult = {
        success: false,
        errorMsg: String(error && error.message || "CONTAINER_LAUNCH_FAILED"),
      };
    }
    if (!launchResult || launchResult.success !== true) {
      log.warn(
        `[Jettison] Container ${itemID} launch failed: ` +
        `${launchResult && launchResult.errorMsg || "CONTAINER_LAUNCH_FAILED"}`,
      );
      notJettisonedIDs.push(itemID);
      continue;
    }
    launchedItemIDs.push(itemID);
  }

  if (looseItemIDs.length === 0) {
    if (launchedItemIDs.length === 0) {
      log.warn(
        `[Jettison] No valid cargo items to jettison for char=${characterID}`,
      );
      return {
        success: false,
        errorMsg: "NO_VALID_ITEMS",
        notJettisonedIDs,
        launchedItemIDs,
      };
    }
    log.info(
      `[Jettison] char=${characterID} launched ${launchedItemIDs.length} container(s) into space`,
    );
    return {
      success: true,
      jettisonedToCanIDs: [],
      launchedItemIDs,
      notJettisonedIDs,
    };
  }

  // The cooldown rate-limits jetcan *creation*. A container launch mints no
  // can, so it is settled above this gate.
  const cooldownUntilMs = Math.max(
    0,
    Number(session._jettisonCooldownUntilMs) || 0,
  );
  if (cooldownUntilMs > simTimeMs) {
    return {
      success: launchedItemIDs.length > 0,
      errorMsg: "JETTISON_COOLDOWN",
      retryAfterMs: cooldownUntilMs - simTimeMs,
      notJettisonedIDs: [...notJettisonedIDs, ...looseItemIDs],
      jettisonedToCanIDs: [],
      launchedItemIDs,
    };
  }

  // Validate each remaining item: must be owned by this character and in a
  // client-jettisonable ship hold.
  const validItems = [];
  for (const itemID of looseItemIDs) {
    const item = findItemById(itemID);
    if (!item) {
      log.warn(`[Jettison] Item ${itemID} not found`);
      notJettisonedIDs.push(itemID);
      continue;
    }
    if (Number(item.ownerID) !== characterID) {
      log.warn(`[Jettison] Item ${itemID} not owned by char=${characterID}`);
      notJettisonedIDs.push(itemID);
      continue;
    }
    if (Number(item.locationID) !== shipID || !isJettisonableShipFlag(item.flagID)) {
      log.warn(
        `[Jettison] Item ${itemID} not in a jettisonable ship hold (locationID=${item.locationID}, flagID=${item.flagID})`,
      );
      notJettisonedIDs.push(itemID);
      continue;
    }
    validItems.push(item);
  }

  if (validItems.length === 0) {
    if (launchedItemIDs.length > 0) {
      log.info(
        `[Jettison] char=${characterID} launched ${launchedItemIDs.length} container(s) into space`,
      );
      return {
        success: true,
        jettisonedToCanIDs: [],
        launchedItemIDs,
        notJettisonedIDs,
      };
    }
    log.warn(`[Jettison] No valid cargo items to jettison for char=${characterID}`);
    return {
      success: false,
      errorMsg: "NO_VALID_ITEMS",
      notJettisonedIDs,
      launchedItemIDs,
    };
  }

  // Resolve the container type.
  const containerLookup = resolveItemByName(JETCAN_CONTAINER_NAME);
  if (!containerLookup.success || !containerLookup.match) {
    log.warn(`[Jettison] Could not resolve container type "${JETCAN_CONTAINER_NAME}"`);
    return {
      success: false,
      errorMsg: "CONTAINER_TYPE_NOT_FOUND",
      notJettisonedIDs,
      launchedItemIDs,
    };
  }

  // Create the container in space near the ship.
  const shipEntity = spaceRuntime.getEntity(session, shipID);
  const launchScene = typeof spaceRuntime.getSceneForSession === "function"
    ? spaceRuntime.getSceneForSession(session)
    : null;
  const launchScope = resolveAbyssalPlayerLaunchScope(
    session,
    shipEntity,
    launchScene,
  );
  if (launchScope.valid !== true) {
    return {
      success: launchedItemIDs.length > 0,
      errorMsg: "ABYSSAL_LAUNCH_SCOPE_INVALID",
      notJettisonedIDs: [...notJettisonedIDs, ...looseItemIDs],
      jettisonedToCanIDs: [],
      launchedItemIDs,
    };
  }

  const createResult = itemCustody.transfer({
    items: {
      itemType: containerLookup.match,
      quantity: 1,
      options: {
        ...buildNearbySpawnState(shipEntity, 275, launchScope.metadata),
        createdAtMs: simTimeMs,
        expiresAtMs: simTimeMs + JETCAN_LIFETIME_MS,
        launcherID: shipID,
        customInfo: buildJetcanLootCustomInfo(session),
      },
    },
    from: null,
    to: itemCustody.custodyRef.inSpace(characterID, systemID),
    reason: itemCustody.CUSTODY_REASON.JETTISON_CONTAINER_CREATE,
    actor: characterID,
    idempotencyKey: `jettison-container:${characterID}:${shipID}:${simTimeMs}`,
  });

  if (!createResult.success || !createResult.data || !createResult.data.item) {
    log.warn(`[Jettison] Container creation failed: ${createResult.errorMsg}`);
    return {
      success: launchedItemIDs.length > 0,
      errorMsg: "CONTAINER_CREATE_FAILED",
      notJettisonedIDs: [...notJettisonedIDs, ...looseItemIDs],
      jettisonedToCanIDs: [],
      launchedItemIDs,
    };
  }

  const containerID = Number(createResult.data.item.itemID);

  // Retail presents the new ball and jettison FX before the cargo row moves
  // from the ship hold into the can.
  let presentationResult = null;
  try {
    presentationResult = broadcastJetcanPresentation(
      session,
      systemID,
      containerID,
    );
  } catch (error) {
    presentationResult = {
      success: false,
      errorMsg: String(error && error.message || "SPAWN_FAILED"),
    };
  }
  if (!presentationResult || !presentationResult.success) {
    log.warn(
      `[Jettison] Container ${containerID} presentation failed: ` +
      `${presentationResult && presentationResult.errorMsg || "SPAWN_FAILED"}`,
    );
    const presentationScene = resolveJettisonSceneForSession(
      session,
      systemID,
      containerID,
    );
    if (
      presentationScene &&
      typeof presentationScene.getEntityByID === "function" &&
      presentationScene.getEntityByID(containerID) &&
      typeof presentationScene.removeDynamicEntity === "function"
    ) {
      presentationScene.removeDynamicEntity(containerID, {
        broadcast: true,
        persistSpaceState: false,
      });
    }
    const rollbackResult = itemCustody.transfer({
      items: { itemID: containerID },
      from: itemCustody.custodyRef.inSpace(characterID, systemID),
      to: itemCustody.custodyRef.void(),
      reason: itemCustody.CUSTODY_REASON.JETTISON_CONTAINER_ROLLBACK,
      actor: characterID,
      idempotencyKey: `jettison-container-rollback:${containerID}`,
      options: { removeContents: true },
    });
    if (!rollbackResult || rollbackResult.success !== true) {
      log.error(
        `[Jettison] Failed to roll back unpublished container ${containerID}: ` +
        `${rollbackResult && rollbackResult.errorMsg || "REMOVE_FAILED"}`,
      );
    }
    return {
      success: launchedItemIDs.length > 0,
      errorMsg: "CONTAINER_PRESENTATION_FAILED",
      notJettisonedIDs: [...notJettisonedIDs, ...looseItemIDs],
      jettisonedToCanIDs: [],
      launchedItemIDs,
    };
  }

  // Move each valid item into the container.
  const jettisonedToCanIDs = [];
  const cargoChanges = [];
  for (const item of validItems) {
    const moveResult = itemCustody.transfer({
      items: { itemID: item.itemID },
      from: itemCustody.custodyRef.shipBay(
        Number(item.ownerID) || 0,
        shipID,
        item.flagID,
      ),
      to: itemCustody.custodyRef.container(
        Number(item.ownerID) || 0,
        containerID,
        JETCAN_CONTENT_FLAG_ID,
      ),
      reason: itemCustody.CUSTODY_REASON.JETTISON_CARGO_MOVE,
      actor: characterID,
      idempotencyKey: `jettison-cargo:${containerID}:${item.itemID}`,
    });
    if (!moveResult.success) {
      log.warn(
        `[Jettison] Failed to move item ${item.itemID} into container ${containerID}: ${moveResult.errorMsg}`,
      );
      notJettisonedIDs.push(item.itemID);
      continue;
    }
    jettisonedToCanIDs.push(item.itemID);
    cargoChanges.push((moveResult.data && moveResult.data.changes) || []);
  }

  announceJettisonedCargo(session, systemID, containerID, cargoChanges);

  if (jettisonedToCanIDs.length === 0) {
    log.warn(`[Jettison] All item moves failed for container ${containerID}`);
    return {
      success: launchedItemIDs.length > 0,
      errorMsg: "MOVE_FAILED",
      notJettisonedIDs,
      jettisonedToCanIDs: [],
      launchedItemIDs,
    };
  }

  session._jettisonCooldownUntilMs = simTimeMs + JETTISON_COOLDOWN_MS;

  log.info(
    `[Jettison] char=${characterID} jettisoned ${jettisonedToCanIDs.length} item(s) into container ${containerID} (expires in 2h)`,
  );

  return {
    success: true,
    jettisonedToCanIDs,
    launchedItemIDs,
    notJettisonedIDs,
    containerID,
  };
}

module.exports = {
  JETTISON_COOLDOWN_MS,
  JETCAN_LIFETIME_MS,
  JETTISONABLE_FLAG_IDS,
  jettisonItemsForSession,
  isDisposableJetcanRecord,
  isJettisonableShipFlag,
  maybeExpireEmptySpaceContainer,
  _testing: {
    broadcastJetcanPresentation,
    getJettisonSceneDescriptor,
    hasExplicitSessionSceneIdentity,
    resolveJettisonSceneForSession,
  },
};
