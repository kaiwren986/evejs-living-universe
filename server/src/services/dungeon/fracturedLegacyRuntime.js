"use strict";

// These three sites use mining, cargo and hacking outcomes, never combat
// clearance. Existing owners retain finite ore, inventory and hacking receipts.
const { isDeepStrictEqual } = require("node:util");
const DUNGEONS = Object.freeze({ 17130: 13338, 17131: 13339, 17132: 13340 });
const runtime = () => require("./dungeonRuntime");

function contract(template) {
  const policy = template?.fracturedLegacy;
  return policy?.version === 1 && policy.epicArcID === 128 && Number.isSafeInteger(policy.missionID) &&
    DUNGEONS[policy.missionID] === Number(template.sourceDungeonID) &&
    Array.isArray(template.requiresMechanics) && template.requiresMechanics.includes("fractured-legacy-v1") ? policy : null;
}

function isRock(entity) {
  if (entity?.dungeonMaterializedMiningRock !== true) return false;
  const instance = runtime().getInstance(entity.dungeonSiteInstanceID);
  const template = instance && require("./dungeonAuthority").getTemplateByID(instance.templateID);
  return Boolean(contract(template) && template.populationHints?.miningRocks?.some(rock =>
    Number(rock.dunObjectID) === Number(entity.dunObjectID) &&
    Number(rock.typeID || rock.oreTypeID) === Number(entity.miningYieldTypeID)));
}

function miningFacts(instance, template = null) {
  const policy = contract(template ||= instance && require("./dungeonAuthority").getTemplateByID(instance.templateID));
  const ownerID = Number(instance?.ownership?.missionOwnerCharacterID || instance?.ownership?.characterID);
  const rocks = new Map((policy ? template.populationHints?.miningRocks || [] : [])
    .map(rock => [Number(rock.dunObjectID), rock]));
  const seen = new Set();
  const rows = Object.values(instance?.spawnState?.missionMining?.extractionsByKey || {})
    .filter(row => {
      const rock = rocks.get(Number(row?.dunObjectID));
      const integer = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;
      if (!policy || !(ownerID > 0) || !integer(instance?.instanceID) || !rock || row.status !== "complete" ||
          Number(row.characterID) !== ownerID || Number(row.typeID) !== Number(rock.oreTypeID || rock.typeID) ||
          ![row.rockID, row.shipID, row.moduleID, row.cycleAtMs, row.quantity, row.normalQuantity].every(integer) ||
          !Number.isSafeInteger(Number(row.wastedQuantity)) || Number(row.wastedQuantity) < 0 ||
          !Number.isSafeInteger(Number(row.beforeState?.remainingQuantity)) ||
          !Number.isSafeInteger(Number(row.afterState?.remainingQuantity)) ||
          Number(row.afterState.remainingQuantity) < 0 ||
          Number(row.beforeState.remainingQuantity) > Number(rock.quantity) ||
          Number(row.beforeState.remainingQuantity) - Number(row.afterState.remainingQuantity) !==
            Number(row.normalQuantity) + Number(row.wastedQuantity)) return false;
      const expected = `mission-mine:${instance.instanceID}:${row.rockID}:${row.shipID}:${row.moduleID}:${row.cycleAtMs}`;
      if (row.grantKey !== expected || seen.has(expected)) return false;
      seen.add(expected);
      return true;
    });
  // Native object identity survives cold rematerialization; runtime ball IDs do
  // not. A second complete journal row for the same rock cannot be another goal.
  const depleted = new Map();
  for (const row of rows) if (Number(row.afterState.remainingQuantity) === 0) depleted.set(Number(row.dunObjectID), row);
  const initial = new Set(policy?.mining?.initialObjectIDs || []);
  const finalID = Number(policy?.mining?.finalObjectID);
  const rubble = new Set(policy?.mining?.rockObjectIDs || []);
  const finalRows = rows.filter(row => Number(row.dunObjectID) === finalID);
  return {
    initialDepleted: [...depleted.keys()].filter(id => initial.has(id)).length,
    finalDepleted: depleted.has(finalID),
    rubbleDepleted: [...depleted.keys()].some(id => rubble.has(id)),
    isotopeMined: rows.filter(row => Number(row.typeID) === Number(policy?.mining?.targetTypeID))
      .reduce((sum, row) => sum + Number(row.quantity), 0),
    finalFraction: Math.min(1, finalRows.reduce((sum, row) => sum + Number(row.normalQuantity) + Number(row.wastedQuantity), 0) /
      (Number(rocks.get(finalID)?.quantity) || 1)),
  };
}

function hacked(instance, objectID) {
  return instance.spawnState?.hackingContainers?.[`container:${objectID}`]?.state === 2;
}

function ownerShip(scene, instance) {
  const ownerID = Number(instance.ownership?.missionOwnerCharacterID || instance.ownership?.characterID);
  if (!(ownerID > 0) || !scene?.getDynamicEntities) return null;
  return scene.getDynamicEntities().find(entity => entity.session &&
    Number(entity.characterID || entity.pilotCharacterID || entity.session.characterID || entity.ownerID) === ownerID &&
    Number(entity.dungeonCurrentInstanceID) === Number(instance.instanceID));
}

function entities(scene, instance) {
  return [...(scene.staticEntities || []), ...scene.getDynamicEntities()]
    .filter(entity => Number(entity.dungeonSiteInstanceID) === Number(instance.instanceID));
}

function cargoHas(ship, instance, typeID) {
  if (!ship) return false;
  const items = require("../inventory/itemStore");
  const ownerID = Number(instance.ownership?.missionOwnerCharacterID || instance.ownership?.characterID);
  return items.listOwnedItems(ownerID).some(item => Number(item.typeID) === typeID &&
    Number(item.locationID) === Number(ship.itemID) &&
    Number(item.flagID) === items.ITEM_FLAGS.CARGO_HOLD && Number(item.quantity) > 0);
}

function surfaceDistance(left, right) {
  if (!left?.position || !right?.position) return Infinity;
  return Math.max(0, Math.hypot(left.position.x - right.position.x,
    left.position.y - right.position.y, left.position.z - right.position.z) -
    Math.max(0, Number(left.radius) || 0) - Math.max(0, Number(right.radius) || 0));
}

function initialMiningStage(depleted) {
  return depleted >= 15 ? "FinalAsteroid" : depleted >= 10 ? "SecondaryAsteroids" :
    depleted >= 5 ? "InitialAsteroids" : "Default";
}

function canHack(scene, ship, target) {
  const current = runtime().getInstance(target?.dungeonSiteInstanceID);
  const template = current && require("./dungeonAuthority").getTemplateByID(current.templateID);
  const policy = contract(template);
  if (!policy) return true;
  const instance = runtime().getPersistedInstance(current.instanceID);
  if (!instance || !["seeded", "active", "paused"].includes(instance.lifecycleState) ||
      ownerShip(scene, instance) !== ship || Number(ship?.dungeonCurrentInstanceID) !== Number(instance.instanceID) ||
      scene?.getEntityByID?.(ship?.itemID) !== ship || scene.getEntityByID(target?.itemID) !== target ||
      target.dungeonMaterializedContainer !== true) return false;
  const objectID = Number(target.dunObjectID || target.dungeonSourceObjectID);
  const declared = template.populationHints?.containers?.some(container =>
    Number(container.dunObjectID) === objectID && Number(container.typeID) === Number(target.typeID) &&
    container.contentKey === target.dungeonSiteContentKey);
  if (!declared) return false;
  const facts = miningFacts(instance, template);
  if (policy.missionID === 17130) return objectID === 1347607 && facts.initialDepleted >= 15 && facts.finalDepleted;
  if (policy.missionID !== 17132 || ![1354485, 1354486].includes(objectID)) return false;
  const other = objectID === 1354485 ? 1354486 : 1354485;
  return facts.rubbleDepleted && Boolean(instance.spawnState?.fracturedLegacy?.proximityAtMs) && !hacked(instance, other);
}

function canSpawnEncounter(instance, template, plan) {
  if (!contract(template) || plan.key !== "becker-arrival") return true;
  return Number(instance.spawnState?.fracturedLegacy?.proximityAtMs) > 0;
}

function canMaterializeStructure(instance, template, entry) {
  return !contract(template)?.sceneActions || !template.requiresMechanics?.includes("epic-scene-actions-v1") ||
    (instance.spawnState?.populationHints || template.populationHints)?.epicSceneActionsVersion !== 1 ||
    require("./fracturedLegacySceneActions").canMaterializeStructure(instance, entry);
}

function buildValues(instance, template, scene = null) {
  const policy = contract(template);
  if (!policy) return null;
  const state = instance.spawnState?.fracturedLegacy || {};
  const scoped = scene ? entities(scene, instance) : [];
  const byType = typeID => scoped.find(entity => Number(entity.slimTypeID || entity.typeID) === typeID);
  const entry = template.siteSceneProfile?.roomProfiles?.find(room => room.roomKey === "room:entry" || room.initialState === "active");
  const values = { dungeon_state: state.stage || "Default", lobby_room_id: Number(entry?.roomID) || null };
  if (policy.missionID === 17130) Object.assign(values, {
    asteroids_depleted: state.initialDepleted || 0, asteroids_depleted_goal: 15,
    final_asteroid_ore_mined_fraction: state.finalFraction || 0,
    "final_asteroid.dungeon_object_id": 1348032,
    "hackable_structure.dungeon_object_id": 1347607,
    phased_asteroid_item_id: scoped.find(entity => Number(entity.typeID) === 90449 &&
      Number(entity.dunObjectID || entity.dungeonSourceObjectID) === 1350275)?.itemID || null,
    "closest_initial_asteroid.item_id": byType(1230)?.itemID || null,
  });
  if (policy.missionID === 17131) Object.assign(values, {
    "ship.item_id": byType(90423)?.itemID || null,
    ship_cargo_used: state.deliveredQuantity || 0, ship_cargo_used_goal: 4000,
  });
  if (policy.missionID === 17132) Object.assign(values, {
    "structure.item_id": byType(90424)?.itemID || null, structure_proximity: 12000,
    "hackable_destroy.dungeon_object_id": 1354485,
    "hackable_transmit.dungeon_object_id": 1354486,
  });
  return values;
}

function tick(scene, input, nowMs) {
  const template = input && require("./dungeonAuthority").getTemplateByID(input.templateID);
  const policy = contract(template);
  if (!policy || !["seeded", "active", "paused"].includes(input.lifecycleState)) return false;
  // New progression milestones and visual anchors share the movement owner's
  // native clock. Saved anchors are immutable; clock-free mocks retain input.
  if (typeof scene?.getCurrentSimTimeMs === "function") {
    nowMs = Number(scene.getCurrentSimTimeMs());
    if (!Number.isFinite(nowMs) || nowMs < 0) throw new Error("FRACTURED_SCENE_CLOCK_UNAVAILABLE");
  }
  const ship = ownerShip(scene, input);
  if (!ship) return false;
  let instance = runtime().getPersistedInstance(input.instanceID);
  if (!instance) instance = runtime().mergeSpawnState(input.instanceID, {
    fracturedLegacy: input.spawnState?.fracturedLegacy || { stage: "Default" },
  }, { nowMs, durable: true, force: true });
  require("./fracturedLegacySceneActions").tick(scene, instance, template, ship, nowMs);
  instance = runtime().getPersistedInstance(input.instanceID) || instance;
  const previous = instance.spawnState?.fracturedLegacy || {};
  const state = { ...previous }, facts = miningFacts(instance);
  let complete = Boolean(previous.completedAtMs);
  if (policy.missionID === 17130) {
    state.initialDepleted = facts.initialDepleted;
    state.finalFraction = facts.finalFraction;
    state.stage = initialMiningStage(facts.initialDepleted);
    if (facts.initialDepleted >= 15 && facts.finalDepleted) {
      state.stage = hacked(instance, 1347607) ? "AcquireItem" : "HackStructure";
      complete ||= hacked(instance, 1347607) && cargoHas(ship, instance, 90354);
    }
  } else if (policy.missionID === 17131) {
    state.stage = facts.isotopeMined > 0 ? "TargetMined" : "Default";
    const deliveryOwner = require("../inventory/fracturedLegacyCargo");
    const delivery = deliveryOwner.reconcileDelivery(input);
    if (!delivery.success) return false;
    deliveryOwner.publishRecoveredDelivery(delivery, ship.session);
    state.deliveredQuantity = delivery.deliveredQuantity;
    complete ||= facts.isotopeMined >= 4000 && state.deliveredQuantity >= 4000;
  } else {
    state.stage = facts.rubbleDepleted ? "AsteroidDepleted" : "Default";
    const structure = entities(scene, instance).find(entity => Number(entity.typeID) === 90424);
    if (facts.rubbleDepleted && surfaceDistance(ship, structure) <= 12000 && !state.proximityAtMs) state.proximityAtMs = Math.max(1, nowMs);
    if (state.proximityAtMs) state.stage = previous.proximityAtMs ? "TransmitOrDestroy" : "StructureProximity";
    if (state.proximityAtMs && facts.rubbleDepleted) {
      if (hacked(instance, 1354486)) state.branch = "transmit";
      else if (hacked(instance, 1354485)) state.branch = "destroy";
      if (state.branch) {
        // Hacking receipts use wall time; scene effects use simulation time.
        // Fence this stage's simulation anchor once, preserving it on recovery
        // and leaving an already advanced legacy stage without a new pulse.
        if (!state.branchStartedAtMs && !previous.branch) state.branchStartedAtMs = Math.max(1, nowMs);
        state.stage = state.branch === "transmit" ? "HackedTransmit" : "HackedDestroy";
        complete ||= cargoHas(ship, instance, state.branch === "transmit" ? 90566 : 90565);
      }
    }
  }
  if (complete) { state.stage = "Success"; state.completedAtMs ||= Math.max(1, nowMs); }
  if (!isDeepStrictEqual(state, previous) ||
      !isDeepStrictEqual(runtime().getInstance(instance.instanceID)?.spawnState?.fracturedLegacy, previous)) {
    instance = runtime().mergeSpawnState(instance.instanceID, { fracturedLegacy: state }, { nowMs, durable: true, force: true });
  }
  if (complete && !instance.objectiveSatisfiedAtMs) {
    runtime().markInstanceObjectiveSatisfied(instance.instanceID, { nowMs, reason: "fractured_legacy_actions_completed" });
    instance = runtime().mergeSpawnState(instance.instanceID, { fracturedLegacy: state }, { nowMs, durable: true, force: true });
  }
  require("./fracturedLegacySceneActions").tick(scene, runtime().getInstance(instance.instanceID) || instance, template, ship, nowMs);
  const values = buildValues(instance, template, scene), serialized = JSON.stringify(values);
  scene._fracturedLegacyValues ||= new Map();
  if (scene._fracturedLegacyValues.get(instance.instanceID) !== serialized) {
    require("./dungeonTrackingRuntime").notifyDungeonValuesForScene(scene, instance, values);
    scene._fracturedLegacyValues.set(instance.instanceID, serialized);
  }
  return true;
}

module.exports = { contract, isRock, miningFacts, initialMiningStage, canHack, canSpawnEncounter, canMaterializeStructure, buildValues, tick };
