"use strict";

const {
  getTypeAttributeMap, getTypeEffectRecords, appendDirectModifierEntries, applyModifierGroups,
} = require("../fitting/liveFittingState");

const SHIELD_ATTRIBUTES = Object.freeze({ em: 271, thermal: 274, kinetic: 273, explosive: 272 });
const GROUP_SHIELD_HARDENING_ARRAY = 444;
const EFFECT_SHIELD_RESONANCE_MULTIPLY_ONLINE = 105;

function isOnline(item) {
  const state = item && item.spaceState;
  return Boolean(state && state.anchorState === "anchored" && state.onlineState === "online" &&
    Number(state.online) === 1 && !require("./starbaseDefenseRuntime").hasUnavailableHealth(item));
}

function getTowerShieldAttributes(towerOrID, baseAttributes = null) {
  const { findItemById } = require("../inventory/itemStore");
  const towerID = Number(towerOrID && typeof towerOrID === "object" ? towerOrID.itemID : towerOrID);
  const tower = towerID > 0 && findItemById(towerID);
  if (!tower || Number(tower.categoryID) !== 23 || Number(tower.groupID) !== 365) return null;
  const base = baseAttributes || { ...getTypeAttributeMap(tower.typeID), ...(tower.dogmaAttributeOverrides || {}) };
  const attributes = Object.fromEntries(Object.values(SHIELD_ATTRIBUTES).map((id) => [id,
    Number.isFinite(Number(base[id])) ? Math.max(0, Number(base[id])) : 1,
  ]));
  if (!isOnline(tower)) return attributes;
  const modifiers = [];
  for (const item of require("./starbaseResourceRuntime").listTowerModules(tower)) {
    if (Number(item.groupID) !== GROUP_SHIELD_HARDENING_ARRAY || Number(item.ownerID) !== Number(tower.ownerID) || !isOnline(item)) continue;
    const effects = getTypeEffectRecords(item.typeID).filter((effect) => Number(effect.effectID) === EFFECT_SHIELD_RESONANCE_MULTIPLY_ONLINE);
    // moonmining.py:877-887 and dogma effect 105 directly multiply resonance.
    // Rebuild from base on every read; never save compounded derived values.
    appendDirectModifierEntries(modifiers, getTypeAttributeMap(item.typeID), effects,
      "starbaseHardener", { stackingPenalized: false });
  }
  applyModifierGroups(attributes, modifiers.filter((entry) => Object.values(SHIELD_ATTRIBUTES).includes(Number(entry.modifiedAttributeID))));
  return attributes;
}

function applyTowerShieldResonances(entity, baseResonances) {
  if (!entity || Number(entity.categoryID) !== 23 || Number(entity.groupID) !== 365) return baseResonances;
  const baseAttributes = Object.fromEntries(Object.entries(SHIELD_ATTRIBUTES).map(([name, id]) => [id, baseResonances[name]]));
  const attributes = getTowerShieldAttributes(entity.itemID || entity.id, baseAttributes);
  return attributes ? Object.fromEntries(Object.entries(SHIELD_ATTRIBUTES).map(([name, id]) => [name, attributes[id]])) : baseResonances;
}

module.exports = { SHIELD_ATTRIBUTES, getTowerShieldAttributes, applyTowerShieldResonances };
