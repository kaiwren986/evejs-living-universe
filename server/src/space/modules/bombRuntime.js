"use strict";

// Scene-owned unguided ordnance. Ammunition, presentation, targeting and combat
// consequences stay with their existing runtime owners through callbacks.
// A bomb is an Evolve Ball: Evolve moves it and nothing here writes its
// position. It detonates where Evolve has it, from the onProximityFuse park
// hook or at expiry.
const { toFiniteNumber, toInt } = require("../../common/numbers");
const { addVectors, cloneVector, magnitude, normalizeVector,
  scaleVector } = require("../../common/vector");
const { resolveItemByTypeID } = require("../../services/inventory/itemTypeRegistry");
const { getTypeEffectRecords, isChargeCompatibleWithModule } = require("../../services/fitting/liveFittingState");
const { getSolarSystemPseudoSecurity } = require("../../services/security/systemSecurity");
const { canEntitiesInteractLocally } = require("../destiny/identity/interactionScope");
const { applyRuntimeEntityScopeMetadata } = require("../runtime/entityScopeTags");
const { hasDamageableHealth, sumDamageVector } = require("../combat/damage");
const { buildMissileImpactState } = require("../combat/missiles/missileSolver");
const { getEntitySurfaceDistance } = require("../destiny/projection/range");
const { resolveJammerChance } = require("./jammerModuleRuntime");
const { sweptImpact } = require("../destiny/simulation/evolve");

const BOMB_LAUNCHER_GROUP = 862;
const BOMB_GROUPS = new Set([90, 863, 864]);
const flights = new WeakMap();
const sceneProjectiles = new WeakMap();

function isBombLauncher(moduleItem) {
  return toInt(moduleItem && moduleItem.groupID, 0) === BOMB_LAUNCHER_GROUP;
}

function resolveBombLauncherActivation({ scene, entity, moduleItem, chargeItem, snapshot } = {}) {
  if (!isBombLauncher(moduleItem)) return { matched: false };
  const refuse = (errorMsg) => ({ matched: true, success: false, errorMsg });
  if (!chargeItem || toInt(chargeItem.stacksize ?? chargeItem.quantity, 0) <= 0) return refuse("NO_AMMO");
  const moduleType = resolveItemByTypeID(moduleItem.typeID);
  const chargeType = resolveItemByTypeID(chargeItem.typeID);
  if (!moduleType?.published || !chargeType?.published || !(chargeType.graphicID > 0) ||
      !BOMB_GROUPS.has(chargeType.groupID) ||
      !isChargeCompatibleWithModule(moduleItem.typeID, chargeItem.typeID) ||
      !getTypeEffectRecords(chargeItem.typeID).some((effect) => effect.effectID === 2971)) {
    return refuse("UNSUPPORTED_BOMB");
  }
  if (!scene || scene.dynamicEntities.get(entity?.itemID) !== entity || !scene.system ||
      !Number.isFinite(Number(scene.system.security))) return refuse("INVALID_BOMB_SCENE");
  // Current world authority has no corruption state authorizing the installed
  // allowFullyCorruptLowsec exception. Do not infer one from client visuals.
  if (getSolarSystemPseudoSecurity(scene.system) > 0) return refuse("BOMB_IN_EMPIRE_SPACE");
  if (entity.mode === "WARP") return refuse("CANNOT_ACTIVATE_IN_WARP");
  if (!snapshot || !(snapshot.maxVelocity > 0) || !(snapshot.flightTimeMs > 0)) return refuse("UNSUPPORTED_BOMB");
  const attrs = snapshot.chargeAttributes || {};
  const range = Math.max(0, toFiniteNumber(attrs[107], toFiniteNumber(attrs[99], 0)));
  const energy = Math.max(0, toFiniteNumber(attrs[97], 0));
  const jammerStrengthBySensorType = {
    gravimetric: Math.max(0, toFiniteNumber(attrs[238], 0)),
    ladar: Math.max(0, toFiniteNumber(attrs[239], 0)),
    magnetometric: Math.max(0, toFiniteNumber(attrs[240], 0)),
    radar: Math.max(0, toFiniteNumber(attrs[241], 0)),
  };
  if (!(range > 0) || (sumDamageVector(snapshot.rawShotDamage) <= 0 &&
      !(chargeType.groupID === 864 && energy > 0) &&
      !(chargeType.groupID === 863 && Object.values(jammerStrengthBySensorType).some((value) => value > 0)))) {
    return refuse("UNSUPPORTED_BOMB");
  }
  const minimumSpeed = Math.max(0, toFiniteNumber(snapshot.moduleAttributes?.[2608], 0));
  if (magnitude(entity.velocity) + 1e-6 < minimumSpeed) return refuse("BOMB_SHIP_TOO_SLOW");
  return { matched: true, success: true, data: {
    snapshot: { ...snapshot, blastRange: range, energyNeutralization: energy,
      jammerStrengthBySensorType, detonationRange: Math.max(0, toFiniteNumber(attrs[108], 0)) },
  } };
}

function sourceAtLaunch(entity) {
  const result = {};
  for (const key of ["itemID", "typeID", "groupID", "categoryID", "kind", "ownerID",
    "characterID", "pilotCharacterID", "corporationID", "allianceID", "warFactionID",
    "securityStatus", "systemID", "sceneKey", "sceneKind", "instanceScope"]) result[key] = entity[key];
  result.characterID = toInt(entity.session?.characterID, toInt(entity.characterID, 0));
  result.position = Object.freeze(cloneVector(entity.position));
  applyRuntimeEntityScopeMetadata(result, entity);
  return Object.freeze(result);
}

function isOwnedBomb(scene, entity) {
  return Boolean(flights.get(entity)?.scene === scene && scene?.dynamicEntities.get(entity.itemID) === entity);
}

function getRemainingBombTrajectory(scene, bomb, nowMs) {
  const flight = flights.get(bomb);
  if (!isOwnedBomb(scene, bomb) || flight.terminal || bomb.removed || bomb.destroyed ||
      !Number.isFinite(nowMs) || nowMs >= bomb.expiresAtMs) return null;
  // Read from the Ball as Evolve has it: a bomb flies straight, so the rest of
  // its path runs along its velocity until its flight time ends.
  const position = cloneVector(bomb.position);
  return { position,
    endpoint: addVectors(position, scaleVector(bomb.velocity, (bomb.expiresAtMs - nowMs) / 1000)),
    blastRange: flight.snapshot.blastRange, source: flight.source, expiresAtMs: bomb.expiresAtMs };
}

function removeBomb(scene, entity, options = {}) {
  const flight = flights.get(entity);
  if (!isOwnedBomb(scene, entity) || flight.terminal) return false;
  sceneProjectiles.get(scene)?.delete(entity);
  flight.terminal = true;
  entity.removed = true;
  scene.unregisterDynamicEntity(entity, { persistSpaceState: false, ...options });
  return true;
}

function clearSceneBombs(scene) {
  let removed = 0;
  for (const entity of [...(sceneProjectiles.get(scene) || [])]) {
    if (removeBomb(scene, entity, { broadcast: false })) removed += 1;
    else handleEntityRemoved(scene, entity);
  }
  sceneProjectiles.delete(scene);
  return removed;
}

function handleEntityRemoved(scene, entity) {
  const flight = flights.get(entity);
  if (flight?.scene !== scene) return;
  flight.terminal = true;
  sceneProjectiles.get(scene)?.delete(entity);
}

function executeBombLaunchCycle({ scene, entity, moduleItem, chargeItem, effectState, nowMs, callbacks = {} }) {
  if (effectState.bombLaunched === true) return { success: true, data: { duplicate: true } };
  const snapshot = effectState.bombSnapshot;
  const chargeType = resolveItemByTypeID(chargeItem.typeID);
  const direction = normalizeVector(entity.direction, { x: 1, y: 0, z: 0 });
  const position = addVectors(cloneVector(entity.position), scaleVector(direction,
    Math.max(0, toFiniteNumber(entity.radius, 0)) + chargeType.radius + 50));
  const attrs = snapshot.chargeAttributes;
  const bomb = {
    itemID: callbacks.allocateEntityID(), kind: "missile", bombRuntimeEntity: true,
    systemID: scene.systemID, typeID: chargeItem.typeID, groupID: chargeType.groupID,
    categoryID: 8, itemName: chargeType.name, graphicID: chargeType.graphicID,
    ownerID: entity.ownerID, corporationID: entity.corporationID, allianceID: entity.allianceID,
    warFactionID: entity.warFactionID, radius: chargeType.radius,
    position, direction, velocity: scaleVector(direction, snapshot.maxVelocity),
    targetPoint: addVectors(position, scaleVector(direction, snapshot.approxRange * 2)),
    mode: "GOTO", speedFraction: 1, maxVelocity: snapshot.maxVelocity,
    mass: Math.max(1, chargeType.mass), inertia: 0.001, agilitySeconds: 0.001,
    isMassive: true, massive: true, targetEntityID: 0, followRange: 0,
    sourceShipID: entity.itemID, sourceModuleID: moduleItem.itemID,
    sourceModuleTypeID: moduleItem.typeID, launchModules: [moduleItem.itemID],
    missileSnapshot: snapshot, launchedAtMs: nowMs, expiresAtMs: nowMs + snapshot.flightTimeMs,
    // A proximity fuse may not spend a focused bomb outside its own blast:
    // a Focused Void has a 1 m blast and a 35 m proximity attribute.
    proximityFuseRange: Math.min(snapshot.detonationRange, snapshot.blastRange),
    shieldCapacity: Math.max(0, toFiniteNumber(attrs[263], 0)),
    armorHP: Math.max(0, toFiniteNumber(attrs[265], 0)),
    structureHP: Math.max(0, toFiniteNumber(attrs[9], 0)),
    signatureRadius: Math.max(1, toFiniteNumber(attrs[552], chargeType.radius)),
    passiveDerivedState: { attributes: { ...attrs } },
    conditionState: { shieldCharge: 1, armorDamage: 0, damage: 0 },
  };
  applyRuntimeEntityScopeMetadata(bomb, entity);
  const flight = { scene, source: sourceAtLaunch(entity), sourceReference: entity,
    moduleItem: { ...moduleItem }, chargeItem: { ...chargeItem }, snapshot, callbacks, terminal: false };
  flights.set(bomb, flight);
  if (!sceneProjectiles.has(scene)) sceneProjectiles.set(scene, new Set());
  sceneProjectiles.get(scene).add(bomb);
  let spawned;
  try {
    spawned = scene.spawnDynamicEntity(bomb, { broadcast: false, initialPublication: "deferred" });
  } catch (error) {
    callbacks.warn?.("Bomb spawn failed", error);
  }
  if (spawned?.success !== true || scene.dynamicEntities.get(bomb.itemID) !== bomb) {
    removeBomb(scene, bomb, { broadcast: false });
    handleEntityRemoved(scene, bomb);
    return { success: false, errorMsg: "BOMB_SPAWN_FAILED" };
  }
  const consumption = callbacks.consumeLoadedCharge(entity, moduleItem, chargeItem, nowMs);
  if (!consumption?.success) {
    removeBomb(scene, bomb, { broadcast: false });
    return { success: false, errorMsg: consumption?.errorMsg || "AMMO_UPDATE_FAILED" };
  }
  // No fallible admission remains after the current custody owner accepts one
  // charge. Delivery failure does not turn an accepted shot into a second shot.
  effectState.bombLaunched = true;
  effectState.bombEntityID = bomb.itemID;
  bomb.evejsInitialPublicationDeferred = false;
  callbacks.recordLaunch?.(entity, nowMs);
  try { callbacks.publishBomb(bomb); } catch (error) { callbacks.warn?.("Bomb publication failed", error); }
  return { success: true, data: { entity: bomb, consumption } };
}

function resolveBombAppliedDamage(snapshot, target) {
  // Installed bombs author explosion radius but no explosion velocity. Their
  // application is signature-only; do not supply the missile solver's absent-
  // velocity fallback or manufacture a velocity dogma attribute.
  const factor = Math.min(1, buildMissileImpactState(target).signatureRadius /
    Math.max(1, toFiniteNumber(snapshot.explosionRadius, 1)));
  return Object.fromEntries(Object.entries(snapshot.rawShotDamage)
    .map(([key, value]) => [key, Math.max(0, toFiniteNumber(value, 0)) * factor]));
}

function blastTargets(scene, bomb, range) {
  return [...scene.dynamicEntities.values(), ...(scene.staticEntities || [])].filter((target) =>
    target !== bomb && hasDamageableHealth(target) && !target.destroyed && !target.removed &&
    target.mode !== "WARP" && canEntitiesInteractLocally(bomb, target) &&
    getEntitySurfaceDistance(bomb, target) <= range + 1e-6);
}

function detonateBombEntity(scene, bomb, nowMs, callbacks = flights.get(bomb)?.callbacks || {}) {
  const flight = flights.get(bomb);
  if (!isOwnedBomb(scene, bomb) || flight.terminal) return { removed: true, impact: false };
  const targets = blastTargets(scene, bomb, flight.snapshot.blastRange);
  // Retire first. Reentrant callbacks and repeated ticks cannot repeat damage.
  // A plain removal with no destruction effect: the client draws the blast.
  if (!removeBomb(scene, bomb)) return { removed: true, impact: false };
  const liveSource = scene.dynamicEntities.get(flight.source.itemID) === flight.sourceReference &&
    canEntitiesInteractLocally(bomb, flight.sourceReference);
  const attacker = liveSource && callbacks.hasCurrentSourceOwner?.(flight.sourceReference)
    ? flight.sourceReference : flight.source;
  const outcomes = [];
  for (const target of targets) {
    if (scene.getEntityByID(target.itemID) !== target || !canEntitiesInteractLocally(bomb, target)) continue;
    const aggression = callbacks.recordAggression(attacker, target, nowMs);
    if (aggression?.success !== true) continue;
    if (flight.snapshot.chargeGroupID === 864) {
      const resistance = Math.max(0, toFiniteNumber(target.passiveDerivedState?.attributes?.[2045], 1));
      callbacks.neutralize(target, flight.snapshot.energyNeutralization * resistance, nowMs);
    }
    if (flight.snapshot.chargeGroupID === 863) {
      const chance = resolveJammerChance(flight.snapshot, target, 1).jamChance;
      if (chance > 0 && callbacks.random() < chance) callbacks.clearLocks(target);
    }
    const damage = resolveBombAppliedDamage(flight.snapshot, target);
    if (sumDamageVector(damage) > 0) outcomes.push({ targetID: target.itemID,
      result: callbacks.applyDamage(attacker, target, flight.moduleItem, flight.chargeItem, damage, nowMs) });
  }
  return { removed: true, impact: true, data: { outcomes } };
}

function canFuseMeet(bomb, target) {
  return target !== bomb && target.itemID !== bomb.sourceShipID && target.kind !== "missile" &&
    !target.destroyed && !target.removed && hasDamageableHealth(target) &&
    target.mode !== "WARP" && canEntitiesInteractLocally(bomb, target);
}

// Where a target started this tick, for the fuse's sweep. Evolve's pass 3 has
// already swapped the slots, so a Ball it moved keeps its tick-start position
// in its old slot. A static Ball, a Ball with no slots, or one
// already moribund is taken where it is, as Evolve's own missile hit takes
// its target.
function tickStartOf(target, isStatic) {
  return !isStatic && target.isMoribund !== true && target.oldPosition
    ? target.oldPosition
    : target.position;
}

// Destiny's onProximityFuse park hook, once Evolve has moved the bomb through
// its tick chord sweep = { from, to }. The fuse meets a target over the tick:
// the bomb's chord against the target's own (Destiny's two-chord
// sweptImpact), so a ship crossing the chord mid-tick is met and one that
// reaches it only after the bomb has passed is not. The bomb detonates where
// Evolve has it; nothing moves it to the point the fuse met.
function onProximityFuse(scene, ball, sweep, nowMs) {
  const flight = flights.get(ball);
  if (!isOwnedBomb(scene, ball) || flight.terminal || ball.removed || ball.destroyed) {
    return { fused: false };
  }
  const fuseRange = Math.max(0, toFiniteNumber(ball.proximityFuseRange, 0));
  if (!(fuseRange > 0) || !sweep?.from || !sweep?.to) return { fused: false };
  const radius = (target) => fuseRange + Math.max(0, toFiniteNumber(ball.radius, 0)) +
    Math.max(0, toFiniteNumber(target.radius, 0));
  const meets = (target, isStatic) => canFuseMeet(ball, target) &&
    sweptImpact(sweep.from, sweep.to, tickStartOf(target, isStatic), target.position, radius(target)).hit;
  const met = [...scene.dynamicEntities.values()].some((target) => meets(target, false)) ||
    (scene.staticEntities || []).some((target) => meets(target, true));
  if (!met) return { fused: false };
  return { fused: true, ...detonateBombEntity(scene, ball, nowMs) };
}

module.exports = { BOMB_LAUNCHER_GROUP, isBombLauncher, resolveBombLauncherActivation,
  executeBombLaunchCycle, isOwnedBomb, getRemainingBombTrajectory, removeBomb, clearSceneBombs, handleEntityRemoved, resolveBombAppliedDamage,
  detonateBombEntity, onProximityFuse };
