"use strict";

module.exports = {
  consumeVortonArcPlan,
  resolveVortonArcChain,
  stashVortonArcPlan,
};

const runtimeEntryDirname = require("path").resolve(__dirname, "..");
const path = require("path");
const {
  canEntitiesInteractLocally,
  isSharedPveTarget,
  resolveEntityInteractionScope,
} = require(path.join(runtimeEntryDirname, "./destiny/identity/interactionScope.js"));
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
  resolveVortonShot,
  resolveVortonArcShot,
  selectVortonArcTargets,
  isVortonArcTargetKind,
} = require(path.join(runtimeEntryDirname, "./combat/vortonProjectors"));
const {
  toInt,
} = require("../../common/numbers");

const VORTON_ARC_PLAN_STATE_KEY = "vortonArcPlan";

/**
 * Resolve the arc victims a vorton shot would strike right now. Kept separate
 * from the cycle so the activation path can settle the same chain the moment it
 * publishes OnSpecialFX - the V24 client's ChainWeaponEffect reads the whole
 * list out of graphicInfo['targets'] once, at Start, and logs an error and
 * draws no arcs at all when the key is missing.
 */
function resolveVortonArcChain(scene, attackerEntity, targetEntity, weaponSnapshot) {
  if (!scene || !attackerEntity || !targetEntity || !weaponSnapshot) {
    return [];
  }
  const arcCandidates = [];
  // Dynamic entities cover ships, drones, fighters and inventory-backed
  // objects; large collidable structures and orbitals live in the static set,
  // so the arc has to scan both to chain onto a POCO or Upwell structure.
  const collectArcCandidate = (candidate) => {
    if (
      candidate &&
      toInt(candidate.itemID, 0) !== toInt(attackerEntity.itemID, 0) &&
      toInt(candidate.itemID, 0) !== toInt(targetEntity.itemID, 0) &&
      isVortonArcTargetKind(candidate.kind) &&
      hasDamageableHealth(candidate) &&
      canEntitiesInteractLocally(attackerEntity, candidate)
    ) {
      arcCandidates.push(candidate);
    }
  };
  if (scene.dynamicEntities instanceof Map) {
    for (const candidate of scene.dynamicEntities.values()) {
      collectArcCandidate(candidate);
    }
  }
  if (scene.staticEntitiesByID instanceof Map) {
    for (const candidate of scene.staticEntitiesByID.values()) {
      collectArcCandidate(candidate);
    }
  }

  return selectVortonArcTargets({
    attackerEntity,
    primaryTargetEntity: targetEntity,
    candidateEntities: arcCandidates,
    weaponSnapshot,
    random: typeof scene.__vortonArcRandom === "function"
      ? () => Number(scene.__vortonArcRandom()) || 0
      : Math.random,
  });
}

// The activation FX is published before the first cycle runs, so the chain is
// settled once and handed to both. Only IDs and distances are kept - an effect
// state must never hold a live entity reference, and a victim can leave the
// grid between the FX and the cycle. The plan is stamped with the cycle
// boundary and primary target it was resolved for; anything else falls through
// to a fresh resolve so a stale plan can never redirect a later cycle.
function stashVortonArcPlan(effectState, targetEntity, cycleBoundaryMs, chain) {
  if (!effectState) {
    return chain;
  }
  effectState[VORTON_ARC_PLAN_STATE_KEY] = {
    cycleBoundaryMs: Number(cycleBoundaryMs) || 0,
    targetID: toInt(targetEntity && targetEntity.itemID, 0),
    links: chain.map((link) => ({
      targetEntityID: toInt(link.entity && link.entity.itemID, 0),
      distanceFromPrimaryTarget: link.distanceFromPrimaryTarget,
    })),
  };
  effectState.vortonArcTargetIDs = chain.map(
    (link) => toInt(link.entity && link.entity.itemID, 0),
  );
  return chain;
}

function consumeVortonArcPlan(scene, effectState, targetEntity, cycleBoundaryMs) {
  const plan = effectState && effectState[VORTON_ARC_PLAN_STATE_KEY];
  if (!plan) {
    return null;
  }
  effectState[VORTON_ARC_PLAN_STATE_KEY] = null;
  if (
    !scene ||
    Number(plan.cycleBoundaryMs) !== (Number(cycleBoundaryMs) || 0) ||
    toInt(plan.targetID, 0) !== toInt(targetEntity && targetEntity.itemID, 0) ||
    !Array.isArray(plan.links)
  ) {
    return null;
  }

  const chain = [];
  for (const link of plan.links) {
    const entity = scene.getEntityByID(toInt(link.targetEntityID, 0));
    if (!entity) {
      continue;
    }
    chain.push({
      entity,
      linkIndex: chain.length + 1,
      distanceFromPrimaryTarget: link.distanceFromPrimaryTarget,
    });
  }
  return chain;
}

Object.assign(module.exports, {
  VORTON_ARC_PLAN_STATE_KEY,
});
