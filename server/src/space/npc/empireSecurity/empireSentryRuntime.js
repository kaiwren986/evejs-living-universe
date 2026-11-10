"use strict";

const { canEntitiesInteractLocally } = require("../../destiny/identity/interactionScope");
const { getEntitySurfaceDistance } = require("../../runtime/entityDistance");
const { getTypeAttributeValue } = require("../../../services/fitting/liveFittingState");
const { isEntityInActiveWarp } = require("../../destiny/simulation/warpPhase");

const OFFENSE_REASONS = new Set([
  "CRIMINAL_AUTHORITY_AGGRESSION", "LOWSEC_AUTHORITY_AGGRESSION",
  "HIGHSEC_PLAYER_AGGRESSION", "LOWSEC_SHIP_AGGRESSION", "LOWSEC_CAPSULE_AGGRESSION",
]);
const scenes = new WeakMap();

function sameGrid(left, right) {
  return left.bubbleID !== undefined && left.bubbleID !== null &&
    left.bubbleID === right.bubbleID && canEntitiesInteractLocally(left, right);
}

function canEngage(scene, sentry, offender) {
  if (!sentry || !offender || scene.getEntityByID(offender.itemID) !== offender ||
      offender.kind !== "ship" || Number(offender.groupID) === 29 ||
      offender.destructionState === "destroying" || offender.destructionState === "destroyed" ||
      isEntityInActiveWarp(offender) || !sameGrid(sentry, offender)) return false;
  const range = Number(getTypeAttributeValue(sentry.typeID, "entityAttackRange")) || 0;
  return range > 0 && getEntitySurfaceDistance(sentry, offender) <= range;
}

function stopSentry(scene, sentryID) {
  if (!scene.getEntityByID(sentryID)) return;
  const npc = require("../npcRuntime");
  npc.deactivateNpcControllerCombat(sentryID, { clearLocks: true });
  npc.stop(sentryID);
}

// The retail pilot was already suspect when it reached the station. Its guns
// only reacted to the new local offense, and kept firing after the laser stopped.
// Record that event, rather than making every suspect a sentry target.
function noteOffense(scene, offender, result, now, targetEntity = null) {
  if (!result?.success || !result.data?.applied || !OFFENSE_REASONS.has(result.data.reason) ||
      !scene?.staticEntities || !offender || offender.kind !== "ship" || Number(offender.groupID) === 29) return;
  now = Number.isFinite(Number(now)) ? Number(now) : scene.getCurrentSimTimeMs();
  const sentries = [...scene.staticEntities, ...scene.dynamicEntities.values()]
    .filter((entity) => entity.empireSentry === true && canEngage(scene, entity, offender));
  if (sentries.length === 0) return;
  let state = scenes.get(scene);
  if (!state) {
    state = { offenses: new Map(), assignments: new Map() };
    scenes.set(scene, state);
  }
  const crimewatch = require("../../../services/security/crimewatchState");
  const prior = state.offenses.get(offender.itemID);
  state.offenses.set(offender.itemID, {
    offender,
    expiresAtMs: now + crimewatch.CRIMINAL_TIMER_DURATION_MS,
    targetIDs: new Set([...(prior?.targetIDs || []), targetEntity?.itemID].filter(Boolean)),
    sentryIDs: new Set([...(prior?.sentryIDs || []), ...sentries.map((entity) => entity.itemID)]),
  });
  tickScene(scene, now);
}

function tickScene(scene, now = scene.getCurrentSimTimeMs()) {
  const state = scenes.get(scene);
  if (!state) return;
  const crimewatch = require("../../../services/security/crimewatchState");
  for (const [id, offense] of state.offenses) {
    // Only the originating offensive modules renew this response. A later
    // unrelated theft must not extend an old station's retaliation receipt.
    if ([...(offense.offender.activeModuleEffects?.values() || [])].some((effect) =>
      effect.effectRecord?.isOffensive === true && offense.targetIDs.has(effect.targetID))) {
      offense.expiresAtMs = now + crimewatch.CRIMINAL_TIMER_DURATION_MS;
    }
    if (offense.expiresAtMs <= now || scene.getEntityByID(id) !== offense.offender ||
        ![...offense.sentryIDs].some((sentryID) =>
          canEngage(scene, scene.getEntityByID(sentryID), offense.offender))) {
      state.offenses.delete(id);
    }
  }
  const sentryIDs = new Set([...state.assignments.keys(), ...[...state.offenses.values()]
    .flatMap((offense) => [...offense.sentryIDs])]);
  for (const sentryID of sentryIDs) {
    let sentry = scene.getEntityByID(sentryID);
    const previous = state.assignments.get(sentryID);
    let offense = previous && state.offenses.get(previous);
    if (!offense || !canEngage(scene, sentry, offense.offender)) {
      offense = [...state.offenses.values()].find((row) =>
        row.sentryIDs.has(sentryID) && canEngage(scene, sentry, row.offender));
    }
    if (!offense) {
      if (previous) stopSentry(scene, sentryID);
      state.assignments.delete(sentryID);
      continue;
    }
    if (previous === offense.offender.itemID && sentry?.nativeNpc === true) continue;
    const materialized = require("../nativeNpcService").materializeEmpireSentry(scene, sentry);
    if (!materialized.success) continue;
    sentry = materialized.data.entity;
    const npc = require("../npcRuntime");
    npc.activateNpcController(sentry.itemID, now);
    const ordered = npc.issueAttackOrder(sentry.itemID, offense.offender.itemID,
      { allowWeapons: true, keepLock: true, allowPodKill: false });
    if (ordered.success) state.assignments.set(sentryID, offense.offender.itemID);
  }
  if (state.offenses.size === 0 && state.assignments.size === 0) scenes.delete(scene);
}

function handleEntityRemoved(scene, entity) {
  const state = scenes.get(scene);
  if (!state) return;
  state.offenses.delete(entity.itemID);
  for (const [sentryID, targetID] of state.assignments) {
    if (sentryID === entity.itemID || targetID === entity.itemID) {
      if (sentryID !== entity.itemID) stopSentry(scene, sentryID);
      state.assignments.delete(sentryID);
    }
  }
}

function disposeScene(scene) {
  const state = scenes.get(scene);
  if (!state) return;
  scenes.delete(scene);
  for (const sentryID of state.assignments.keys()) stopSentry(scene, sentryID);
}

module.exports = { noteOffense, tickScene, handleEntityRemoved, disposeScene };
