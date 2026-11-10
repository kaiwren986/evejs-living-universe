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
function deathReceipt(scene, entity) {
  const record = characters.getCharacterRecord(Number(entity?.ownerID));
  if (record?.shipID !== entity?.itemID) return null;
  return Object.values(record.authoredAirTutorial?.encounter?.combat?.deaths || {}).find(entry => entry.status === "accepted" && entry.plan.shipRecord.itemID === entity.itemID && entry.plan.shipRecord.ownerID === entity.ownerID && entry.sceneKey === scene?.sceneKey)?.plan || null;
}
module.exports = { damageMultiplier, deathReceipt };
