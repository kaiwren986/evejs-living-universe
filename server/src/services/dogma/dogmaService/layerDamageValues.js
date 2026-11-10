"use strict";

// Layer damage values in the dogma service: GetLayerDamageValuesByItems tells the client how
// damaged the shield, armor and structure of each item it asks about are, for ships, drones and
// structures, with a zeroed answer for an item that no longer exists. These are DogmaService
// methods, moved here as they were; dogmaService.js puts them back on the class prototype, so
// `this` is the service.

const path = require("path");
const {
  normalizeShipConditionState,
  SHIP_CATEGORY_ID,
  findItemById,
} = require(path.join(__dirname, "../../inventory/itemStore"));
const {
  resolveItemByTypeID,
} = require(path.join(__dirname, "../../inventory/itemTypeRegistry"));
const {
  getTypeAttributeValue,
} = require(path.join(__dirname, "../../fitting/liveFittingState"));
const {
  extractList,
  buildList,
  buildKeyVal,
  buildMarshalReal,
  buildDict,
  unwrapMarshalValue,
} = require(path.join(__dirname, "../../_shared/serviceHelpers"));
const {
  resolveStructureEffectiveHitpoints,
} = require(path.join(__dirname, "../../structure/structureFullPowerDogma"));
const worldData = require(path.join(__dirname, "../../../space/worldData"));
const {
  clampRatio,
} = require(path.join(__dirname, "./shared"));

const DRONE_CATEGORY_ID = 18;

module.exports = {
  _extractRequestedItemIDs(rawValue) {
    const unwrapped = unwrapMarshalValue(rawValue);
    const values = Array.isArray(unwrapped) ? unwrapped : extractList(rawValue);
    return [...new Set(
      (Array.isArray(values) ? values : [])
        .map((value) => Number(value) || 0)
        .filter((itemID) => itemID > 0),
    )];
  },

  _buildItemLayerDamageValues(item) {
    if (!item || typeof item !== "object") {
      return null;
    }
    const categoryID = Number(item.categoryID) || 0;
    const rawConditionState =
      item.conditionState && typeof item.conditionState === "object"
        ? item.conditionState
        : null;
    const conditionState = rawConditionState
      ? normalizeShipConditionState(rawConditionState)
      : (
        categoryID === SHIP_CATEGORY_ID || categoryID === DRONE_CATEGORY_ID
          ? normalizeShipConditionState({})
          : {
              damage: clampRatio(item && item.moduleState && item.moduleState.damage, 0),
              charge: clampRatio(item && item.moduleState && item.moduleState.charge, 0),
              armorDamage: clampRatio(
                item && item.moduleState && item.moduleState.armorDamage,
                0,
              ),
              shieldCharge: clampRatio(
                item && item.moduleState && item.moduleState.shieldCharge,
                1,
              ),
              incapacitated: Boolean(
                item && item.moduleState && item.moduleState.incapacitated,
              ),
            }
      );
    const shieldCapacity = Number(
      item.shieldCapacity ?? getTypeAttributeValue(item.typeID, "shieldCapacity"),
    ) || 0;
    const shieldRechargeRate = Number(
      item.shieldRechargeRate ?? getTypeAttributeValue(item.typeID, "shieldRechargeRate"),
    ) || 0;
    const armorHP = Number(item.armorHP ?? getTypeAttributeValue(item.typeID, "armorHP")) || 0;
    const structureHP = Number(
      item.structureHP ?? item.hullHP ?? getTypeAttributeValue(item.typeID, "hp", "structureHP"),
    ) || 0;
    const shieldRatio =
      shieldCapacity > 0 ? clampRatio(conditionState.shieldCharge, 1) : 0;
    const armorRatio =
      armorHP > 0 ? clampRatio(1 - clampRatio(conditionState.armorDamage, 0), 1) : 0;
    const hullRatio =
      structureHP > 0 ? clampRatio(1 - clampRatio(conditionState.damage, 0), 1) : 0;
    const currentShield = shieldCapacity > 0 ? shieldCapacity * shieldRatio : 0;
    const armorDamageAmount =
      armorHP > 0 ? armorHP * clampRatio(conditionState.armorDamage, 0) : 0;
    const hullDamageAmount =
      structureHP > 0 ? structureHP * clampRatio(conditionState.damage, 0) : 0;
    const currentArmor = armorHP > 0 ? armorHP - armorDamageAmount : 0;
    const currentHull = structureHP > 0 ? structureHP - hullDamageAmount : 0;
    return buildKeyVal([
      [
        "shieldInfo",
        shieldCapacity > 0
          ? buildList([
              buildMarshalReal(currentShield, currentShield),
              buildMarshalReal(shieldCapacity, shieldCapacity),
              buildMarshalReal(Math.max(0, shieldRechargeRate), 0),
            ])
          : buildMarshalReal(0, 0),
      ],
      // Drone bay damage parity: the client reads armorInfo/hullInfo as max
      // layer values and armorDamage/hullDamage as absolute damage amounts.
      ["armorInfo", buildMarshalReal(armorHP, armorHP)],
      ["hullInfo", buildMarshalReal(structureHP, structureHP)],
      ["armorDamage", buildMarshalReal(armorDamageAmount, armorDamageAmount)],
      ["hullDamage", buildMarshalReal(hullDamageAmount, hullDamageAmount)],
      ["shieldRatio", buildMarshalReal(shieldRatio, shieldRatio)],
      ["armorRatio", buildMarshalReal(armorRatio, armorRatio)],
      ["hullRatio", buildMarshalReal(hullRatio, hullRatio)],
      ["armorMax", buildMarshalReal(armorHP, armorHP)],
      ["hullMax", buildMarshalReal(structureHP, structureHP)],
    ]);
  },

  _buildStructureLayerDamageValues(structure) {
    if (!structure || typeof structure !== "object") {
      return null;
    }
    const typeRecord = resolveItemByTypeID(structure.typeID) || {};
    const effectiveHitpoints = resolveStructureEffectiveHitpoints(structure);
    return this._buildItemLayerDamageValues({
      itemID: Number(structure.structureID) || 0,
      typeID: Number(structure.typeID) || 0,
      ownerID: Number(structure.ownerCorpID || structure.ownerID) || 0,
      locationID: Number(structure.solarSystemID) || 0,
      flagID: 0,
      groupID: Number(typeRecord.groupID) || 0,
      categoryID: Number(typeRecord.categoryID) || 0,
      conditionState: structure.conditionState,
      shieldCapacity: effectiveHitpoints.effectiveShieldCapacity,
      armorHP: effectiveHitpoints.effectiveArmorHP,
      structureHP: effectiveHitpoints.effectiveStructureHP,
    });
  },

  Handle_GetLayerDamageValuesByItems(args, session) {
    const requestedItemIDs = this._extractRequestedItemIDs(args && args[0]);
    const charID = this._getCharID(session);
    const shipID = this._getShipID(session);
    const entries = [];
    for (const itemID of requestedItemIDs) {
      // The retail client (eveDrones/droneDamageTracker.py) treats this method
      // as authoritative for every requested item: it only writes a damage-state
      // cache entry for IDs present in the response, then unconditionally clears
      // its in-flight guard. Silently dropping a requested ID therefore leaves
      // the client with the item neither cached nor in-flight, so the in-bay
      // drone UI re-issues this call every render frame (~1900/s) until the bay
      // enumeration changes — which freezes the live client. To keep the loop
      // self-terminating we must return an entry for EVERY requested item ID,
      // falling back to a zeroed payload when the item cannot be resolved
      // (e.g. a drone that just merged/relaunched and whose transient itemID no
      // longer exists server-side).
      const item = findItemById(itemID);
      let layerDamageValues = null;
      if (item) {
        const ownerID = Number(item.ownerID) || 0;
        const locationID = Number(item.locationID) || 0;
        const ownedByOther =
          charID > 0 &&
          ownerID > 0 &&
          ownerID !== charID &&
          locationID !== shipID;
        if (!ownedByOther) {
          layerDamageValues = this._buildItemLayerDamageValues(item);
        }
      } else {
        const structure = worldData.getStructureByID(itemID);
        if (structure) {
          layerDamageValues = this._buildStructureLayerDamageValues(structure);
        }
      }
      entries.push([
        itemID,
        layerDamageValues || this._buildEmptyLayerDamageValues(),
      ]);
    }
    return buildDict(entries);
  },

  _buildEmptyLayerDamageValues() {
    // Undamaged/zero-capacity sentinel for items the server cannot resolve.
    // Mirrors the shape of _buildItemLayerDamageValues so the client can read
    // every field without raising, and reports the item as fully intact rather
    // than re-requesting it forever. shieldInfo must stay list-shaped: the
    // client's ConvertDroneStateToCorrectFormat indexes shieldInfo[0..2].
    return buildKeyVal([
      [
        "shieldInfo",
        buildList([
          buildMarshalReal(0, 0),
          buildMarshalReal(0, 0),
          buildMarshalReal(0, 0),
        ]),
      ],
      ["armorInfo", buildMarshalReal(0, 0)],
      ["hullInfo", buildMarshalReal(0, 0)],
      ["armorDamage", buildMarshalReal(0, 0)],
      ["hullDamage", buildMarshalReal(0, 0)],
      ["shieldRatio", buildMarshalReal(0, 0)],
      ["armorRatio", buildMarshalReal(1, 1)],
      ["hullRatio", buildMarshalReal(1, 1)],
      ["armorMax", buildMarshalReal(0, 0)],
      ["hullMax", buildMarshalReal(0, 0)],
    ]);
  },
};
