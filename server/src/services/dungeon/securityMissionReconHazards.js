"use strict";

// Recon owns authorization and the pulse cursor. Existing siteHazardOutcomes
// owns the durable outbox; the ordinary ship owner applies typed damage.
const { createHash } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const seenByScene = new WeakMap();
const TUPLES = Object.freeze({
  3042: [2, 2011, 14193, 596887], 3054: [2, 2011, 14193, 596887],
  3049: [4, 2019, 18859, 836520], 3055: [4, 2019, 18859, 836520],
});
// TODO: Validate arming, eligible targets/range, reset, late-tick and restart
// policies on live. These are provisional server interpretations, not client facts.
const POLICIES = Object.freeze({
  triggerPolicy: "first-qualified-pilot",
  targetPolicy: "active-authorized-piloted-ship",
  rangePolicy: "tracked-room-and-source-grid",
  resetPolicy: "instance-once",
  latePolicy: "latest-due-one-per-tick-skip-older",
  restartPolicy: "skip-overdue",
});
const positive = value => Number.isSafeInteger(value) && value > 0;
function invalid(message) { throw new Error(`SECURITY_RECON_HAZARD_INVALID: ${message}`); }

function descriptorFor(template, binding) {
  const rows = template?.populationHints?.securityMissionHazards;
  if (rows === undefined || Array.isArray(rows) && rows.length === 0) return null;
  if (!Array.isArray(rows) || rows.length !== 1) invalid("one canonical descriptor required");
  const row = rows[0];
  const tuple = TUPLES[row?.missionID];
  if (!tuple || row.version !== 1 || row.key !== "recon3-toxic" || row.kind !== "recon-toxic-cloud" ||
      row.sourceTypeID !== 19753 || row.roomKey !== `room:${row.roomID}` ||
      !isDeepStrictEqual([row.level, row.dungeonID, row.roomID, row.sourceObjectID], tuple) ||
      binding?.missionID !== row.missionID || binding.templateID !== template.templateID ||
      binding.templateID !== `security-mission:${row.missionID}` || binding.dungeonID !== row.dungeonID ||
      binding.agentLevel !== row.level || template.sourceDungeonID !== row.dungeonID ||
      template.missionLevel !== row.level || template.securityMission?.missionID !== row.missionID ||
      template.securityMission?.dungeonID !== row.dungeonID || template.securityMission?.agentLevel !== row.level ||
      Object.entries(POLICIES).some(([key, value]) => row[key] !== value)) invalid("identity or policy");
  if (!Array.isArray(row.pulses) || !row.pulses.length) invalid("pulses required");
  const ids = new Set();
  let previous = -1;
  for (const pulse of row.pulses) {
    if (!pulse || typeof pulse.id !== "string" || !pulse.id || ids.has(pulse.id) ||
        !Number.isSafeInteger(pulse.offsetMs) || pulse.offsetMs < 0 || pulse.offsetMs <= previous ||
        !pulse.rawDamage || Object.keys(pulse.rawDamage).length !== 4 ||
        !["em", "thermal", "kinetic", "explosive"].every(key =>
          typeof pulse.rawDamage[key] === "number" && Number.isFinite(pulse.rawDamage[key]) && pulse.rawDamage[key] >= 0) ||
        Object.values(pulse.rawDamage).reduce((sum, value) => sum + value, 0) <= 0) invalid("pulse vector or order");
    previous = pulse.offsetMs;
    ids.add(pulse.id);
  }
  return row;
}

function contextFor(scene, instance) {
  if (!instance || instance.lifecycleState !== "active" || instance.metadata?.missionRuntime !== true ||
      instance.solarSystemID !== scene.systemID || scene.sceneKey !== `solar-system:${scene.systemID}` ||
      scene.sceneKind !== "solarSystem") return null;
  const metadata = instance.metadata;
  const siteID = metadata.siteID;
  const site = scene.staticEntitiesByID?.get(siteID);
  if (!positive(siteID) || !site || site.itemID !== siteID ||
      site.dungeonSiteInstanceID !== instance.instanceID ||
      !scene._dungeonUniverseMaterializedSiteIDs?.has(siteID) ||
      scene._dungeonUniverseMaterializedInstanceIDsBySiteID?.get(siteID) !== instance.instanceID) return null;
  const authority = require("./dungeonAuthority");
  const template = authority.getTemplateByID(instance.templateID);
  if (!template) return null;
  const binding = authority.getSecurityMissionBinding(template.securityMission?.missionID);
  const descriptor = descriptorFor(template, binding);
  if (!descriptor) return null;
  const ownerID = metadata.missionCharacterID;
  if (!positive(ownerID) || instance.ownership?.characterID !== ownerID ||
      instance.ownership?.missionOwnerCharacterID !== ownerID ||
      !positive(metadata.missionAgentID) || !positive(metadata.missionSequence) ||
      metadata.missionContentID !== descriptor.missionID || metadata.missionRuntimeTemplateID !== template.templateID) return null;
  const missionRuntime = require("../agent/loadedMissionRuntime").getLoadedMissionRuntime() ||
    require("../agent/agentMissionRuntime");
  const mission = missionRuntime.getMissionRecord(ownerID, metadata.missionAgentID);
  if (!mission || mission.runtimeStatus !== "accepted" || mission.agentID !== metadata.missionAgentID ||
      mission.contentID !== metadata.missionContentID || mission.missionSequence !== metadata.missionSequence ||
      mission.dungeonInstanceID !== instance.instanceID || mission.missionSiteID !== siteID ||
      mission.missionSystemID !== scene.systemID) return null;
  const expected = require("./securityMissionWeather").buildNativeWeatherEntities(instance, site, template)
    .find(entity => entity.dunObjectID === descriptor.sourceObjectID);
  if (!expected) invalid("native weather source missing");
  const anchor = scene.staticEntitiesByID.get(expected.itemID);
  const fields = ["kind", "itemID", "typeID", "dungeonMaterializedSiteContent", "dungeonNativeWeatherAnchor",
    "dungeonNativeWeatherIdentity", "dungeonSiteID", "dungeonSiteInstanceID", "solarSystemID",
    "dunObjectID", "dungeonRoomKey", "position", "radius"];
  if (!anchor || fields.some(key => !isDeepStrictEqual(anchor[key], expected[key])) ||
      anchor.dungeonRoomKey !== descriptor.roomKey || anchor.typeID !== descriptor.sourceTypeID) return null;
  return { instance, descriptor, anchor, site };
}

function qualifiedTarget(scene, ship, context) {
  if (!ship || scene.dynamicEntities?.get(ship.itemID) !== ship || ship.kind !== "ship" ||
      ship.nativeNpc === true || ship.persistSpaceState !== true || ship.mode === "WARP" || ship.warpDestination ||
      ship.dungeonCurrentInstanceID !== context.instance.instanceID || ship.dungeonCurrentRoomKey !== context.descriptor.roomKey ||
      require("../../space/runtime/combatDestruction").isRuntimeEntityDestroyingOrDestroyed(ship) ||
      !require("../../space/combat/damage").hasDamageableHealth(ship) ||
      require("../inventory/itemStore").isCapsuleTypeID(ship.typeID)) return false;
  const session = require("../../space/runtime/entityOwnerSession").getOwningSessionForEntity(scene, ship);
  if (!session || session._transitionState || session._space?.systemID !== scene.systemID ||
      // A pilot still loading in has no scene yet, so it could not see or leave the cloud.
      !require("../../space/runtime/destinyDeliveryEligibility").isReadyForDestiny(session) ||
      require("../../space/runtime/sceneIdentity").getSceneKeyForSession(session) !== scene.sceneKey ||
      !positive(require("../_shared/sessionIdentity").resolveSessionCharacterID(session)) ||
      Number(ship.ownerID) !== require("../_shared/sessionIdentity").resolveSessionCharacterID(session) ||
      !require("./dungeonVisibilityPolicy").canSessionAccessDungeonInstance(session, context.instance) ||
      typeof scene.isOnSessionGrid !== "function" || !scene.isOnSessionGrid(session, context.anchor) ||
      !require("../../space/destiny/identity/interactionScope").canEntitiesInteractLocally(context.anchor, ship)) return false;
  return scene.dynamicEntities.get(ship.itemID) === ship;
}

function tickInstance(scene, instanceID, options = {}) {
  const nowMs = options.nowMs;
  if (!scene || !Number.isSafeInteger(nowMs) || nowMs <= 0) return { processed: false };
  const runtime = require("./dungeonRuntime");
  let instance = runtime.getInstance(instanceID);
  const context = contextFor(scene, instance);
  if (!context) return { processed: false };
  const { descriptor, anchor, site } = context;
  const signature = createHash("sha256").update(JSON.stringify(descriptor)).digest("hex");
  let seen = seenByScene.get(scene);
  if (!seen) { seen = new Map(); seenByScene.set(scene, seen); }
  const identity = `${instanceID}:${descriptor.key}`;
  if (seen.get(identity) === "parked") return { parked: true };
  const outcomes = require("./siteHazardOutcomes");
  const recovery = outcomes.replayPendingSiteHazardDamage(instance, { scene, nowMs });
  if (!recovery.success) return { processed: false, errorMsg: recovery.errorMsg };
  instance = runtime.getInstance(instanceID);
  const cursor = instance.spawnState?.securityMissionHazardsByKey?.[descriptor.key];
  if (cursor && (cursor.version !== 1 || cursor.descriptorSignature !== signature ||
      !Number.isSafeInteger(cursor.armedAtMs) || cursor.armedAtMs <= 0 ||
      !Number.isSafeInteger(cursor.nextPulseIndex) || cursor.nextPulseIndex < 0 || cursor.nextPulseIndex > descriptor.pulses.length ||
      !Number.isSafeInteger(cursor.lastProcessedAtMs) || cursor.lastProcessedAtMs < cursor.armedAtMs)) {
    seen.set(identity, "parked");
    invalid("saved descriptor/cursor changed; parked without resetting");
  }
  const save = (nextCursor, events) => {
    // Reload the nested map; other hazards and durable outcomes share spawnState.
    const latest = runtime.getInstance(instanceID);
    outcomes.prepareEvents(latest, events, { nowMs, spawnPatch: { securityMissionHazardsByKey: {
      ...latest.spawnState?.securityMissionHazardsByKey, [descriptor.key]: nextCursor,
    } } });
    seen.set(identity, "seen");
  };
  if (!cursor) {
    const ships = [...(scene.dynamicEntities?.values() || [])];
    if (!ships.some(ship => qualifiedTarget(scene, ship, context))) return { processed: false };
    save({ version: 1, descriptorSignature: signature, armedAtMs: nowMs, nextPulseIndex: 0, lastProcessedAtMs: nowMs }, []);
    return { armed: true };
  }
  const reconstructed = !seen.has(identity);
  if (nowMs < cursor.lastProcessedAtMs || cursor.nextPulseIndex === descriptor.pulses.length) {
    seen.set(identity, "seen");
    return { processed: false };
  }
  let nextIndex = cursor.nextPulseIndex;
  while (nextIndex < descriptor.pulses.length && cursor.armedAtMs + descriptor.pulses[nextIndex].offsetMs <= nowMs) nextIndex++;
  if (nextIndex === cursor.nextPulseIndex) { seen.set(identity, "seen"); return { processed: false }; }
  const pulse = descriptor.pulses[nextIndex - 1];
  const events = [];
  if (!reconstructed) {
    for (const ship of [...(scene.dynamicEntities?.values() || [])]) {
      if (!qualifiedTarget(scene, ship, context)) continue;
      // prepareTarget captures custody and persists. Never call it before gates.
      if (scene.dynamicEntities.get(ship.itemID) !== ship) continue;
      events.push({ eventID: `${instanceID}:recon:${descriptor.key}:${pulse.id}:${ship.itemID}`,
        atMs: cursor.armedAtMs + pulse.offsetMs, sourceName: "Toxic Cloud Environment",
        source: { itemID: anchor.itemID, position: { ...anchor.position }, dungeonMaterializedSiteContent: true,
          dungeonSiteID: site.itemID, dungeonSiteInstanceID: instanceID },
        rawDamage: pulse.rawDamage,
        target: require("../../space/runtime/siteHazardDamage").prepareTarget(scene, ship) });
    }
  }
  save({ ...cursor, nextPulseIndex: nextIndex, lastProcessedAtMs: nowMs,
    ...(nextIndex === descriptor.pulses.length ? { completedAtMs: nowMs } : {}) }, events);
  const delivery = outcomes.replayPendingSiteHazardDamage(instanceID, { scene, nowMs });
  return { processed: true, skipped: reconstructed, prepared: events.length, success: delivery.success };
}

module.exports = { tickInstance };
