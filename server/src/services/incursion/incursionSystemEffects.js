"use strict";
const incursionClock = require("./incursionClock");

const { VERSION, RESONANCES } = require("./incursionSystemEffectContract");
const { projectInfluence, fingerprint } = require("./incursionLifecycleContract");
const presentation = require("./incursionPresentation");
const sceneStates = new WeakMap();
const primeStates = new WeakMap();
const entityStates = new WeakMap();
let clock = incursionClock.now;
function context(systemID, nowMs = clock()) {
  const tale = presentation.forSystem(systemID);
  const policy = tale?.policy.effects?.application;
  if (!policy || policy.version !== VERSION) return null;
  const role = tale.placement.systems.find(row => row.solarSystemID === Number(systemID));
  const binding = policy.scenes[role.sceneType];
  if (!binding) throw new Error("INCURSION_SYSTEM_EFFECT_BINDING_MISSING");
  const opposition = 1 - projectInfluence(tale.influence, nowMs);
  return { tale, policy, binding, resistancePercent: binding.resistancePercent * opposition,
    damageMultiplier: 1 + binding.damagePercent / 100 * opposition };
}
function isPlayerShip(entity) {
  return entity?.kind === "ship" && entity.nativeNpc !== true &&
    Number(entity.pilotCharacterID || entity.characterID || entity.session?.characterID || entity.session?.charid) > 0;
}
function isPlayerDrone(entity) {
  return entity?.kind === "drone" && entity.nativeNpc !== true &&
    Number(entity.characterID || entity.ownerID) >= 90000000;
}
function shipModifiers(entity, nowMs = clock()) {
  if (!isPlayerShip(entity)) return [];
  const ctx = context(entity.systemID, nowMs);
  if (!ctx || !ctx.resistancePercent) return [];
  return RESONANCES.map(modifiedAttributeID => ({ modifiedAttributeID, operation: 6,
    value: ctx.resistancePercent, stackingPenalized: false,
    modifierSourceKey: `incursion:${ctx.tale.taleID}:${VERSION}` }));
}
function damageMultiplier(entity, weaponKind, systemID = entity?.systemID, nowMs = clock()) {
  if (!isPlayerShip(entity) && !isPlayerDrone(entity)) return 1;
  const ctx = context(systemID, nowMs);
  if (!ctx || !ctx.policy.weaponKinds.includes(isPlayerDrone(entity) ? "drone" : weaponKind)) return 1;
  return ctx.damageMultiplier;
}
function bountyMultiplier(systemID) { return context(systemID)?.policy.bountyMultiplier ?? 1; }
function blocksCyno(systemID) { return Boolean(context(systemID)); }

// Client module reads project the same coefficient. These copies never feed
// production firing: damage crosses one explicit weapon-kind gate, not two.
function displayWeaponAttributes(result, entity) {
  if (!result || !isPlayerShip(entity)) return result;
  const dogma = require("../../space/combat/weaponDogma");
  const kind = dogma.isTurretWeaponFamily(result.family) ? "turret" :
    dogma.isMissileWeaponFamily(result.family) && !dogma.isBreacherPodWeaponFamily(result.family) ? "launcher" : null;
  const multiplier = damageMultiplier(entity, kind);
  if (multiplier === 1) return result;
  const copy = { ...result, moduleAttributes: { ...result.moduleAttributes }, chargeAttributes: { ...result.chargeAttributes } };
  if (kind === "turret") copy.moduleAttributes[64] = (copy.moduleAttributes[64] ?? 1) * multiplier;
  if (kind === "launcher") for (const attribute of [114, 116, 117, 118]) {
    if (Number.isFinite(copy.chargeAttributes[attribute])) copy.chargeAttributes[attribute] *= multiplier;
  }
  return copy;
}
function displayGenericAttributes(result, item, entity) {
  if (!result || !item) return result;
  const dogma = require("../../space/combat/weaponDogma");
  const turret = dogma.isTurretWeaponFamily(dogma.resolveWeaponFamily(item));
  const kind = turret ? "turret" : Number(item.groupID) === 72 ? "smartbomb" : null;
  const multiplier = damageMultiplier(entity, kind);
  if (multiplier === 1) return result;
  const attributes = { ...result.attributeOverrides };
  if (turret) attributes[64] = (attributes[64] ?? 1) * multiplier;
  else for (const id of [114, 116, 117, 118]) if (Number.isFinite(attributes[id])) attributes[id] *= multiplier;
  return { ...result, attributeOverrides: attributes };
}
function projectAttributeChange(session, itemID, attributeID, value, previous) {
  const unchanged = [value, previous];
  if (![64, 114, 116, 117, 118].includes(attributeID)) return unchanged;
  const systemID = Number(session?.solarsystemid2 !== undefined ? session.solarsystemid2 : session?._space?.systemID);
  const ctx = context(systemID);
  if (!ctx || ctx.damageMultiplier === 1 || !session?._space) return unchanged;
  const inventory = require("../inventory/simulationInventoryProjection");
  const fitting = require("../fitting/liveFittingState");
  const tuple = Array.isArray(itemID) ? itemID : null;
  const item = tuple ? fitting.getLoadedChargeByFlag(Number(session.characterID), Number(tuple[0]), Number(tuple[1]))
    : inventory.findItemById(Number(itemID));
  const shipID = Number(session._space.shipID || session.shipID || session.shipid);
  if (!item || Number(item.ownerID) !== Number(session.characterID) || Number(item.locationID) !== shipID) return unchanged;
  const charge = Number(item.categoryID) === 8;
  const module = charge ? fitting.getFittedModuleByFlag(Number(session.characterID), shipID, Number(item.flagID)) : item;
  const dogma = require("../../space/combat/weaponDogma");
  const family = dogma.resolveWeaponFamily(module, charge ? item : null);
  const matches = !charge && attributeID === 64 && dogma.isTurretWeaponFamily(family) ||
    charge && attributeID !== 64 && family === "missileLauncher" ||
    !charge && attributeID !== 64 && Number(item.groupID) === 72;
  if (!matches) return unchanged;
  return [Number.isFinite(value) ? value * ctx.damageMultiplier : value,
    Number.isFinite(previous) ? previous * ctx.damageMultiplier : previous];
}
function publishWeaponPrimes(entity) {
  const session = entity.session || require("../chat/sessionRegistry").findSessionByCharacterID(
    Number(entity.pilotCharacterID || entity.characterID));
  // Dogma primes do not depend on Destiny SetState; fitting/drone owners also
  // publish them before spatial bootstrap completes.
  if (!session?.sendNotification || !session._space) return 0;
  const view = require("../../space/runtime/entityDogmaView");
  const fitting = require("../fitting/liveFittingState");
  const DogmaService = require("../dogma/dogmaService");
  const service = new DogmaService(), { unwrapMarshalValue } = require("../_shared/serviceHelpers");
  const previous = primeStates.get(session) || new Map();
  let sent = 0;
  for (const module of view.getEntityRuntimeFittedItems(entity)) {
    const charge = view.getEntityRuntimeLoadedCharge(entity, module);
    const ids = [module.itemID, ...(charge ? [fitting.buildChargeTupleItemID(entity.itemID, charge.flagID, charge.typeID)] : [])];
    for (const id of ids) {
      const entry = service.Handle_ItemGetInfo([id], session);
      if (!entry) continue;
      const attributes = unwrapMarshalValue(entry).attributes || {};
      const token = fingerprint([id, ...[64, 114, 116, 117, 118].map(key => attributes[key] ?? null)]);
      const key = JSON.stringify(id);
      if (previous.get(key) === token) continue;
      session.sendNotification("OnGodmaPrimeItem", "clientID", [entity.itemID, entry]);
      previous.set(key, token); sent++;
    }
  }
  primeStates.set(session, previous);
  return sent;
}
function refreshScene(scene, { force = false, nowMs = clock() } = {}) {
  const ctx = context(scene.systemID, nowMs);
  const token = ctx ? fingerprint([ctx.tale.taleID, ctx.tale.revision, ctx.resistancePercent, ctx.damageMultiplier]) : "none";
  const sceneToken = `${token}:${scene.dynamicEntities?.size || 0}`;
  if (!ctx && !sceneStates.has(scene)) { sceneStates.set(scene, sceneToken); return 0; }
  // A departure and arrival can leave the collection size unchanged. Active
  // scenes must check entity identities; their individual stamps deduplicate
  // derived-state work without overlooking that replacement.
  if (!ctx && !force && sceneStates.get(scene) === sceneToken) return 0;
  let refreshed = 0;
  for (const entity of scene.dynamicEntities?.values() || []) {
    if (!isPlayerShip(entity)) continue;
    if (!force && entityStates.get(entity) === token) continue;
    if (!ctx && !entityStates.has(entity)) continue;
    const result = scene.refreshShipEntityDerivedState(entity, { notifyDerivedAttributes: true });
    if (result?.success === false) throw new Error(`INCURSION_ATTRIBUTE_REFRESH_FAILED:${result.errorMsg}`);
    publishWeaponPrimes(entity);
    entityStates.set(entity, token);
    refreshed++;
  }
  sceneStates.set(scene, sceneToken);
  return refreshed;
}
function refreshLoadedScenes() {
  const runtimePath = require.resolve("../../space/runtime");
  const runtime = require.cache[runtimePath]?.exports;
  let refreshed = 0;
  for (const scene of runtime?.scenes?.values() || []) refreshed += refreshScene(scene);
  return refreshed;
}
module.exports = { context, shipModifiers, damageMultiplier, bountyMultiplier, blocksCyno,
  displayWeaponAttributes, displayGenericAttributes, projectAttributeChange, publishWeaponPrimes, refreshScene, refreshLoadedScenes,
  _testing: { setClock(now = incursionClock.now) { clock = now; } } };
