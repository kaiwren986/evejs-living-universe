"use strict";
// Local SDE proximity-effect visuals, named by their player-facing role.
const BONUSES = Object.freeze({
  Rapidity:{typeID:92624,ship:[[37,20]]}, Masker:{typeID:92622,ship:[[552,-20]]},
  Clarifier:{typeID:92627,ship:[[564,20]]}, Energized:{typeID:92623,ship:[[482,20]]},
  Patcher:{typeID:92628,module:[[84,20,62]]}, Reflective:{typeID:92629,module:[[68,20,40]]},
  Predictive:{typeID:92625,module:[[160,20]]}, Suppressive:{typeID:92626,module:[[654,-20]]},
  "Thermal Sink":{typeID:92620,module:[[1211,-20]]},
  Overclocker:{typeID:92621,module:[[1205,20],[1210,20],[1230,20],[1231,20]]},
});
const PAIRS = [["Rapidity","Masker"],["Clarifier","Energized"],["Patcher","Reflective"],["Predictive","Suppressive"],["Thermal Sink","Overclocker"]];
const WAVES = [5,10,15,25,35,45,65,85];
function choices(wave) { return PAIRS[Math.max(0,WAVES.indexOf(wave)) % PAIRS.length]; }
function activeBonuses(entity) {
  if (!entity?.fabricatorBuffInstance) return [];
  const instance = require("../dungeon/dungeonRuntime").getInstance(entity.fabricatorBuffInstance);
  const state = instance?.spawnState?.fabricator;
  if (!state || ["failed","cashed"].includes(state.phase) || Number(entity.systemID) !== Number(instance.solarSystemID)) return [];
  const p = entity.position, q = instance.position;
  if (!p || !q || Math.hypot(p.x-q.x,p.y-q.y,p.z-q.z)>50000) return [];
  return Object.keys(state.buffs[entity.itemID] || {}).map(key=>BONUSES[key]).filter(Boolean);
}
function shipModifiers(entity) {
  return activeBonuses(entity).flatMap(b=>(b.ship || []).map(([modifiedAttributeID,value])=>({modifiedAttributeID,value,operation:6,stackingPenalized:false})));
}
function moduleSources(entity) {
  return activeBonuses(entity).flatMap(b=>(b.module || []).map(([modifiedAttributeID,value,groupID])=>({
    sourceKind:"system",sourceAttributes:{99999:value},sourceEffects:[{modifierInfo:[{
      func:"LocationModifier",domain:"shipID",modifiedAttributeID,modifyingAttributeID:99999,operation:6,
      ...(groupID ? {groupID} : {}),stackingPenalized:false,
    }]}],
  })));
}
module.exports = { BONUSES,choices,shipModifiers,moduleSources };
