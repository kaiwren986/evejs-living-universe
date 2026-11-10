"use strict";

// The dungeon owns which hits happened. The ship/item owner commits health and
// an idempotent receipt together; this outbox only acknowledges that result.
const deliveringInstances = new Set();
let indexedState;
let pendingInstances = [];
const records = instance => instance?.spawnState?.siteHazardDamageEventsByID || {};
const runtime = () => require("./dungeonRuntime");

function hasPending(instance) {
  return Object.values(records(instance)).some(event => event.status !== "delivered");
}

function prepareEvents(instance, events, options = {}) {
  const latest = runtime().getInstance(instance.instanceID);
  if (!latest) throw new Error("SITE_HAZARD_INSTANCE_REQUIRED");
  const next = { ...records(latest) };
  for (const event of events) {
    if (!event?.eventID || !event.target?.shipID || !event.rawDamage || !Number.isFinite(event.atMs)) {
      throw new Error("SITE_HAZARD_EVENT_INVALID");
    }
    if (next[event.eventID]) continue; // Retain the original targets, roll and time.
    next[event.eventID] = { ...structuredClone(event), version: 1, status: "pending" };
  }
  return runtime().mergeSpawnState(instance.instanceID, {
    ...options.spawnPatch, siteHazardDamageEventsByID: next,
  }, { nowMs: options.nowMs, durable: true, force: true });
}

function replayPendingSiteHazardDamage(instanceOrID, options = {}) {
  const instanceID = Number(instanceOrID?.instanceID || instanceOrID);
  let instance = runtime().getInstance(instanceID);
  if (!instance || !hasPending(instance)) return { success: true, delivered: 0 };
  if (deliveringInstances.has(instanceID)) return { success: false, errorMsg: "SITE_HAZARD_DELIVERY_IN_PROGRESS", delivered: 0 };
  deliveringInstances.add(instanceID);
  let delivered = 0;
  try {
    for (const prepared of Object.values(records(instance))) {
      if (prepared.status === "delivered") continue;
      const targetID = prepared.target.shipID;
      let scene = options.scene;
      let target = scene?.dynamicEntities?.get(targetID);
      if (!target) {
        // A retry ticker can run while the pilot's scene is still live. Update
        // that exact hull too, or its next normal save would undo recovery.
        const scenes = require("../../space/runtime").scenes;
        for (const candidate of scenes instanceof Map ? scenes.values() : []) {
          const live = candidate.dynamicEntities?.get(targetID);
          if (live) { scene = candidate; target = live; break; }
        }
      }
      const result = scene && target
        ? require("../../space/runtime").applySiteExplosionDamageToTarget(scene, prepared.source, target,
          prepared.rawDamage, prepared.atMs, { preparedIntent: prepared, sourceName: prepared.sourceName })
        : require("../../space/runtime/siteHazardDamage").deliver(prepared, { scene, target });
      if (!result?.success || result.durable !== true) {
        return { success: false, delivered, errorMsg: result?.errorMsg || "SITE_HAZARD_HEALTH_PENDING" };
      }
      instance = runtime().getInstance(instanceID);
      if (!instance) throw new Error("SITE_HAZARD_CARRIER_REMOVED");
      // Even a duplicate target receipt must cross the dungeon ack barrier.
      const current = records(instance);
      instance = runtime().mergeSpawnState(instanceID, { siteHazardDamageEventsByID: {
        ...current, [prepared.eventID]: { ...current[prepared.eventID], status: "delivered",
          deliveredAtMs: Math.max(1, Number(options.nowMs) || Date.now()), stale: result.stale === true },
      } }, { nowMs: options.nowMs, durable: true, force: true });
      delivered++;
    }
    return { success: true, delivered };
  } catch (error) {
    return { success: false, delivered, errorMsg: error.message };
  } finally { deliveringInstances.delete(instanceID); }
}

function recoverAll(options = {}) {
  for (const instance of getPendingInstances()) {
    const result = replayPendingSiteHazardDamage(instance, options);
    if (!result.success) throw new Error(result.errorMsg);
  }
  return true;
}

function getPendingInstances() {
  const state = require("./dungeonRuntimeState").peekState();
  if (state !== indexedState) {
    indexedState = state;
    pendingInstances = Object.values(state.instancesByID || {}).filter(hasPending);
  }
  return pendingInstances;
}

function recoverForScene(scene) {
  for (const instance of getPendingInstances()) {
    const relevant = Object.values(records(instance)).some(event => event.status !== "delivered" &&
      (Number(event.target.systemID) === Number(scene?.systemID) ||
        scene?.dynamicEntities?.has(event.target.shipID)));
    if (!relevant) continue;
    const result = replayPendingSiteHazardDamage(instance, { scene });
    if (!result.success) throw new Error(result.errorMsg);
  }
  return true;
}

function recoverForSession(session) {
  const characterID = require("../_shared/sessionIdentity").resolveSessionCharacterID(session);
  // Character selection can hydrate a ship before the session has a pilot.
  // Settle the retained intents before that admission path as well.
  if (!characterID) return recoverAll();
  const shipID = Number(session?._space?.shipID || session?.shipID || session?.shipid);
  const systemID = Number(session?._space?.systemID || session?.solarsystemid2 || session?.solarsystemid);
  for (const instance of getPendingInstances()) {
    if (!Object.values(records(instance)).some(event => event.status !== "delivered" &&
        (Number(event.target.shipID) === shipID || Number(event.target.systemID) === systemID ||
        [event.target.ownerID, event.target.pilotCharacterID,
          event.target.entity?.characterID, event.target.entity?.pilotCharacterID]
          .some(id => Number(id) === characterID)))) continue;
    const result = replayPendingSiteHazardDamage(instance);
    if (!result.success) throw new Error(result.errorMsg);
  }
  return true;
}

function beforePurge(instance) {
  const result = replayPendingSiteHazardDamage(instance);
  if (!result.success) throw new Error(result.errorMsg);
  const eventIDs = Object.keys(records(runtime().getInstance(instance.instanceID)));
  if (eventIDs.length) {
    const retired = require("../../space/runtime/siteHazardDamage").retireEvents(eventIDs);
    if (!retired?.success) throw new Error(retired?.errorMsg || "SITE_HAZARD_RECEIPT_RETIREMENT_PENDING");
  }
  return true;
}

module.exports = { hasPending, prepareEvents, replayPendingSiteHazardDamage, recoverAll,
  recoverForScene, recoverForSession, beforePurge };
