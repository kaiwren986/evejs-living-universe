"use strict";

// Modern no-lock bomb interception.
// Targeted native-NPC missile interception remains with the ordinary missile
// owner. Neither path shares claims.
//
// The defender is an ordinary MISSILE Ball: it is launched through the
// scene's launchMissile, aimed at the bomb it picked, and Evolve flies it;
// its intercept is the missile hit's defender branch. Nothing here
// writes a Ball's position or spawns a Ball itself: a Ball spawned without
// launchMissile has no effectStamp, so its MISSILE behaviour never leaves
// launch thrust.
const { toFiniteNumber, toInt } = require("../../common/numbers");
const { dotProduct, magnitude, scaleVector, subtractVectors } = require("../../common/vector");
const { resolveItemByTypeID } = require("../../services/inventory/itemTypeRegistry");
const { getTypeEffectRecords, isChargeCompatibleWithModule } = require("../../services/fitting/liveFittingState");
const { getSolarSystemPseudoSecurity } = require("../../services/security/systemSecurity");
const { canEntitiesInteractLocally } = require("../destiny/identity/interactionScope");
const { compareEntityIDs } = require("../destiny/identity/entityID");
const bombRuntime = require("./bombRuntime");

// defender Ball -> its claim; bomb Ball -> the claim on it. A claim is
// { scene, target, defender, staging, accepted, terminal }.
const defenders = new WeakMap();
const assignments = new WeakMap();
const sceneDefenders = new WeakMap();

function isModernDefenderActivation(entity, moduleItem, targetID) {
  return toInt(moduleItem?.groupID, 0) === 512 &&
    !(entity?.nativeNpc === true && toInt(targetID, 0) > 0);
}

function resolveDefenderActivation({ scene, entity, moduleItem, chargeItem, snapshot } = {}) {
  const refuse = (errorMsg) => ({ success: false, errorMsg });
  if (!chargeItem || toInt(chargeItem.stacksize ?? chargeItem.quantity, 0) <= 0) return refuse("NO_AMMO");
  const moduleType = resolveItemByTypeID(moduleItem.typeID);
  const chargeType = resolveItemByTypeID(chargeItem.typeID);
  if (!moduleType?.published || !chargeType?.published || chargeType.groupID !== 88 ||
      !(chargeType.graphicID > 0) || !isChargeCompatibleWithModule(moduleItem.typeID, chargeItem.typeID) ||
      !getTypeEffectRecords(moduleItem.typeID).some((effect) => effect.effectID === 101) ||
      !getTypeEffectRecords(chargeItem.typeID).some((effect) => effect.effectID === 103) ||
      !snapshot?.isDefenderMissile || !(snapshot.maxVelocity > 0) || !(snapshot.flightTimeMs > 0)) {
    return refuse("UNSUPPORTED_DEFENDER");
  }
  if (scene?.dynamicEntities.get(entity?.itemID) !== entity ||
      !Number.isFinite(Number(scene?.system?.security))) return refuse("INVALID_DEFENDER_SCENE");
  if (toFiniteNumber(snapshot.moduleAttributes?.[1074], 0) > 0 &&
      getSolarSystemPseudoSecurity(scene.system) > 0) return refuse("DEFENDER_IN_EMPIRE_SPACE");
  if (entity.mode === "WARP") return refuse("CANNOT_ACTIVATE_IN_WARP");
  return { success: true, data: { snapshot: { ...snapshot, family: "bombDefender" } } };
}

function sharesFriendlyOwner(source, bombSource) {
  for (const field of ["ownerID", "corporationID", "allianceID", "warFactionID"]) {
    if (toInt(source[field], 0) > 0 && toInt(source[field], 0) === toInt(bombSource[field], 0)) return true;
  }
  const left = toInt(source.session?.characterID, toInt(source.characterID, 0));
  const right = toInt(bombSource.characterID, 0);
  return left > 0 && right > 0 && require("../../services/fleets/fleetHelpers").isInSameFleet(left, right);
}

function isAssigned(scene, bomb, permittedClaim = null) {
  const claim = assignments.get(bomb);
  if (!claim || claim === permittedClaim) return false;
  if (claim.scene === scene && (claim.staging || isOwnedDefender(scene, claim.defender))) return true;
  assignments.delete(bomb);
  return false;
}

function isEligibleBomb(scene, source, bomb, snapshot, nowMs, claim = null) {
  if (scene.dynamicEntities.get(source?.itemID) !== source || source.removed || source.destroyed ||
      source.mode === "WARP") return false;
  const trajectory = bombRuntime.getRemainingBombTrajectory(scene, bomb, nowMs);
  if (!trajectory || bomb.sourceShipID === source.itemID ||
      !canEntitiesInteractLocally(source, bomb) || sharesFriendlyOwner(source, trajectory.source) ||
      isAssigned(scene, bomb, claim)) return false;
  const sample = scene.getEntitySurfaceState(source, bomb);
  if (!sample.available || sample.surfaceDistance > snapshot.maxVelocity * snapshot.flightTimeMs / 1000 + 1e-6) return false;
  const segment = subtractVectors(trajectory.endpoint, trajectory.position);
  const lengthSquared = dotProduct(segment, segment);
  const offset = subtractVectors(sample.sourceEntity.position, trajectory.position);
  const fraction = lengthSquared > 0 ? Math.min(1, Math.max(0, dotProduct(offset, segment) / lengthSquared)) : 0;
  const distance = magnitude(subtractVectors(offset, scaleVector(segment, fraction)));
  return distance <= trajectory.blastRange + Math.max(0, source.radius || 0) + Math.max(0, bomb.radius || 0) + 1e-6;
}

function selectDefenderTarget(scene, source, snapshot, nowMs) {
  return [...scene.dynamicEntities.values()].filter((bomb) =>
    isEligibleBomb(scene, source, bomb, snapshot, nowMs)).sort((left, right) =>
    scene.getEntitySurfaceDistance(source, left) -
      scene.getEntitySurfaceDistance(source, right) ||
    left.expiresAtMs - right.expiresAtMs || compareEntityIDs(left.itemID, right.itemID))[0] || null;
}

function isOwnedDefender(scene, entity) {
  return Boolean(entity && defenders.get(entity)?.scene === scene &&
    scene?.dynamicEntities.get(entity.itemID) === entity);
}

function releaseClaim(claim) {
  claim.terminal = true;
  sceneDefenders.get(claim.scene)?.delete(claim.defender);
  if (assignments.get(claim.target) === claim) assignments.delete(claim.target);
}

function removeDefender(scene, entity, options = {}) {
  const claim = defenders.get(entity);
  if (!isOwnedDefender(scene, entity) || claim.terminal) return false;
  releaseClaim(claim);
  entity.removed = true;
  scene.unregisterDynamicEntity(entity, { persistSpaceState: false, ...options });
  return true;
}

// The entity-removed point (Scene feature hooks). A defender that leaves
// releases its claim. A claimed bomb that leaves, by any cause, takes its
// defender with it, unless that defender is already moribund from its own
// hit: the missile hit's defender branch removed the bomb at once and marked
// the defender for MISSILE_HIT_REMOVAL_DELAY_TICKS, and that removal stands.
function handleEntityRemoved(scene, entity) {
  const ownClaim = defenders.get(entity);
  if (ownClaim?.scene === scene) releaseClaim(ownClaim);
  const claim = assignments.get(entity);
  if (claim?.scene !== scene) return;
  assignments.delete(entity);
  const defender = claim.defender;
  if (defender && defender.isMoribund !== true) {
    removeDefender(scene, defender, { broadcast: claim.accepted === true });
  }
}

function clearSceneDefenders(scene) {
  for (const entity of [...(sceneDefenders.get(scene) || [])]) {
    if (!removeDefender(scene, entity, { broadcast: false })) handleEntityRemoved(scene, entity);
  }
  sceneDefenders.delete(scene);
}

// A defender is a missile with hit points of its own, so it can be shot down
// (combatDestruction removes it through removeDefender).
function equipDefender(defender, snapshot) {
  const attributes = snapshot.chargeAttributes || {};
  defender.modernDefenderEntity = true;
  defender.structureHP = Math.max(0, toFiniteNumber(attributes[9], 0));
  defender.shieldCapacity = Math.max(0, toFiniteNumber(attributes[263], 0));
  defender.armorHP = Math.max(0, toFiniteNumber(attributes[265], 0));
  defender.conditionState = { shieldCharge: 1, armorDamage: 0, damage: 0 };
  defender.passiveDerivedState = { attributes: { ...attributes } };
}

function executeDefenderLaunch({ scene, entity, moduleItem, chargeItem, effectState, nowMs, callbacks }) {
  if (effectState.defenderLaunchResolved) return { success: true, data: { duplicate: true } };
  const snapshot = effectState.defenderSnapshot;
  const bomb = selectDefenderTarget(scene, entity, snapshot, nowMs);
  if (!bomb) {
    effectState.defenderLaunchResolved = true;
    effectState.suppressStartSpecialFx = true;
    return { success: true, data: { idle: true } };
  }
  const claim = { scene, target: bomb, defender: null, staging: true, accepted: false, terminal: false };
  assignments.set(bomb, claim);
  let launch;
  try {
    // Eligibility already holds the bomb within maxVelocity × flightTime.
    launch = scene.launchMissile(entity, bomb.itemID, snapshot, { launchTimeMs: nowMs, moduleItem,
      chargeItem, skipRangeCheck: true, broadcast: false, initialPublication: "deferred" });
  } catch (error) {
    // A partially registered spawn can throw before returning its reference:
    // the Ball is in the scene by its launch time, source, module and target.
    for (const partial of [...scene.dynamicEntities.values()]) {
      if (partial?.kind === "missile" && !defenders.has(partial) &&
          partial.sourceShipID === entity.itemID && partial.sourceModuleID === moduleItem.itemID &&
          partial.launchedAtMs === nowMs && partial.targetEntityID === bomb.itemID) {
        partial.removed = true;
        scene.unregisterDynamicEntity(partial, { persistSpaceState: false, broadcast: false });
      }
    }
    callbacks.warn("Defender launch failed", error);
    launch = { success: false, errorMsg: "DEFENDER_SPAWN_FAILED" };
  }
  const defender = launch?.success === true ? launch.data?.entity : null;
  if (!defender || scene.dynamicEntities.get(defender.itemID) !== defender) {
    if (assignments.get(bomb) === claim) assignments.delete(bomb);
    return { success: false, errorMsg: launch?.errorMsg || "DEFENDER_SPAWN_FAILED" };
  }
  claim.defender = defender;
  defenders.set(defender, claim);
  if (!sceneDefenders.has(scene)) sceneDefenders.set(scene, new Set());
  sceneDefenders.get(scene).add(defender);
  equipDefender(defender, snapshot);
  const consumption = callbacks.consumeLoadedCharge(entity, moduleItem, chargeItem, nowMs);
  if (!consumption?.success) {
    removeDefender(scene, defender, { broadcast: false });
    return { success: false, errorMsg: consumption?.errorMsg || "AMMO_UPDATE_FAILED" };
  }
  claim.accepted = true;
  claim.staging = false;
  effectState.defenderLaunchResolved = true;
  effectState.defenderEntityID = defender.itemID;
  // This is a no-lock scan, not a targeted module relationship. Bomb removal
  // must not shorten the authored launcher cycle through target-loss cleanup.
  effectState.defenderTargetID = bomb.itemID;
  if (!isOwnedDefender(scene, defender)) {
    effectState.suppressStartSpecialFx = true;
    return { success: true, data: { targetLostAfterCommit: true, consumption } };
  }
  defender.evejsInitialPublicationDeferred = false;
  try { callbacks.publishProjectile(defender); } catch (error) { callbacks.warn("Defender publication failed", error); }
  return { success: true, data: { entity: defender, consumption } };
}

module.exports = { isModernDefenderActivation, resolveDefenderActivation, selectDefenderTarget,
  isEligibleBomb, isOwnedDefender, removeDefender, handleEntityRemoved, clearSceneDefenders,
  executeDefenderLaunch };
