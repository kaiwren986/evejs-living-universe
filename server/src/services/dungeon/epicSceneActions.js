"use strict";

// Presentation and movement for captured epic-arc companions/cinematic balls.
// Scene physics still owns every orbit/warp. These actors never mine inventory,
// award kills, advance objectives or own a second simulation clock.
const runtime = () => require("./dungeonRuntime");
const stateByScene = new WeakMap();
function state(scene) {
  if (!stateByScene.has(scene)) stateByScene.set(scene, { fencedRooms: new Set(), roomClocks: new Map(), actors: new Map(), effects: new Map() });
  return stateByScene.get(scene);
}
// Native scene time owns new live progression. The argument remains a fallback
// for clock-free presentation test doubles; live callers cannot choose a clock.
function sceneTime(scene, fallback) {
  if (typeof scene.getCurrentSimTimeMs !== "function") return Number(fallback);
  const now = Number(scene.getCurrentSimTimeMs());
  if (!Number.isFinite(now) || now < 0) throw new Error("EPIC_SCENE_CLOCK_UNAVAILABLE");
  return now;
}
function wallTime(scene) {
  const now = Number(typeof scene.getCurrentWallclockMs === "function" ? scene.getCurrentWallclockMs()
    : require("../../space/runtime/runtimeClock").getWallclockNowMs());
  if (!Number.isFinite(now) || now < 0) throw new Error("EPIC_SCENE_WALL_CLOCK_UNAVAILABLE");
  return now;
}
const scoped = (entity, instance) => Number(entity?.dungeonSiteInstanceID) === Number(instance.instanceID);
function entities(scene, instance) {
  return [...(scene.staticEntities || []), ...scene.getDynamicEntities()].filter(entity => scoped(entity, instance));
}
function reference(scene, instance, value) {
  if (!value) return null;
  return entities(scene, instance).find(entity =>
    value.objectID && Number(entity.dunObjectID || entity.dungeonSourceObjectID) === Number(value.objectID) ||
    value.actorKey && entity.epicCinematicKey === value.actorKey ||
    value.contentKey && [entity.dungeonSiteContentKey, entity.visionsActorKey].includes(value.contentKey));
}
function point(instance, template, roomKey, offset) {
  const profiles = template.siteSceneProfile?.roomProfiles || [];
  const entry = profiles.find(row => row.initialState === "active") || profiles[0];
  const room = profiles.find(row => row.roomKey === roomKey);
  const vector = value => Array.isArray(value) ? { x: value[0], y: value[1], z: value[2] } : value;
  const origin = vector(instance.position), from = vector(entry?.position), to = vector(room?.position);
  if (!origin || !from || !to || !offset) return null;
  return Object.fromEntries(["x", "y", "z"].map(axis => [axis, origin[axis] + to[axis] - from[axis] + offset[axis]]));
}
// A durable branch can replay an earlier accepted start. Preserve that anchor;
// live timeline/companion entry points normalize their own new action times.
function effect(scene, instance, source, rule, target, startedAtMs) {
  if (!source || !/^effects\.[A-Za-z0-9_]+$/.test(rule.guid) || rule.target && !target) return false;
  const key = `${instance.instanceID}:${source.itemID}:${rule.guid}:${target?.itemID || 0}`;
  const signature = JSON.stringify([rule.start !== false, rule.active, rule.moduleTypeID, rule.otherTypeID,
    rule.offensive === true, rule.durationMs, rule.repeat]);
  if (state(scene).effects.get(key) === signature) return true;
  const result = scene.broadcastSpecialFx(source.itemID, rule.guid, {
    moduleID: rule.moduleOnActor === false ? null : source.itemID,
    moduleTypeID: Object.hasOwn(rule, "moduleTypeID") ? rule.moduleTypeID : source.typeID,
    otherTypeID: rule.otherTypeID ?? null, targetID: target?.itemID || null,
    isOffensive: rule.offensive === true, start: rule.start !== false,
    active: rule.active === undefined ? rule.start !== false : rule.active,
    duration: Math.max(1, Number(rule.durationMs) || 1000), repeat: Math.max(0, Math.min(999999999, Number(rule.repeat) || 0)),
    startTime: require("../../space/runtime/runtimeClock").toFileTimeFromMs(startedAtMs),
  }, source);
  if (result?.stamp === null) return false;
  state(scene).effects.set(key, signature);
  return true;
}
function companions(scene, instance, rules, nowMs) {
  nowMs = sceneTime(scene, nowMs);
  if (rules?.version !== 1) return;
  for (const orbit of rules.orbits || []) {
    const source = reference(scene, instance, orbit.actor), target = reference(scene, instance, orbit.target);
    if (!source || !target || source.mode === "WARP") continue;
    const service = require("../../space/npc/nativeNpcService");
    if (typeof service.setDungeonCompanionOrbit === "function") {
      const result = service.setDungeonCompanionOrbit(source, target, orbit);
      if (!result.success) throw new Error(result.errorMsg || "EPIC_COMPANION_ORBIT_PENDING");
    } else if (source.mode !== "ORBIT" || source.targetEntityID !== target.itemID ||
        Math.abs(Number(source.orbitDistance) - orbit.rangeMeters) >= 1 ||
        Math.abs(Number(source.speedFraction) - orbit.speedFraction) >= 1e-6) {
      scene.orbitShipEntity(source, target.itemID, orbit.rangeMeters, { speedFraction: orbit.speedFraction });
    }
  }
  for (const rule of rules.effects || []) effect(scene, instance, reference(scene, instance, rule.actor), rule,
    reference(scene, instance, rule.target), nowMs);
}
function legacyRoomAge(scene, instance, roomKey, ownerShip, nowMs) {
  const current = runtime().getInstance(instance.instanceID) || instance;
  const rooms = { ...current.spawnState?.epicSceneActions?.roomsStartedAtMs };
  const key = `${instance.instanceID}:${roomKey}`;
  if (!rooms[roomKey] && ownerShip?.dungeonCurrentRoomKey !== roomKey) return null;
  if (!rooms[roomKey]) rooms[roomKey] = Math.max(1, nowMs);
  if (!state(scene).fencedRooms.has(key)) {
    runtime().mergeSpawnState(instance.instanceID, { epicSceneActions: {
      ...current.spawnState?.epicSceneActions, roomsStartedAtMs: rooms,
    } }, { nowMs, durable: true, force: true });
    state(scene).fencedRooms.add(key);
  }
  return Math.max(0, nowMs - rooms[roomKey]);
}
// A checkpoint records elapsed native scene time, never an independently
// advancing simulation. Offline wall elapsed is applied only when a new scene
// epoch binds that checkpoint; live calls always advance by native sim deltas.
function roomAge(scene, instance, roomKey, ownerShip, nowMs) {
  if (typeof scene.getCurrentSimTimeMs !== "function") return legacyRoomAge(scene, instance, roomKey, ownerShip, nowMs);
  const current = runtime().getInstance(instance.instanceID) || instance;
  const progress = current.spawnState?.epicSceneActions || {};
  const key = `${instance.instanceID}:${roomKey}`, local = state(scene);
  let clock = local.roomClocks.get(key);
  const wallNow = wallTime(scene), simNow = sceneTime(scene, nowMs);
  if (!clock) {
    const saved = progress.roomClockCheckpoints?.[roomKey];
    const legacyStart = Number(progress.roomsStartedAtMs?.[roomKey]);
    const validSaved = saved?.version === 1 && [saved.elapsedMs, saved.simAtMs, saved.wallclockAtMs]
      .every(value => Number.isFinite(value) && value >= 0);
    if (!validSaved && !(legacyStart > 0) && ownerShip?.dungeonCurrentRoomKey !== roomKey) return null;
    let age = 0;
    if (validSaved) age = saved.elapsedMs + Math.max(0, wallNow - saved.wallclockAtMs);
    else if (legacyStart > 0) {
      // Old releases stored whichever clock their caller supplied. Preserve
      // warm sim age when possible; a timestamp ahead of sim but not wall is
      // an old wall-clock anchor. A cold scene's aligned epoch retains the
      // historical offline catch-up policy for otherwise unmarked saves.
      age = Math.max(0, (legacyStart <= simNow ? simNow : wallNow) - legacyStart);
    }
    clock = { elapsedMs: age, simAtMs: simNow, checkpointAtWallclockMs: wallNow };
  }
  const age = clock.elapsedMs + Math.max(0, simNow - clock.simAtMs);
  // Bound durable checkpoint work to one fence per room per wall second;
  // only native simulation deltas contribute to the checkpointed age.
  const checkpoint = !local.fencedRooms.has(key) || wallNow - clock.checkpointAtWallclockMs >= 1000;
  if (checkpoint) {
    runtime().mergeSpawnState(instance.instanceID, { epicSceneActions: {
      ...progress,
      roomsStartedAtMs: { ...progress.roomsStartedAtMs, [roomKey]: progress.roomsStartedAtMs?.[roomKey] || Math.max(1, simNow) },
      roomClockCheckpoints: { ...progress.roomClockCheckpoints, [roomKey]: {
        version: 1, elapsedMs: age, simAtMs: simNow, wallclockAtMs: wallNow,
      } },
    } }, { nowMs: simNow, durable: true, force: true });
    local.fencedRooms.add(key);
  }
  // Publish the local anchor only after any required durable fence succeeds.
  local.roomClocks.set(key, { elapsedMs: age, simAtMs: simNow,
    checkpointAtWallclockMs: checkpoint ? wallNow : clock.checkpointAtWallclockMs });
  return age;
}
function restoreCapturedWarp(scene, instance, template, actor, entity, age) {
  const captured = actor.nativeWarpIngress;
  if (!captured) return false;
  const lateTicks = Math.floor(Math.max(0, age - actor.bornAtMs) / 1000);
  const elapsedTicks = captured.elapsedTicks + lateTicks;
  const effectStamp = Number(scene.nextDestinyStamp) - elapsedTicks;
  if (!Number.isSafeInteger(captured.elapsedTicks) || captured.elapsedTicks < 0 ||
      !Number.isSafeInteger(captured.warpFactor) || captured.warpFactor <= 0 ||
      !Number.isFinite(captured.warpDistance) || captured.warpDistance <= 0 ||
      !Number.isFinite(captured.minimumRange) || captured.minimumRange < 0 ||
      !["x", "y", "z"].every(axis => Number.isFinite(captured.velocity?.[axis])) ||
      !Number.isSafeInteger(effectStamp) || effectStamp < 0) throw new Error("EPIC_CAPTURED_WARP_STATE_INVALID");
  const destination = point(instance, template, actor.roomKey, actor.arrivalPositionOffset);
  if (!destination) throw new Error("EPIC_CAPTURED_WARP_DESTINATION_REQUIRED");
  Object.assign(entity, { mode: "WARP", velocity: { ...captured.velocity }, targetPoint: destination,
    warpFactor: captured.warpFactor, warpSpeedAU: captured.warpFactor / 1000,
    warpDistance: captured.warpDistance, warpMinRange: captured.minimumRange,
    effectStamp, speedFraction: 1 });
  if (lateTicks > 0) {
    // A captured AddBalls header identifies the next tick; its sampled pose
    // belongs to the previous Evolve. Reuse the native curve for cold age.
    const evolve = require("../../space/destiny/simulation/evolve");
    const pose = evolve.warpDistance(entity, entity.position, entity.velocity, elapsedTicks - 1);
    entity.position = pose.position; entity.velocity = pose.velocity;
    if (pose.dropped) evolve.stopBall(entity);
  }
  return true;
}
function spawn(scene, instance, template, actor, age) {
  const allocated = require("../../space/npc/nativeNpcStore").allocateEntityID({ transient: true });
  if (!allocated.success) throw new Error(allocated.errorMsg);
  const position = point(instance, template, actor.roomKey, actor.positionOffset);
  if (!position) throw new Error("EPIC_CINEMATIC_ROOM_POSITION_REQUIRED");
  const dogma = require("../fitting/liveFittingState");
  const speed = Number(dogma.getTypeAttributeValue(actor.typeID, "maxVelocity"));
  const inertia = Number(dogma.getTypeAttributeValue(actor.typeID, "agility"));
  const entity = { itemID: allocated.data, typeID: actor.typeID, groupID: actor.groupID, categoryID: actor.categoryID || 11,
    ownerID: actor.ownerID, kind: "siteEnvironmentProp", slimName: "", suppressSlimName: true,
    position, velocity: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 }, targetPoint: { ...position },
    mass: Math.max(1, Number(actor.mass) || 1000000),
    maxVelocity: speed > 0 && Number.isFinite(speed) ? speed : 1000,
    inertia: inertia > 0 && Number.isFinite(inertia) ? inertia : 1,
    shieldCapacity: 0, armorHP: 0, structureHP: 0,
    radius: Math.max(1, Number(actor.radius) || 1), mode: "STOP", speedFraction: 0, isMassive: false,
    destinyForceFree: true,
    persistSpaceState: false, transient: true, dungeonMaterializedSiteContent: true,
    dungeonSiteInstanceID: instance.instanceID, dungeonSiteID: instance.metadata?.siteID,
    dungeonSiteContentKey: actor.key, epicCinematicKey: actor.key, epicCinematicRoomKey: actor.roomKey,
    sceneKey: scene.sceneKey, sceneKind: scene.sceneKind };
  const restoredWarp = restoreCapturedWarp(scene, instance, template, actor, entity, age);
  const result = scene.spawnDynamicEntity(entity, { broadcast: false });
  if (!result?.success) throw new Error(result?.errorMsg || "EPIC_CINEMATIC_SPAWN_PENDING");
  const row = { itemID: entity.itemID, born: false, ingressAccepted: restoredWarp, ingressAttempt: 0,
    ingressSuperseded: false, motionSignature: null };
  state(scene).actors.set(`${instance.instanceID}:${actor.key}`, row);
  return row;
}
function remove(scene, entity, actor) {
  const result = scene.unregisterDynamicEntity(entity, { broadcast: true, persistSpaceState: false,
    terminalDestructionEffectID: actor.explosionEffectID || 0 });
  if (result === false || result?.success === false) throw new Error("EPIC_CINEMATIC_REMOVAL_PENDING");
}
function timeline(scene, instance, template, rules, ownerShip, nowMs) {
  nowMs = sceneTime(scene, nowMs);
  if (rules?.version !== 1 || !Array.isArray(rules.actors) || rules.actors.length > 2048) return;
  const ages = new Map();
  for (const roomKey of new Set(rules.actors.map(actor => actor.roomKey))) ages.set(roomKey, roomAge(scene, instance, roomKey, ownerShip, nowMs));
  for (const [key, row] of state(scene).actors) if (!scene.getEntityByID(row.itemID)) state(scene).actors.delete(key);
  // All births precede commands so a same-tick cohort can refer to itself.
  for (const actor of rules.actors) {
    const age = ages.get(actor.roomKey), key = `${instance.instanceID}:${actor.key}`;
    let row = state(scene).actors.get(key), entity = row && scene.getEntityByID(row.itemID);
    const alive = age !== null && age >= actor.bornAtMs && (actor.removedAtMs === undefined || age < actor.removedAtMs);
    if (!alive) { if (entity) remove(scene, entity, actor); state(scene).actors.delete(key); continue; }
    if (!row) { row = spawn(scene, instance, template, actor, age); entity = scene.getEntityByID(row.itemID); }
    if (actor.visibleWarpDurationMs && !row.ingressAccepted && !row.ingressSuperseded) {
      const attempt = ++row.ingressAttempt;
      const result = scene.startSessionlessWarpIngress(entity, point(instance, template, actor.roomKey, actor.arrivalPositionOffset), {
        ingressDurationMs: actor.visibleWarpDurationMs, visibilitySuppressMs: 0, useNativeWarpProfile: true,
        suppressCompletionStopUpdates: true,
        onRefusedWhenApplied() {
          if (!row.ingressSuperseded && row.ingressAttempt === attempt) row.ingressAccepted = false;
        },
      });
      if (!result?.success) continue;
      row.ingressAccepted = true;
    }
    if (!row.born) {
      // Local balls publish through Grid bubble membership after registration;
      // [] is a valid return from broadcastAddBalls for those balls. An explicit
      // refusal remains retryable without resetting an accepted ingress warp.
      const publication = scene.broadcastAddBalls([entity]);
      if (publication === false || publication?.success === false) continue;
      row.born = true;
    }
  }
  for (const actor of rules.actors) {
    const row = state(scene).actors.get(`${instance.instanceID}:${actor.key}`), entity = row && scene.getEntityByID(row.itemID);
    if (!entity || !row.born) continue;
    const age = ages.get(actor.roomKey);
    const motion = (actor.motions || []).filter(command => command.atMs <= age).at(-1);
    if (motion) row.ingressSuperseded = true;
    const motionSignature = motion && JSON.stringify(motion);
    if (motion && row.motionSignature !== motionSignature) {
      let accepted = false;
      if (motion.kind === "orbit") {
        const target = reference(scene, instance, motion.target);
        if (target) accepted = scene.orbitShipEntity(entity, target.itemID, motion.rangeMeters, { speedFraction: motion.speedFraction });
      } else if (motion.kind === "stop") accepted = scene.stopShipEntity(entity, { persistSpaceState: false });
      else if (motion.kind === "warp") accepted = scene.startSessionlessWarpIngress(entity,
        point(instance, template, actor.roomKey, motion.positionOffset), { ingressDurationMs: 1000,
          visibilitySuppressMs: 0, useNativeWarpProfile: true,
          stopDistance: motion.stopDistance, warpSpeedAU: motion.warpSpeedAU,
          onRefusedWhenApplied() {
            if (row.motionSignature === motionSignature) row.motionSignature = null;
          },
        })?.success;
      if (accepted) row.motionSignature = motionSignature;
    }
    const effects = new Map();
    for (const rule of actor.effects || []) if (rule.atMs <= age) effects.set(`${rule.guid}:${JSON.stringify(rule.target)}`, rule);
    for (const rule of effects.values()) {
      const lifetimeMs = Math.max(1, Number(rule.durationMs) || 1000) * (Math.max(0, Number(rule.repeat) || 0) + 1);
      if (rule.start !== false && age - rule.atMs > lifetimeMs) continue;
      effect(scene, instance, entity, rule, reference(scene, instance, rule.target), nowMs);
    }
  }
}
module.exports = { reference, companions, timeline, point, effect };
