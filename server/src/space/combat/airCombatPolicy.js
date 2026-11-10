"use strict";

// Read-only combat policy. The tutorial owner commits all lesson/death intent.
const characters = require("../../services/character/characterState");
function ownedCombat(scene, player, npc) {
  if (!npc?.airNpeInstanceID || npc.nativeNpc !== true) return null;
  const characterID = Number(player?.session?.characterID || player?.ownerID);
  const record = characters.getCharacterRecord(characterID), air = record?.authoredAirTutorial;
  if (!air?.encounter || scene?.systemID !== air.encounter.entry.systemID || player?.itemID !== record.shipID || npc?.nativeNpc !== true || npc.airNpeOwnerCharacterID !== characterID || npc.airNpeInstanceID !== air.encounter.sites?.[2433]?.instanceID || npc.sceneKey !== scene.sceneKey) return null;
  return air;
}
function damageMultiplier(scene, source, target) {
  const playerAir = ownedCombat(scene, source, target);
  if (playerAir?.status === "active" && playerAir.phaseGraphID === 686 && source.itemID === playerAir.encounter.boardingHullID && playerAir.encounter.combat?.stage === "cruiser" && target.typeID === 57802 && target.airEncounterSlot === "hostile:cruiser") return 2;
  const air = ownedCombat(scene, target, source);
  if (source?.typeID === 57803 && source.airEncounterSlot?.startsWith("hostile:battleship:") && air?.encounter.combat?.deaths?.ship?.status === "accepted" && target.itemID === air.encounter.combat.deaths.ship.plan.shipRecord.itemID) return 5;
  return 1;
}
// The AIR fleet battle (services/npe/airFleetBattle.js): one of a pilot's AIR NPCs shooting
// another of the same site wears it down to this much structure damage, and no further. It keeps
// burning, nobody dies of the show, and the lesson's hostiles are still the pilot's kills.
const AIR_BATTLE_DAMAGE_FLOOR = 0.6;
// Two NPCs of the same pilot's AIR site: one shooting the other is the fleet battle.
function isBattleShot(source, target) {
  return source?.nativeNpc === true && target?.nativeNpc === true && Boolean(source.airEncounterSlot && target.airEncounterSlot) &&
    Number(target.airNpeInstanceID) > 0 && source.airNpeInstanceID === target.airNpeInstanceID && source.airNpeOwnerCharacterID === target.airNpeOwnerCharacterID;
}
// The share of a shot that lands (1 for any shot outside the battle). Damage takes shield, then
// armour, then structure: kept above the floor's share of the structure in all, the structure
// never drops below it. The raw damage is what resists can only lower.
function battleShotScale(source, target, rawDamage) {
  if (!isBattleShot(source, target)) return 1;
  const health = require("./damage");
  const max = health.getEntityMaxHealthLayers(target), current = health.getEntityCurrentHealthLayers(target, max);
  const spare = current.shield + current.armor + current.structure - max.structure * (1 - AIR_BATTLE_DAMAGE_FLOOR);
  const raw = Object.values(rawDamage || {}).reduce((sum, amount) => sum + Math.max(0, Number(amount) || 0), 0);
  if (spare <= 0) return 0;
  return raw > spare ? spare / raw : 1;
}
// Should a ship of the battle die all the same, it leaves no wreck: nothing of the show is loot.
function battleKillLeavesNoWreck(entity, attacker) {
  return isBattleShot(attacker, entity);
}
function deathReceipt(scene, entity) {
  const record = characters.getCharacterRecord(Number(entity?.ownerID));
  if (record?.shipID !== entity?.itemID) return null;
  return Object.values(record.authoredAirTutorial?.encounter?.combat?.deaths || {}).find(entry => entry.status === "accepted" && entry.plan.shipRecord.itemID === entity.itemID && entry.plan.shipRecord.ownerID === entity.ownerID && entry.sceneKey === scene?.sceneKey)?.plan || null;
}
module.exports = { damageMultiplier, deathReceipt, isBattleShot, battleShotScale, battleKillLeavesNoWreck, AIR_BATTLE_DAMAGE_FLOOR };
