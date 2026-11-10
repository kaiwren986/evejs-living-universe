"use strict";

// Native 3855 inputs are supplied by the matching client FSD. The special
// 4656 cadence/target-domain choices below are a frozen emulator policy, not
// recovered server code. Callers opt approved boss actors into that policy.
const SHIELD_VERSION = "evejs.npc-shield-support.v1";
const BOSS_VERSION = "evejs.sansha-boss-abilities.v1";
const { getTypeAttributeMap, getDogmaAttributeDefaultValue, typeHasEffectName } =
  require("../../services/fitting/liveFittingState");
const { canEntitiesInteractLocally } = require("../destiny/identity/interactionScope");
const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const attr = (map, id) => Number(map[id] ?? getDogmaAttributeDefaultValue(id, 0));
const live = entity => entity && entity.kind === "ship" && entity.destroyed !== true &&
  entity.destroying !== true && !["destroyed", "destroying"].includes(entity.destructionState) &&
  Number(entity.conditionState?.damage || 0) < 1 && entity.incursionHealthPending !== true &&
  entity.incursionRecoveryHold !== true && entity.incursionWaveHeld !== true;
const room = entity => entity?.npcBossCombatRoomKey || entity?.dungeonRoomKey || entity?.dungeonCurrentRoomKey || null;
const instance = entity => Number(entity?.dungeonSiteInstanceID || entity?.dungeonCurrentInstanceID) || 0;
function sameScope(source, target) {
  if (!canEntitiesInteractLocally(source, target)) return false;
  if (instance(source) && instance(source) !== instance(target)) return false;
  return !(room(source) && room(target) && room(source) !== room(target));
}
function distance(source, target, callbacks = {}) {
  if (typeof callbacks.getEntitySurfaceDistance === "function") {
    const value = Number(callbacks.getEntitySurfaceDistance(source, target));
    return Number.isFinite(value) ? Math.max(0, value) : Infinity;
  }
  if (![source?.position, target?.position].every(p => p && [p.x, p.y, p.z].every(Number.isFinite))) return Infinity;
  return Math.max(0, Math.hypot(...["x", "y", "z"].map(axis => source.position[axis] - target.position[axis])) -
    Math.max(0, Number(source.radius) || 0) - Math.max(0, Number(target.radius) || 0));
}
function shieldInputs(entity, attributeMap = getTypeAttributeMap(Number(entity?.typeID))) {
  if (!entity?.nativeNpc || !typeHasEffectName(Number(entity.typeID), "NPCRemoteShieldBoost")) return null;
  const inputs = { version: SHIELD_VERSION, effectID: 3855, durationMs: attr(attributeMap, 1458),
    chance: attr(attributeMap, 1459), amount: attr(attributeMap, 1460), damageThreshold: attr(attributeMap, 1462),
    rangeMeters: attr(attributeMap, 1464), maxTargets: attr(attributeMap, 1502) };
  if (!(inputs.durationMs > 0 && inputs.amount > 0 && inputs.rangeMeters > 0) ||
      !Number.isInteger(inputs.maxTargets) || inputs.maxTargets < 1 || inputs.maxTargets > 3 ||
      ![inputs.chance, inputs.damageThreshold].every(v => Number.isFinite(v) && v >= 0 && v <= 1)) return null;
  return inputs;
}
function shieldEligible(source, target, inputs, callbacks = {}) {
  if (!live(source) || !live(target) || source === target || !target.nativeNpc || !sameScope(source, target) ||
      target.cloaked === true || target.isCloaked === true || distance(source, target, callbacks) > inputs.rangeMeters + 1) return false;
  if (require("../modules/assistanceModuleRuntime").isEntityAssistanceDisallowed(target, callbacks.nowMs || 0)) return false;
  const registry = require("./npcRegistry"), sourceKind = registry.getControllerByEntityID(source.itemID)?.operatorKind;
  const targetKind = registry.getControllerByEntityID(target.itemID)?.operatorKind;
  const sourceFaction = Number(source.warFactionID || source.factionID) || 0;
  const targetFaction = Number(target.warFactionID || target.factionID) || 0;
  const friendly = sourceKind && targetKind ? sourceKind === targetKind :
    sourceFaction && sourceFaction === targetFaction ||
      Number(source.corporationID) > 0 && source.corporationID === target.corporationID;
  return Boolean(friendly && Number(target.shieldCapacity) > 0 &&
    Number(target.conditionState?.shieldCharge ?? 1) < 1 - inputs.damageThreshold);
}
function shieldTargets(scene, source, inputs, callbacks = {}) {
  return [...(scene?.dynamicEntities?.values() || [])]
    .filter(target => shieldEligible(source, target, inputs, callbacks))
    .sort((a, b) => Number(a.conditionState.shieldCharge) - Number(b.conditionState.shieldCharge) ||
      distance(source, a, callbacks) - distance(source, b, callbacks) || Number(a.itemID) - Number(b.itemID))
    .slice(0, inputs.maxTargets);
}
function bossEnabled(entity) {
  return Boolean(entity?.nativeNpc && [2192, 3071].includes(Number(entity.typeID)) &&
    positive(entity.dungeonSiteInstanceID) && entity.npcBossAbilityPolicyVersion === BOSS_VERSION && room(entity));
}
function bossPlayers(scene, source) {
  return [...(scene?.dynamicEntities?.values() || [])].filter(target => live(target) && !target.nativeNpc &&
    Number(target.groupID) !== 29 && positive(target.characterID || target.pilotCharacterID || target.session?.characterID) &&
    target.cloaked !== true && target.isCloaked !== true && sameScope(source, target) && room(target) === room(source));
}
function ecmInputs(entity, players, attributeMap = getTypeAttributeMap(Number(entity?.typeID))) {
  if (!bossEnabled(entity)) return null;
  const base = attr(attributeMap, 1661), minimum = attr(attributeMap, 1659), scale = attr(attributeMap, 1660);
  const step = attr(attributeMap, 1662), intended = attr(attributeMap, 1663), chance = attr(attributeMap, 1664);
  if (!(base > 0 && minimum > 0 && minimum <= base && scale > 0 && scale <= 1 && step > 0) ||
      !Number.isFinite(intended) || intended < 0 || !(chance >= 0 && chance <= 1)) return null;
  return { version: BOSS_VERSION, effectID: 4656, chance, radiusMeters: 170000,
    durationMs: Math.max(minimum, Math.round(base * scale ** Math.floor(Math.max(0, players - intended) / step))) };
}

// This is the small AI integration port. It creates one native effect; target
// selection and health commits remain in the assistance cycle owner.
function syncShieldModule(scene, entity, controller, moduleItem, effectName, pseudoSession) {
  const inputs = shieldInputs(entity);
  if (!inputs || !live(entity)) return false;
  const active = entity.activeModuleEffects?.get(Number(moduleItem.itemID));
  if (active?.nativeNpcShieldVersion === SHIELD_VERSION) return true;
  const targets = shieldTargets(scene, entity, inputs);
  for (const target of targets) if (!scene.getTargetsForEntity(entity).includes(target.itemID)) {
    scene.finalizeTargetLock(entity, target, { nowMs: scene.getCurrentSimTimeMs() });
  }
  const target = targets.find(candidate => scene.getTargetsForEntity(entity).includes(candidate.itemID));
  if (!target) return false;
  return scene.activateGenericModule(pseudoSession, moduleItem, effectName, { targetID: target.itemID })?.success === true;
}
function syncBossEcmModule(scene, entity, moduleItem, effectName, pseudoSession) {
  if (!bossEnabled(entity) || !live(entity) || !bossPlayers(scene, entity).length) return false;
  if (entity.activeModuleEffects?.get(Number(moduleItem.itemID))?.nativeBossBurstVersion === BOSS_VERSION) return true;
  const owner = require("./nativeNpcService"), nowMs = Math.trunc(scene.getCurrentSimTimeMs());
  const prior = owner.readNativeNpcAbilityState(entity.itemID)?.[4656];
  if (prior && nowMs < prior.nextAtMs) return true;
  const result = owner.reserveNativeNpcAbilityCycle({ scene, source: entity, effectID: 4656, nowMs });
  if (!result.success || result.pending || !result.cycle?.fired) return false;
  return scene.activateGenericModule(pseudoSession, moduleItem, effectName, {})?.success === true;
}
module.exports = { SHIELD_VERSION, BOSS_VERSION, live, sameScope, distance, shieldInputs, shieldEligible,
  shieldTargets, bossEnabled, bossPlayers, ecmInputs, syncShieldModule, syncBossEcmModule };
