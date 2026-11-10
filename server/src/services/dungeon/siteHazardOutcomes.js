"use strict";

// The dungeon owns which hits happened. The ship/item owner commits health and
// an idempotent receipt together; this outbox only acknowledges that result.
const deliveringInstances = new Set();
const records = instance => instance?.spawnState?.siteHazardDamageEventsByID || {};
const runtime = () => require("./dungeonRuntime");
const runtimeState = () => require("./dungeonRuntimeState");

function hasPending(instance) {
  return Object.values(records(instance)).some(event => event.status !== "delivered") ||
    Boolean(instance && require("./fracturedLegacySceneActions").pendingMineEvents(instance).length);
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
  if (!runtimeState().peekPendingSiteHazardEntry(instanceID)) return { success: true, delivered: 0 };
  let instance = runtime().getInstance(instanceID);
  let pending = runtimeState().peekPendingSiteHazardEntry(instanceID);
  if (!instance || !pending) return { success: true, delivered: 0 };
  if (deliveringInstances.has(instanceID)) return { success: false, errorMsg: "SITE_HAZARD_DELIVERY_IN_PROGRESS", delivered: 0 };
  deliveringInstances.add(instanceID);
  let delivered = 0;
  try {
    instance = require("./fracturedLegacySceneActions").reconcilePendingMineEvents(instance, options);
    pending = runtimeState().peekPendingSiteHazardEntry(instanceID);
    if (!pending) return { success: true, delivered };
    for (const prepared of pending.pendingEvents) {
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
  for (const entry of runtimeState().peekPendingSiteHazardEntries()) {
    const result = replayPendingSiteHazardDamage(entry.instanceID, options);
    if (!result.success) throw new Error(result.errorMsg);
  }
  return true;
}

function recoverForScene(scene) {
  for (const entry of runtimeState().peekPendingSiteHazardEntries()) {
    const relevant = entry.pendingEvents.some(event =>
      (Number(event.target.systemID) === Number(scene?.systemID) ||
        scene?.dynamicEntities?.has(event.target.shipID)));
    if (!relevant) continue;
    const result = replayPendingSiteHazardDamage(entry.instanceID, { scene });
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
  for (const entry of runtimeState().peekPendingSiteHazardEntries()) {
    if (!entry.pendingEvents.some(event =>
        (Number(event.target.shipID) === shipID || Number(event.target.systemID) === systemID ||
        [event.target.ownerID, event.target.pilotCharacterID,
          event.target.entity?.characterID, event.target.entity?.pilotCharacterID]
          .some(id => Number(id) === characterID)))) continue;
    const result = replayPendingSiteHazardDamage(entry.instanceID);
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
