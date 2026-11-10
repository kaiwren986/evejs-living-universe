"use strict";

const {
  toFiniteNumber,
  toInt,
} = require("../../common/numbers");

const path = require("path");

const { resolveItemByTypeID } = require(path.join(__dirname, "./itemTypeRegistry"));

const SPECIAL_SHIP_HOLD_DEFINITIONS = Object.freeze([
  {
    key: "fuel",
    flagID: 133,
    attributeNames: Object.freeze(["specialFuelBayCapacity"]),
    attributeIDs: Object.freeze([1549]),
    managedBy: "fuel",
  },
  {
    key: "generalMining",
    flagID: 134,
    attributeNames: Object.freeze(["generalMiningHoldCapacity"]),
    attributeIDs: Object.freeze([1556]),
    managedBy: "mining",
  },
  {
    key: "gas",
    flagID: 135,
    attributeNames: Object.freeze(["specialGasHoldCapacity"]),
    attributeIDs: Object.freeze([1557]),
    managedBy: "mining",
  },
  {
    key: "mineral",
    flagID: 136,
    attributeNames: Object.freeze(["specialMineralHoldCapacity"]),
    attributeIDs: Object.freeze([1558]),
    accepts: "mineral",
  },
  {
    key: "salvage",
    flagID: 137,
    attributeNames: Object.freeze(["specialSalvageHoldCapacity"]),
    attributeIDs: Object.freeze([1559]),
    accepts: "salvage",
  },
  {
    key: "ship",
    flagID: 138,
    attributeNames: Object.freeze(["specialShipHoldCapacity"]),
    attributeIDs: Object.freeze([1560]),
    accepts: "ship",
  },
  {
    key: "smallShip",
    flagID: 139,
    attributeNames: Object.freeze(["specialSmallShipHoldCapacity"]),
    attributeIDs: Object.freeze([1561]),
    accepts: "smallShip",
  },
  {
    key: "mediumShip",
    flagID: 140,
    attributeNames: Object.freeze(["specialMediumShipHoldCapacity"]),
    attributeIDs: Object.freeze([1562]),
    accepts: "mediumShip",
  },
  {
    key: "largeShip",
    flagID: 141,
    attributeNames: Object.freeze(["specialLargeShipHoldCapacity"]),
    attributeIDs: Object.freeze([1563]),
    accepts: "largeShip",
  },
  {
    key: "industrialShip",
    flagID: 142,
    attributeNames: Object.freeze(["specialIndustrialShipHoldCapacity"]),
    attributeIDs: Object.freeze([1564]),
    accepts: "industrialShip",
  },
  {
    key: "ammo",
    flagID: 143,
    attributeNames: Object.freeze(["specialAmmoHoldCapacity"]),
    attributeIDs: Object.freeze([1573]),
    accepts: "ammo",
  },
  {
    key: "commandCenter",
    flagID: 148,
    attributeNames: Object.freeze(["specialCommandCenterHoldCapacity"]),
    attributeIDs: Object.freeze([1646]),
    accepts: "commandCenter",
  },
  {
    key: "planetaryCommodities",
    flagID: 149,
    attributeNames: Object.freeze(["specialPlanetaryCommoditiesHoldCapacity"]),
    attributeIDs: Object.freeze([1653]),
    accepts: "planetaryCommodities",
  },
  {
    key: "material",
    flagID: 151,
    attributeNames: Object.freeze(["specialMaterialBayCapacity"]),
    attributeIDs: Object.freeze([1770]),
    accepts: "material",
  },
  {
    key: "quafe",
    flagID: 154,
    attributeNames: Object.freeze(["specialQuafeHoldCapacity"]),
    attributeIDs: Object.freeze([1804]),
    accepts: "quafe",
  },
  {
    key: "corpse",
    flagID: 174,
    attributeNames: Object.freeze(["specialCorpseHoldCapacity"]),
    attributeIDs: Object.freeze([2467]),
    accepts: "corpse",
  },
  {
    key: "booster",
    flagID: 176,
    attributeNames: Object.freeze(["specialBoosterHoldCapacity"]),
    attributeIDs: Object.freeze([2657]),
    accepts: "booster",
  },
  {
    key: "subsystem",
    flagID: 177,
    attributeNames: Object.freeze(["specialSubsystemHoldCapacity"]),
    attributeIDs: Object.freeze([2675]),
    accepts: "subsystem",
  },
  {
    key: "frigateEscape",
    flagID: 179,
    attributeNames: Object.freeze(["frigateEscapeBayCapacity"]),
    attributeIDs: Object.freeze([3020]),
    accepts: "frigateEscape",
  },
  {
    key: "ice",
    flagID: 181,
    attributeNames: Object.freeze(["specialIceHoldCapacity"]),
    attributeIDs: Object.freeze([3136]),
    managedBy: "mining",
  },
  {
    key: "asteroid",
    flagID: 182,
    attributeNames: Object.freeze(["specialAsteroidHoldCapacity"]),
    attributeIDs: Object.freeze([3227]),
    managedBy: "mining",
  },
  {
    key: "mobileDepot",
    flagID: 183,
    attributeNames: Object.freeze(["specialMobileDepotHoldCapacity"]),
    attributeIDs: Object.freeze([5325]),
    managedBy: "mobileDepot",
  },
  {
    key: "infrastructure",
    flagID: 185,
    attributeNames: Object.freeze(["specialColonyResourcesHoldCapacity"]),
    attributeIDs: Object.freeze([5646]),
    accepts: "infrastructure",
  },
  {
    key: "expedition",
    flagID: 188,
    attributeNames: Object.freeze(["specialExpeditionHoldCapacity"]),
    attributeIDs: Object.freeze([5944]),
    accepts: "expedition",
  },
]);

const definitionsByFlag = new Map(
  SPECIAL_SHIP_HOLD_DEFINITIONS.map((definition) => [
    definition.flagID,
    definition,
  ]),
);

const SPECIAL_SHIP_HOLD_FLAGS = Object.freeze(
  SPECIAL_SHIP_HOLD_DEFINITIONS.map((definition) => definition.flagID),
);

const GENERIC_SPECIAL_SHIP_HOLD_FLAGS = Object.freeze(
  SPECIAL_SHIP_HOLD_DEFINITIONS
    .filter((definition) => !definition.managedBy)
    .map((definition) => definition.flagID),
);

function resolveTypeRecord(itemOrTypeID) {
  if (!itemOrTypeID) {
    return null;
  }

  if (typeof itemOrTypeID === "object") {
    const typeID = toInt(itemOrTypeID.typeID || itemOrTypeID.itemTypeID, 0);
    const resolvedType = typeID > 0 ? resolveItemByTypeID(typeID) : null;
    return resolvedType
      ? { ...resolvedType, ...itemOrTypeID }
      : itemOrTypeID;
  }

  const typeID = toInt(itemOrTypeID, 0);
  return typeID > 0 ? resolveItemByTypeID(typeID) : null;
}

function categoryID(typeRecord) {
  return toInt(typeRecord && typeRecord.categoryID, 0);
}

function groupID(typeRecord) {
  return toInt(typeRecord && typeRecord.groupID, 0);
}

const INFRASTRUCTURE_HOLD_ALLOWED_CATEGORY_IDS = Object.freeze(new Set([
  22, // Deployable
  39, // Infrastructure Upgrades
  40, // Sovereignty Structure
  42, // Planetary Resources
  43, // Planetary Commodities
  46, // Orbital
  65, // Structure
  66, // Structure Module
]));

const INFRASTRUCTURE_HOLD_ALLOWED_GROUP_IDS = Object.freeze(new Set([
  423, // Ice Product
  427, // Moon Materials
  1027, // Command Pins
  1136, // Fuel Block
  1546, // Structure Missile
  1547, // Structure Flak Missile
  1548, // Structure Area Missile
  1549, // Structure ECM Script
  1551, // Structure Warp Disruptor Script
  4186, // Structure Area Denial Ammunition
  4729, // Colony Reagents
  4777, // Structure Light Fighter
  4778, // Structure Support Fighter
  4779, // Structure Heavy Fighter
]));

const INFRASTRUCTURE_HOLD_ALLOWED_TYPE_IDS = Object.freeze(new Set([
  3645, // Water
  3683, // Oxygen
]));

// V24.01 tools/ClientCodeGrabber/Latest/eve/common/script/util/
// inventoryFlagsCommon.py:121-392 is the client-side authority for these
// whitelists. Keep IDs explicit so similarly named groups and items do not leak
// into a specialized hold.
const SMALL_SHIP_HOLD_ALLOWED_GROUP_IDS = Object.freeze(new Set([
  25,   // Frigate
  324,  // Assault Frigate
  420,  // Destroyer
  541,  // Interdictor
  830,  // Covert Ops
  831,  // Interceptor
  834,  // Stealth Bomber
  893,  // Electronic Attack Ship
  1283, // Expedition Frigate
  1305, // Tactical Destroyer
  1527, // Logistics Frigate
  1534, // Command Destroyer
]));

const MEDIUM_SHIP_HOLD_ALLOWED_GROUP_IDS = Object.freeze(new Set([
  26,   // Cruiser
  358,  // Heavy Assault Cruiser
  419,  // Battlecruiser
  540,  // Command Ship
  832,  // Logistics
  833,  // Force Recon Ship
  894,  // Heavy Interdiction Cruiser
  906,  // Combat Recon Ship
  963,  // Strategic Cruiser
  1201, // Attack Battlecruiser
  1972, // Flag Cruiser
  4902, // Expedition Command Ship
  5087, // Special Edition Yacht
]));

const LARGE_SHIP_HOLD_ALLOWED_GROUP_IDS = Object.freeze(new Set([
  27,  // Battleship
  898, // Black Ops
  900, // Marauder
]));

const INDUSTRIAL_SHIP_HOLD_ALLOWED_GROUP_IDS = Object.freeze(new Set([
  28,   // Industrial
  380,  // Transport Ship
  463,  // Mining Barge
  543,  // Exhumer
  1202, // Blockade Runner
  1283, // Expedition Frigate
]));

const EXPEDITION_HOLD_ALLOWED_CATEGORY_IDS = Object.freeze(new Set([
  9,    // Blueprint
  16,   // Skill
  17,   // Commodity
  22,   // Deployable
  30,   // Apparel
  34,   // Ancient Relic
  63,   // Special Edition Assets
  91,   // Ship Skin
  2118, // Personalization
]));

const EXPEDITION_HOLD_ALLOWED_GROUP_IDS = Object.freeze(new Set([
  87,   // Capacitor Booster Charge
  303,  // Booster
  355,  // Refinables
  479,  // Scanner Probe
  492,  // Survey Probe
  500,  // Festival Missile
  711,  // Harvestable Cloud
  754,  // Salvaged Materials
  886,  // Rogue Drone Components (client constant retains the historic typo)
  966,  // Ancient Salvage
  1304, // Decryptors
  1676, // Named Components
  1769, // Shield Command Burst Charge
  1771, // Mining Command Burst Charge
  1772, // Skirmish Command Burst Charge
  1773, // Information Command Burst Charge
  1774, // Armor Command Burst Charge
  1976, // Structure Festival Missile
  4168, // Compressed Gas
  4905, // Expedition Command Burst Charge
]));

const QUAFE_HOLD_ALLOWED_TYPE_IDS = Object.freeze(new Set([
  3699, 3898, 4090, 12865, 12994, 21661, 57422,
]));
const CORPSE_HOLD_ALLOWED_TYPE_IDS = Object.freeze(new Set([25, 29148]));
const BOOSTER_HOLD_ALLOWED_GROUP_IDS = Object.freeze(new Set([303, 313, 712]));
const PLANETARY_HOLD_ALLOWED_TYPE_IDS = Object.freeze(new Set([3645, 3683]));
const SALVAGE_HOLD_ALLOWED_GROUP_IDS = Object.freeze(new Set([355, 754, 966]));
const MATERIAL_HOLD_ALLOWED_CATEGORY_IDS = Object.freeze(new Set([4, 17, 43]));
const FRIGATE_ESCAPE_BAY_ALLOWED_GROUP_IDS = Object.freeze(new Set([
  25, 324, 893, 1527,
]));
const NANITE_REPAIR_PASTE_TYPE_ID = 28668;

const SPECIAL_HOLD_RESTRICTION_MESSAGES = Object.freeze({
  mineral: "Only minerals can be placed in the Mineral Hold.",
  salvage: "Only salvage materials can be placed in the Salvage Hold.",
  ship: "Only ships can be placed in the Ship Hold.",
  smallShip: "Only eligible frigate- and destroyer-class ships can be placed in the Small Ship Hold.",
  mediumShip: "Only eligible cruiser- and battlecruiser-class ships can be placed in the Medium Ship Hold.",
  largeShip: "Only eligible battleship-class ships can be placed in the Large Ship Hold.",
  industrialShip: "Only eligible industrial and mining ships can be placed in the Industrial Ship Hold.",
  ammo: "Only charges and Nanite Repair Paste can be placed in the Ammunition Hold.",
  commandCenter: "Only planetary command centers can be placed in the Command Center Hold.",
  planetaryCommodities: "Only planetary resources and commodities can be placed in the Planetary Commodities Hold.",
  material: "Only commodities and materials can be placed in the Material Bay.",
  quafe: "Only supported Quafe products can be placed in the Quafe Bay.",
  corpse: "Only corpses can be placed in the Corpse Bay.",
  booster: "Only boosters, drugs, and biochemical materials can be placed in the Booster Bay.",
  subsystem: "Only ship subsystems can be placed in the Subsystem Bay.",
  frigateEscape: "Only eligible frigate-class ships can be placed in the Frigate Escape Bay.",
  infrastructure: "Only infrastructure resources can be placed in the Infrastructure Hold.",
  expedition: "Only eligible expedition supplies can be placed in the Expedition Hold.",
});

function getSpecialShipHoldDefinition(flagID) {
  return definitionsByFlag.get(toInt(flagID, 0)) || null;
}

function isSpecialShipHoldFlag(flagID) {
  return definitionsByFlag.has(toInt(flagID, 0));
}

function isGenericSpecialShipHoldFlag(flagID) {
  const definition = getSpecialShipHoldDefinition(flagID);
  return Boolean(definition && !definition.managedBy);
}

function isSpecialShipHoldItemAllowed(itemOrTypeID, flagID) {
  const definition = getSpecialShipHoldDefinition(flagID);
  if (!definition || definition.managedBy) {
    return null;
  }

  const typeRecord = resolveTypeRecord(itemOrTypeID);
  if (!typeRecord) {
    return false;
  }

  const numericTypeID = toInt(typeRecord.typeID || typeRecord.itemTypeID, 0);
  switch (definition.key) {
    case "mineral":
      return groupID(typeRecord) === 18 || groupID(typeRecord) === 4932;
    case "salvage":
      return SALVAGE_HOLD_ALLOWED_GROUP_IDS.has(groupID(typeRecord));
    case "ship":
      return categoryID(typeRecord) === 6;
    case "smallShip":
      return SMALL_SHIP_HOLD_ALLOWED_GROUP_IDS.has(groupID(typeRecord));
    case "mediumShip":
      return MEDIUM_SHIP_HOLD_ALLOWED_GROUP_IDS.has(groupID(typeRecord));
    case "largeShip":
      return LARGE_SHIP_HOLD_ALLOWED_GROUP_IDS.has(groupID(typeRecord));
    case "industrialShip":
      return INDUSTRIAL_SHIP_HOLD_ALLOWED_GROUP_IDS.has(groupID(typeRecord));
    case "ammo":
      return categoryID(typeRecord) === 8 || numericTypeID === NANITE_REPAIR_PASTE_TYPE_ID;
    case "commandCenter":
      return groupID(typeRecord) === 1027;
    case "planetaryCommodities":
      return (
        categoryID(typeRecord) === 42 ||
        categoryID(typeRecord) === 43 ||
        PLANETARY_HOLD_ALLOWED_TYPE_IDS.has(numericTypeID)
      );
    case "material":
      return MATERIAL_HOLD_ALLOWED_CATEGORY_IDS.has(categoryID(typeRecord));
    case "quafe":
      return QUAFE_HOLD_ALLOWED_TYPE_IDS.has(numericTypeID);
    case "corpse":
      return CORPSE_HOLD_ALLOWED_TYPE_IDS.has(numericTypeID);
    case "booster":
      return BOOSTER_HOLD_ALLOWED_GROUP_IDS.has(groupID(typeRecord));
    case "subsystem":
      return categoryID(typeRecord) === 32;
    case "frigateEscape":
      return FRIGATE_ESCAPE_BAY_ALLOWED_GROUP_IDS.has(groupID(typeRecord));
    case "infrastructure":
      return (
        INFRASTRUCTURE_HOLD_ALLOWED_CATEGORY_IDS.has(categoryID(typeRecord)) ||
        INFRASTRUCTURE_HOLD_ALLOWED_GROUP_IDS.has(groupID(typeRecord)) ||
        INFRASTRUCTURE_HOLD_ALLOWED_TYPE_IDS.has(numericTypeID)
      );
    case "expedition":
      return (
        EXPEDITION_HOLD_ALLOWED_CATEGORY_IDS.has(categoryID(typeRecord)) ||
        EXPEDITION_HOLD_ALLOWED_GROUP_IDS.has(groupID(typeRecord)) ||
        numericTypeID === NANITE_REPAIR_PASTE_TYPE_ID
      );
    default:
      return true;
  }
}

function getSpecialShipHoldRestrictionMessage(flagID) {
  const definition = getSpecialShipHoldDefinition(flagID);
  return definition
    ? SPECIAL_HOLD_RESTRICTION_MESSAGES[definition.key] ||
      "That item cannot be placed in this specialized hold."
    : "That item cannot be placed in this specialized hold.";
}

function getSpecialShipHoldCapacity(
  resourceState,
  shipTypeID,
  flagID,
  getBaseAttributeValue = null,
) {
  const definition = getSpecialShipHoldDefinition(flagID);
  if (!definition) {
    return 0;
  }

  const attributes =
    resourceState && resourceState.attributes && typeof resourceState.attributes === "object"
      ? resourceState.attributes
      : null;
  if (attributes) {
    for (const attributeID of definition.attributeIDs || []) {
      const value = toFiniteNumber(
        attributes[attributeID] ?? attributes[String(attributeID)],
        NaN,
      );
      if (Number.isFinite(value)) {
        return value;
      }
    }
  }

  if (typeof getBaseAttributeValue === "function") {
    return toFiniteNumber(
      getBaseAttributeValue(shipTypeID, ...(definition.attributeNames || [])),
      0,
    );
  }

  return 0;
}

module.exports = {
  SPECIAL_SHIP_HOLD_DEFINITIONS,
  SPECIAL_SHIP_HOLD_FLAGS,
  GENERIC_SPECIAL_SHIP_HOLD_FLAGS,
  getSpecialShipHoldDefinition,
  isSpecialShipHoldFlag,
  isGenericSpecialShipHoldFlag,
  isSpecialShipHoldItemAllowed,
  getSpecialShipHoldRestrictionMessage,
  getSpecialShipHoldCapacity,
};
