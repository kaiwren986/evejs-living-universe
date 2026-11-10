"use strict";
const { applyWeaponDamageToTarget } = require("./targetDamageApplication");
const { getAppliedDamageAmount, notifyWeaponDamageMessages } = require("./combatDamageMessages");
const { noteDamage, enqueueKillmailFromDestruction } = require("../combat/killmailTracker");
const log = require("../../utils/logger");

function applyBreacherPodTickDamage(scene, target, application, amount, atMs, token) {
  const pending = require("../combat/breacherPods").getPendingKill(scene, target);
  if (pending?.deathRecord) {
    const result = require("../../services/ship/breacherPodDeathRuntime").retry(pending.deathRecord);
    return { destroyResult: result, destroyed: result.success === true, appliedDamage: 0, terminal: true };
  }
  const source = { ...application.source };
  const live = scene.getEntityByID(source.itemID);
  if (live?.ownerID === source.ownerID && live?.session?.characterID === source.characterID) source.session = live.session;
  const moduleItem = { itemID: application.moduleID, typeID: application.moduleTypeID };
  const weaponSnapshot = { family: "breacherPodLauncher", moduleID: application.moduleID,
    moduleTypeID: application.moduleTypeID, chargeTypeID: application.chargeTypeID };
  const damage = { em: amount, thermal: 0, kinetic: 0, explosive: 0 };
  const result = applyWeaponDamageToTarget(scene, source, target, damage, atMs,
    { action: "breacher-pod", breacherTickToken: token, resolvedDamageAmount: amount,
      alignLethalDamageToDestruction: true });
  const applied = getAppliedDamageAmount(result.damageResult);
  if (applied > 0) {
    if (!result.breacherDeathRecord) noteDamage(source, target, applied,
      { whenMs: atMs, weaponSnapshot, moduleItem, attackerIdentity: source.combatIdentity });
    try { notifyWeaponDamageMessages(source, target, moduleItem, damage, applied, 3,
      { presentationDamageAttributes: {} }); }
    catch (error) { log.warn(`[Breacher] Committed tick notification failed: ${error.message}`); }
  }
  const destroyed = result.destroyResult?.success === true;
  if (destroyed && !result.breacherDeathRecord) enqueueKillmailFromDestruction(target, result.destroyResult,
    { attackerEntity: source, scene, whenMs: atMs, weaponSnapshot, moduleItem, attackerIdentity: source.combatIdentity });
  return { ...result, destroyed, appliedDamage: applied };
}
module.exports = { applyBreacherPodTickDamage };
