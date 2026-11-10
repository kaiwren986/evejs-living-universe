"use strict";

// Projectiles and applications belong to exact live references in one scene.
// Ship persistence stores simulation budgets and a pending lethal settlement,
// never an offline damage loop or an ID-only target relationship.
const { round6, toFiniteNumber } = require("../../common/numbers");
const { matchesTypeList, getTypeList } = require("../../services/inventory/typeListAuthority");
const { resolveItemByTypeID } = require("../../services/inventory/itemTypeRegistry");
const { getAttributeIDByNames, getEffectIDByNames, getTypeEffectRecords,
  buildEffectiveItemAttributeMap } = require("../../services/fitting/liveFittingState");
const { canEntitiesInteractLocally } = require("../destiny/identity/interactionScope");
const { compareEntityIDs } = require("../destiny/identity/entityID");
const { serializeRuntimeEntityScopeMetadata } = require("../runtime/entityScopeTags");
const { getEntityMaxHealthLayers } = require("./damage");
const { isEntityCloaked } = require("../runtime/shipCloak");
const { validApplication, normalizeBreacherPodRuntimeRecord } = require("./breacherPodState");

const STATE_KEY = "breacherPodRuntime";
const TICK_MS = 1000;
const projectiles = new WeakMap();
const sceneProjectiles = new WeakMap();
const targets = new WeakMap();
const scenes = new WeakMap();
const hydration = new WeakMap();
const detachedSnapshots = new WeakMap();
const tickTokens = new WeakMap();
// Paid impacts whose application did not persist, per scene: flight to
// target. Evolve removes a pod that hits, so the flight is kept here and
// the impact is retried each scene tick until it persists or the target
// leaves. The ammunition was paid at launch and is not debited again.
const pendingImpacts = new WeakMap();
// These attributes/effect are absent in build 3396210. Resolve by authored
// name only; donor numeric fallbacks must not enable unsupported defenses.
const resistanceID = getAttributeIDByNames("breacherPodDamageResistance");
const activatedPercentageID = getAttributeIDByNames("breacherPodActivatedDamageReceivedPercentage");
const damageControlEffectID = getEffectIDByNames("breacherPodDamageControl");

function isBreacherPodTarget(entity, listID = 792) {
  const type = resolveItemByTypeID(entity?.typeID);
  return Boolean(entity && !entity.destroyed && !entity.removed && type && getTypeList(listID) && matchesTypeList(type, listID));
}
function validSnapshot(snapshot) {
  const moduleType = resolveItemByTypeID(snapshot?.moduleTypeID);
  const chargeType = resolveItemByTypeID(snapshot?.chargeTypeID);
  return snapshot?.family === "breacherPodLauncher" && moduleType?.published && moduleType.groupID === 4807 &&
    chargeType?.published && chargeType.groupID === 4808 && chargeType.graphicID > 0 &&
    getTypeEffectRecords(chargeType.typeID).some((effect) => effect.name === "dotMissileLaunching") &&
    snapshot.targetTypeListID === 792 && getTypeList(792) && snapshot.dotDurationMs > 0 &&
    snapshot.dotMaxDamagePerTick > 0 && snapshot.dotMaxHPPercentagePerTick > 0;
}
function attribution(source, snapshot) {
  return { itemID: source.itemID, ownerID: source.ownerID, typeID: source.typeID, kind: source.kind,
    groupID: source.groupID, categoryID: source.categoryID, characterID: source.session?.characterID || source.characterID,
    corporationID: source.corporationID, allianceID: source.allianceID, warFactionID: source.warFactionID,
    sceneKey: source.sceneKey, ...serializeRuntimeEntityScopeMetadata(source),
    combatIdentity: require("./killmailTracker").resolveAttackerIdentity(source, { weaponSnapshot: snapshot }) };
}
function captureProjectile(projectile, source, target, snapshot) {
  if (!validSnapshot(snapshot) || !isBreacherPodTarget(target, snapshot.targetTypeListID)) return false;
  projectile.breacherPodProjectile = true;
  projectile.structureHP = Math.max(0, toFiniteNumber(snapshot.chargeAttributes?.[9], 0));
  projectile.conditionState = { damage: 0, armorDamage: 0, shieldCharge: 1 };
  projectile.passiveDerivedState = { attributes: { ...snapshot.chargeAttributes } };
  projectiles.set(projectile, { target, source: attribution(source, snapshot), snapshot, accepted: false, impact: false });
  return true;
}
function isOwnedProjectile(scene, projectile) {
  return Boolean(projectiles.get(projectile)?.scene === scene && scene?.dynamicEntities.get(projectile.itemID) === projectile);
}
function registerProjectile(scene, projectile) {
  const flight = projectiles.get(projectile);
  if (!flight || (flight.scene && flight.scene !== scene)) return false;
  flight.scene = scene;
  if (!sceneProjectiles.has(scene)) sceneProjectiles.set(scene, new Set());
  sceneProjectiles.get(scene).add(projectile);
  return true;
}
function removeProjectile(scene, projectile, options = {}) {
  if (!isOwnedProjectile(scene, projectile)) return false;
  projectile.removed = true;
  scene.unregisterDynamicEntity(projectile, { persistSpaceState: false, ...options });
  return true;
}
function stageLaunch({ scene, attacker, target, snapshot, moduleItem, chargeItem, nowMs, callbacks }) {
  let projectile;
  try {
    const result = scene.launchMissile(attacker, target.itemID, snapshot,
      { launchTimeMs: nowMs, moduleItem, chargeItem, skipRangeCheck: true, broadcast: false,
        initialPublication: "deferred" });
    projectile = result?.data?.entity;
    if (!result?.success || !isOwnedProjectile(scene, projectile)) throw new Error("Breacher spawn refused");
  } catch (error) {
    // A partially registered spawn can throw before returning its reference.
    for (const entity of [...(sceneProjectiles.get(scene) || [])]) {
      const flight = projectiles.get(entity);
      if (flight && !flight.accepted && flight.source.itemID === attacker.itemID &&
          entity.sourceModuleID === moduleItem.itemID && entity.launchedAtMs === nowMs) {
        if (!removeProjectile(scene, entity, { broadcast: false })) handleEntityRemoved(scene, entity);
      }
    }
    callbacks.warn("Breacher spawn failed", error);
    return { success: false, errorMsg: "BREACHER_SPAWN_FAILED" };
  }
  if (scene.dynamicEntities.get(attacker.itemID) !== attacker || scene.dynamicEntities.get(target.itemID) !== target ||
      attacker.mode === "WARP" || target.mode === "WARP" ||
      isEntityCloaked(attacker) || isEntityCloaked(target) ||
      !isBreacherPodTarget(target, snapshot.targetTypeListID) || !canEntitiesInteractLocally(projectile, target)) {
    removeProjectile(scene, projectile, { broadcast: false });
    return { success: false, errorMsg: "BREACHER_TARGET_LOST" };
  }
  const flight = projectiles.get(projectile);
  const consumption = callbacks.consumeLoadedCharge(attacker, moduleItem, chargeItem, nowMs);
  if (!consumption?.success) {
    removeProjectile(scene, projectile, { broadcast: false });
    return { success: false, errorMsg: consumption?.errorMsg || "AMMO_UPDATE_FAILED" };
  }
  // Custody may commit and then remove a live entity during notification.
  // Keep the accepted receipt even when cleanup has removed its weak entry.
  flight.accepted = true;
  if (consumption.data?.nextQuantity === 0) consumption.data.depleted = true;
  if (isOwnedProjectile(scene, projectile)) {
    projectile.evejsInitialPublicationDeferred = false;
    try { callbacks.publishBomb(projectile); } catch (error) { callbacks.warn("Breacher publication failed", error); }
  }
  return { success: true, data: { entity: projectile, consumption } };
}
function getSceneTargets(scene) {
  if (!scenes.has(scene)) scenes.set(scene, new Set());
  return scenes.get(scene);
}
function ownsTarget(scene, target) {
  return targets.get(target)?.scene === scene && scene?.dynamicEntities.get(target.itemID) === target;
}
function persist(target) { return require("../runtime/entitySpacePersistence").persistDynamicEntity(target); }
function cloneApplication(app) {
  if (!validApplication(app)) return null;
  return structuredClone(app);
}
function registerImpact(scene, projectile, target, nowMs) {
  const flight = projectiles.get(projectile);
  if (!isOwnedProjectile(scene, projectile) || !flight.accepted || flight.target !== target ||
      scene.dynamicEntities.get(target?.itemID) !== target || !canEntitiesInteractLocally(projectile, target) ||
      !isBreacherPodTarget(target, flight.snapshot.targetTypeListID)) return { success: false, errorMsg: "INVALID_BREACHER_IMPACT" };
  if (flight.impact) return { success: true, data: { duplicate: true } };
  const result = applyImpact(scene, flight, target, nowMs);
  if (result.retry) {
    if (!pendingImpacts.has(scene)) pendingImpacts.set(scene, new Map());
    pendingImpacts.get(scene).set(flight, target);
  }
  return result;
}
function applyImpact(scene, flight, target, nowMs) {
  const snapshot = flight.snapshot;
  const previous = targets.get(target);
  const state = ownsTarget(scene, target) ? previous : { scene, applications: [], nextTickAtMs: nowMs + TICK_MS, pendingKill: null };
  const before = { applications: state.applications, nextTickAtMs: state.nextTickAtMs };
  // The brief's bounded application identity is one source ship/module; reapply
  // refreshes that application without moving the target's shared tick cadence.
  // A refresh keeps the replaced application's start, so it stays live for a
  // due time it lands on or after; it moves only the expiry and takes the new
  // pod's figures. A new source's application is live only after its impact.
  // Only what the cadence no longer owes is dropped: an application live at a
  // due time not yet dealt (nextTickAtMs <= nowMs) is kept for that tick.
  const live = state.applications.filter((entry) => entry.expiresAtMs >= Math.min(nowMs, state.nextTickAtMs));
  const sameSource = (entry) => entry.source.itemID === flight.source.itemID && entry.moduleID === snapshot.moduleID;
  // Only an application still live at the impact is replaced. One that has
  // ended but is still owed a tick stays beside the new one for that tick,
  // so a refresh never makes the seconds between them live.
  const replaced = live.find((entry) => sameSource(entry) && entry.expiresAtMs >= nowMs);
  const app = { source: flight.source, moduleID: snapshot.moduleID, moduleTypeID: snapshot.moduleTypeID,
    chargeTypeID: snapshot.chargeTypeID, startedAtMs: replaced ? replaced.startedAtMs : nowMs,
    expiresAtMs: nowMs + snapshot.dotDurationMs,
    flat: snapshot.dotMaxDamagePerTick, percentage: snapshot.dotMaxHPPercentagePerTick };
  state.applications = live.filter((entry) => entry !== replaced).concat(app);
  targets.set(target, state); getSceneTargets(scene).add(target);
  const result = persist(target);
  if (target.persistSpaceState === true && !result?.success) {
    state.applications = before.applications; state.nextTickAtMs = before.nextTickAtMs;
    if (!previous) { targets.delete(target); getSceneTargets(scene).delete(target); }
    return { success: false, retry: true, errorMsg: "BREACHER_APPLICATION_WRITE_FAILED" };
  }
  flight.impact = true;
  return { success: true, data: { application: structuredClone(app) } };
}
function retryPendingImpacts(scene, nowMs) {
  const pending = pendingImpacts.get(scene);
  if (!pending) return;
  for (const [flight, target] of [...pending]) {
    if (flight.impact || scene.dynamicEntities.get(target?.itemID) !== target || target.destroyed || target.removed ||
        applyImpact(scene, flight, target, nowMs).success) pending.delete(flight);
  }
  if (!pending.size) pendingImpacts.delete(scene);
}
function resolveApplicationDamage(app, rawHP) { return round6(Math.min(app.flat, Math.max(0, rawHP) * app.percentage / 100)); }
function resolveDamageMultiplier(target) {
  let multiplier = resistanceID ? Math.max(0, toFiniteNumber(target.passiveDerivedState?.attributes?.[resistanceID], 1)) : 1;
  if (damageControlEffectID && activatedPercentageID) {
    for (const effect of target.activeModuleEffects?.values() || []) {
      if (effect.effectID !== damageControlEffectID) continue;
      const item = require("../runtime/entityDogmaView").getEntityRuntimeModuleItem(target, effect.moduleID);
      const attributes = buildEffectiveItemAttributeMap(item, null, { attributeOverrides: effect.genericAttributeOverrides });
      multiplier *= Math.max(0, 1 + toFiniteNumber(attributes[activatedPercentageID], 0) / 100);
    }
  }
  return round6(multiplier);
}
function isAuthorizedTick(scene, target, token) {
  const tick = tickTokens.get(token);
  return Boolean(tick && tick.scene === scene && tick.target === target && ownsTarget(scene, target));
}
function noteHealthResult(token, damageResult) {
  const tick = tickTokens.get(token);
  if (tick && damageResult?.data?.destroyed && !tick.state.pendingKill) {
    const applied = require("../runtime/combatDamageMessages").getAppliedDamageAmount(damageResult);
    tick.state.pendingKill = { application: tick.application, atMs: tick.atMs, amount: tick.amount,
      deathRecord: require("../../services/ship/breacherPodDeathRuntime")
        .prepare(tick.scene, tick.target, tick.application, tick.atMs, applied) };
  }
}
function getPendingKill(scene, target) { return ownsTarget(scene, target) ? targets.get(target).pendingKill : null; }
// An application is live after its impact and through its expiry.
function isLiveAt(app, atMs) { return app.startedAtMs < atMs && app.expiresAtMs >= atMs; }
// With nothing live at the due time atMs: the first due time, whole seconds
// on, after the earliest start among the applications still to come, or
// after nowMs when none is. The due times skipped deal nothing, so no tick
// changes and the cadence keeps its phase, however far behind it is.
function firstLiveDueTime(applications, atMs, nowMs) {
  const starts = applications.filter((app) => app.expiresAtMs >= atMs).map((app) => app.startedAtMs);
  const fromMs = starts.length ? Math.min(...starts) : nowMs;
  return atMs + Math.max(1, Math.floor((fromMs - atMs) / TICK_MS) + 1) * TICK_MS;
}
function tickScene(scene, nowMs) {
  retryPendingImpacts(scene, nowMs);
  for (const target of [...getSceneTargets(scene)]) {
    if (!ownsTarget(scene, target) || target.destroyed || target.removed) { handleEntityRemoved(scene, target); continue; }
    const state = targets.get(target);
    let blocked = false;
    while (state.pendingKill || (state.nextTickAtMs > 0 && state.nextTickAtMs <= nowMs)) {
      const atMs = state.pendingKill?.atMs ?? state.nextTickAtMs;
      const hp = Object.values(getEntityMaxHealthLayers(target)).reduce((total, amount) => total + amount, 0);
      const selected = state.pendingKill?.application || state.applications.filter((app) => isLiveAt(app, atMs))
        .sort((left, right) => resolveApplicationDamage(right, hp) - resolveApplicationDamage(left, hp) ||
          left.startedAtMs - right.startedAtMs || compareEntityIDs(left.source.itemID, right.source.itemID) || left.moduleID - right.moduleID)[0];
      // Nothing live at this due time: the cadence moves on rather than
      // waiting on it (a waiting cadence never ticks again), straight to the
      // next due time anything can be live at.
      if (!selected) { state.nextTickAtMs = firstLiveDueTime(state.applications, atMs, nowMs); continue; }
      const before = { nextTickAtMs: state.nextTickAtMs, pendingKill: state.pendingKill };
      const amount = state.pendingKill?.amount ?? resolveApplicationDamage(selected, hp) * resolveDamageMultiplier(target);
      if (!state.pendingKill) state.nextTickAtMs += TICK_MS;
      const token = {};
      tickTokens.set(token, { scene, target, state, application: selected, atMs, amount });
      let result;
      try { result = require("../runtime/breacherPodDamage").applyBreacherPodTickDamage(scene, target, selected, amount, atMs, token); }
      finally { tickTokens.delete(token); }
      if (result?.damageResult?.success === false) {
        state.nextTickAtMs = before.nextTickAtMs; state.pendingKill = before.pendingKill; blocked = true; break;
      }
      if (result?.destroyed) { handleEntityRemoved(scene, target); break; }
      if (state.pendingKill) break; // Retry normal destruction on a later scene tick.
    }
    if (!ownsTarget(scene, target)) continue;
    if (blocked) continue;
    if (!state.pendingKill) state.applications = state.applications.filter((app) => app.expiresAtMs > nowMs);
    if (!state.applications.length && !state.pendingKill) {
      state.nextTickAtMs = 0; targets.delete(target); getSceneTargets(scene).delete(target); persist(target);
    }
  }
}
function serializeRuntimeState(target) {
  if (detachedSnapshots.has(target)) return structuredClone(detachedSnapshots.get(target));
  const state = targets.get(target);
  if (!state || !ownsTarget(state.scene, target)) return null;
  const nowMs = state.scene.getCurrentSimTimeMs();
  // Times are kept relative to the save, unclamped: a due time not yet dealt
  // is recorded overdue (nextTickInMs < 0), and an application the cadence
  // still owes a tick keeps its expiry even when that has passed. Only what
  // the cadence no longer owes is left out, so a restart changes no tick.
  const owedFromMs = Math.min(nowMs, state.nextTickAtMs);
  return { version: 1, targetID: target.itemID, sceneKey: state.scene.sceneKey,
    scope: serializeRuntimeEntityScopeMetadata(target), savedAtMs: nowMs,
    nextTickInMs: state.nextTickAtMs - nowMs,
    applications: state.applications.filter((app) => app.expiresAtMs >= owedFromMs).map((app) => ({
      ...structuredClone(app),
      startedAgoMs: Math.max(0, nowMs - app.startedAtMs), remainingMs: app.expiresAtMs - nowMs })),
    pendingKill: state.pendingKill ? structuredClone(state.pendingKill) : null };
}
function prepareHydration(entity, spaceState) {
  const record = normalizeBreacherPodRuntimeRecord(spaceState?.[STATE_KEY]);
  if (record?.version === 1 && record.targetID === entity.itemID) hydration.set(entity, structuredClone(record));
}
function registerSceneEntity(scene, entity) {
  const record = hydration.get(entity);
  hydration.delete(entity);
  if (!record || record.sceneKey !== scene.sceneKey || !isBreacherPodTarget(entity) ||
      JSON.stringify(record.scope) !== JSON.stringify(serializeRuntimeEntityScopeMetadata(entity))) return false;
  const nowMs = scene.getCurrentSimTimeMs();
  // An overdue due time is restored overdue, so the first tickScene deals it;
  // one with nothing live at it moves on to the first due time anything can
  // be live at, so however overdue the record, no tick is walked through.
  let nextTickAtMs = nowMs + Math.min(TICK_MS, toFiniteNumber(record.nextTickInMs, TICK_MS));
  const applications = (record.applications || []).map((entry) => cloneApplication({ ...entry,
    startedAtMs: nowMs - Math.max(0, toFiniteNumber(entry.startedAgoMs, 0)),
    expiresAtMs: nowMs + toFiniteNumber(entry.remainingMs, 0),
  })).filter((app) => app && app.expiresAtMs >= Math.min(nowMs, nextTickAtMs));
  if (!record.pendingKill && nextTickAtMs <= nowMs && !applications.some((app) => isLiveAt(app, nextTickAtMs))) {
    nextTickAtMs = firstLiveDueTime(applications, nextTickAtMs, nowMs);
  }
  const pendingKill = record.pendingKill && cloneApplication(record.pendingKill.application)
    ? { ...record.pendingKill, application: cloneApplication(record.pendingKill.application) } : null;
  if (!applications.length && !pendingKill) return false;
  targets.set(entity, { scene, applications, nextTickAtMs, pendingKill });
  getSceneTargets(scene).add(entity);
  return true;
}
function retainForUnload(scene, entity, options = {}) {
  const state = targets.get(entity);
  if (state?.scene !== scene) return;
  let retain = options.preserveBreacherApplicationBudget === true;
  if (state.pendingKill?.deathRecord) {
    try { require("../../services/ship/breacherPodDeathRuntime").accept(state.pendingKill.deathRecord); }
    catch (error) { retain = true; require("../../utils/logger").warn(`[Breacher] Retaining terminal intent: ${error.message}`); }
  }
  if (retain) {
    const snapshot = serializeRuntimeState(entity);
    if (snapshot) detachedSnapshots.set(entity, snapshot);
  }
}
function handleEntityRemoved(scene, entity, options = {}) {
  retainForUnload(scene, entity, options);
  if (targets.get(entity)?.scene === scene) { targets.delete(entity); getSceneTargets(scene).delete(entity); }
  if (projectiles.get(entity)?.scene === scene) {
    sceneProjectiles.get(scene)?.delete(entity);
    projectiles.delete(entity);
  }
}
function clearScene(scene) {
  pendingImpacts.delete(scene);
  for (const target of [...getSceneTargets(scene)]) { retainForUnload(scene, target); targets.delete(target); persist(target); }
  getSceneTargets(scene).clear();
  for (const entity of [...(sceneProjectiles.get(scene) || [])]) {
    if (!removeProjectile(scene, entity, { broadcast: false })) handleEntityRemoved(scene, entity);
  }
  sceneProjectiles.delete(scene);
}
function getApplications(scene, target) { return ownsTarget(scene, target) ? structuredClone(targets.get(target).applications) : []; }
function getTickDeadline(target) {
  const state = targets.get(target);
  return state && ownsTarget(state.scene, target) ? (state.pendingKill ? 0 : state.nextTickAtMs) : null;
}

module.exports = { STATE_KEY, isBreacherPodTarget, validSnapshot, captureProjectile, registerProjectile, isOwnedProjectile,
  removeProjectile, stageLaunch, registerImpact, resolveApplicationDamage, resolveDamageMultiplier,
  isAuthorizedTick, noteHealthResult, getPendingKill, tickScene, serializeRuntimeState, prepareHydration, registerSceneEntity,
  handleEntityRemoved, clearScene, getApplications, getTickDeadline };
