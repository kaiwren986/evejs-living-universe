"use strict";

const {
  toNumber,
} = require("../../common/numbers");

const path = require("path");

const log = require(path.join(__dirname, "../../utils/logger"));
const worldData = require(path.join(__dirname, "../../space/worldData"));
const {
  ITEM_FLAGS,
  listContainerItems,
} = require(path.join(__dirname, "../inventory/itemStore"));
const {
  resolveItemByTypeID,
} = require(path.join(__dirname, "../inventory/itemTypeRegistry"));
const {
  prepareContrabandPenalty,
  settleContrabandPenalty,
} = require("./contrabandPenaltyState");
const {
  applyDogmaModifierGroups,
  getActiveImplantCharacterModifierEntries,
} = require(path.join(__dirname, "../dogma/implants/activeImplantModifiers"));

const ATTRIBUTE_SMUGGLING_MODIFIER = 445;
const UNDOCK_CONTRABAND_WARNING_MESSAGE_ID = "ShipContrabandWarningUndock";
// eveexceptions.const.UE_TYPEID
const USER_ERROR_TYPE_ID = 4;

const CONTRABAND_TYPE_RULES = Object.freeze([
  {
    typeID: 3713,
    factions: [
      { factionID: 500005, attackMinSec: 1.1, confiscateMinSec: 0.4, fineByValue: 4.5, standingLoss: 0.2 },
      { factionID: 500017, attackMinSec: 1.1, confiscateMinSec: 0.5, fineByValue: 1.5, standingLoss: 0.05 },
    ],
  },
  {
    typeID: 3721,
    factions: [
      { factionID: 500001, attackMinSec: 1.1, confiscateMinSec: -1.0, fineByValue: 5.0, standingLoss: 0.2 },
      { factionID: 500002, attackMinSec: 1.1, confiscateMinSec: -1.0, fineByValue: 10.0, standingLoss: 0.5 },
      { factionID: 500004, attackMinSec: 1.1, confiscateMinSec: -1.0, fineByValue: 8.0, standingLoss: 0.3 },
      { factionID: 500005, attackMinSec: 1.1, confiscateMinSec: -1.0, fineByValue: 5.0, standingLoss: 0.2 },
      { factionID: 500006, attackMinSec: 1.1, confiscateMinSec: -1.0, fineByValue: 8.0, standingLoss: 0.0 },
      { factionID: 500009, attackMinSec: 1.1, confiscateMinSec: -1.0, fineByValue: 4.0, standingLoss: 0.15 },
      { factionID: 500014, attackMinSec: 1.1, confiscateMinSec: -1.0, fineByValue: 5.0, standingLoss: 0.2 },
      { factionID: 500015, attackMinSec: 1.1, confiscateMinSec: -1.0, fineByValue: 9.0, standingLoss: 0.4 },
      { factionID: 500016, attackMinSec: 1.1, confiscateMinSec: -1.0, fineByValue: 6.0, standingLoss: 0.3 },
      { factionID: 500017, attackMinSec: 1.1, confiscateMinSec: -1.0, fineByValue: 8.0, standingLoss: 0.3 },
      { factionID: 500018, attackMinSec: 1.1, confiscateMinSec: -1.0, fineByValue: 5.0, standingLoss: 0.2 },
    ],
  },
  {
    typeID: 3727,
    factions: [
      { factionID: 500003, attackMinSec: 1.1, confiscateMinSec: 0.6, fineByValue: 1.2, standingLoss: 0.05 },
      { factionID: 500005, attackMinSec: 1.1, confiscateMinSec: 0.5, fineByValue: 3.0, standingLoss: 0.1 },
      { factionID: 500007, attackMinSec: 1.1, confiscateMinSec: 0.6, fineByValue: 1.2, standingLoss: 0.05 },
      { factionID: 500008, attackMinSec: 1.1, confiscateMinSec: 0.5, fineByValue: 1.2, standingLoss: 0.05 },
      { factionID: 500017, attackMinSec: 1.1, confiscateMinSec: 0.4, fineByValue: 2.0, standingLoss: 0.05 },
    ],
  },
  {
    typeID: 3729,
    factions: [
      { factionID: 500001, attackMinSec: 1.1, confiscateMinSec: 0.4, fineByValue: 2.0, standingLoss: 0.1 },
      { factionID: 500002, attackMinSec: 1.1, confiscateMinSec: 0.8, fineByValue: 1.1, standingLoss: 0.05 },
      { factionID: 500004, attackMinSec: 1.1, confiscateMinSec: 0.4, fineByValue: 2.5, standingLoss: 0.15 },
      { factionID: 500005, attackMinSec: 1.1, confiscateMinSec: 0.7, fineByValue: 2.0, standingLoss: 0.05 },
      { factionID: 500006, attackMinSec: 1.1, confiscateMinSec: 0.4, fineByValue: 2.5, standingLoss: 0.0 },
      { factionID: 500009, attackMinSec: 1.1, confiscateMinSec: 0.2, fineByValue: 1.5, standingLoss: 0.05 },
      { factionID: 500014, attackMinSec: 1.1, confiscateMinSec: 1.1, fineByValue: 1.2, standingLoss: 0.05 },
      { factionID: 500015, attackMinSec: 1.1, confiscateMinSec: -1.0, fineByValue: 1.1, standingLoss: 0.05 },
      { factionID: 500016, attackMinSec: 1.1, confiscateMinSec: -1.0, fineByValue: 2.0, standingLoss: 0.1 },
      { factionID: 500017, attackMinSec: 1.1, confiscateMinSec: -1.0, fineByValue: 2.5, standingLoss: 0.15 },
      { factionID: 500018, attackMinSec: 1.1, confiscateMinSec: -1.0, fineByValue: 2.0, standingLoss: 0.05 },
    ],
  },
  {
    typeID: 9844,
    factions: [
      { factionID: 500001, attackMinSec: 1.1, confiscateMinSec: -1.0, fineByValue: 5.0, standingLoss: 0.2 },
      { factionID: 500003, attackMinSec: 1.1, confiscateMinSec: 0.5, fineByValue: 3.0, standingLoss: 0.1 },
      { factionID: 500007, attackMinSec: 1.1, confiscateMinSec: 0.6, fineByValue: 1.5, standingLoss: 0.05 },
      { factionID: 500008, attackMinSec: 1.1, confiscateMinSec: 0.3, fineByValue: 4.0, standingLoss: 0.15 },
      { factionID: 500014, attackMinSec: 1.1, confiscateMinSec: 0.4, fineByValue: 1.1, standingLoss: 0.05 },
      { factionID: 500018, attackMinSec: 1.1, confiscateMinSec: -1.0, fineByValue: 3.0, standingLoss: 0.1 },
    ],
  },
  {
    typeID: 11855,
    factions: [
      { factionID: 500004, attackMinSec: 1.1, confiscateMinSec: 0.8, fineByValue: 1.2, standingLoss: 0.05 },
      { factionID: 500009, attackMinSec: 1.1, confiscateMinSec: 0.3, fineByValue: 1.2, standingLoss: 0.05 },
      { factionID: 500014, attackMinSec: 1.1, confiscateMinSec: 0.2, fineByValue: 1.2, standingLoss: 0.05 },
      { factionID: 500016, attackMinSec: 1.1, confiscateMinSec: -1.0, fineByValue: 1.2, standingLoss: 0.05 },
    ],
  },
  {
    typeID: 12478,
    factions: [
      { factionID: 500003, attackMinSec: 1.1, confiscateMinSec: -1.0, fineByValue: 10.0, standingLoss: 0.3 },
      { factionID: 500007, attackMinSec: 1.1, confiscateMinSec: -1.0, fineByValue: 10.0, standingLoss: 0.4 },
      { factionID: 500008, attackMinSec: 1.1, confiscateMinSec: -1.0, fineByValue: 7.0, standingLoss: 0.2 },
    ],
  },
  {
    typeID: 17796,
    factions: [
      { factionID: 500001, attackMinSec: 1.1, confiscateMinSec: 1.0, fineByValue: 0.0, standingLoss: 0.0 },
      { factionID: 500002, attackMinSec: 1.1, confiscateMinSec: 1.0, fineByValue: 0.0, standingLoss: 0.0 },
      { factionID: 500004, attackMinSec: 1.1, confiscateMinSec: 1.0, fineByValue: 0.0, standingLoss: 0.0 },
      { factionID: 500006, attackMinSec: 1.1, confiscateMinSec: 1.0, fineByValue: 0.0, standingLoss: 0.0 },
      { factionID: 500013, attackMinSec: 1.1, confiscateMinSec: 1.0, fineByValue: 0.0, standingLoss: 0.0 },
      { factionID: 500014, attackMinSec: 1.1, confiscateMinSec: 1.0, fineByValue: 0.0, standingLoss: 0.0 },
      { factionID: 500016, attackMinSec: 1.1, confiscateMinSec: 1.0, fineByValue: 0.0, standingLoss: 0.0 },
      { factionID: 500017, attackMinSec: 1.1, confiscateMinSec: 1.0, fineByValue: 0.0, standingLoss: 0.0 },
    ],
  },
]);

let rulesByTypeID = null;

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function roundMoney(value) {
  return Math.round(toNumber(value, 0) * 100) / 100;
}

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function getRuleMap() {
  if (rulesByTypeID) {
    return rulesByTypeID;
  }

  rulesByTypeID = new Map();
  for (const row of CONTRABAND_TYPE_RULES) {
    const typeID = toInt(row && row.typeID, 0);
    if (typeID <= 0) {
      continue;
    }
    const factions = new Map();
    for (const factionRule of Array.isArray(row.factions) ? row.factions : []) {
      const factionID = toInt(factionRule && factionRule.factionID, 0);
      if (factionID > 0) {
        factions.set(factionID, { ...factionRule, factionID });
      }
    }
    rulesByTypeID.set(typeID, {
      typeID,
      factions,
    });
  }
  return rulesByTypeID;
}

function getContrabandRuleForFaction(typeID, factionID) {
  const typeRule = getRuleMap().get(toInt(typeID, 0));
  if (!typeRule) {
    return null;
  }
  return typeRule.factions.get(toInt(factionID, 0)) || null;
}

function resolveCharacterSmugglingChance(characterID) {
  const attributes = {
    [ATTRIBUTE_SMUGGLING_MODIFIER]: 0,
  };
  applyDogmaModifierGroups(
    attributes,
    getActiveImplantCharacterModifierEntries(characterID).filter((entry) =>
      toInt(entry && entry.modifiedAttributeID, 0) === ATTRIBUTE_SMUGGLING_MODIFIER,
    ),
  );
  return Math.max(0, Math.min(1, toNumber(attributes[ATTRIBUTE_SMUGGLING_MODIFIER], 0)));
}

function getSystemInspectionAuthority(solarSystemID) {
  const system = worldData.getSolarSystemByID(solarSystemID);
  const factionID = toInt(system && system.factionID, 0);
  const security = toNumber(
    system && (
      system.security ??
      system.securityStatus
    ),
    NaN,
  );
  if (!system || factionID <= 0 || !Number.isFinite(security)) {
    return null;
  }
  return {
    solarSystemID: toInt(system.solarSystemID ?? solarSystemID, 0),
    solarSystemName: String(system.solarSystemName || ""),
    factionID,
    security,
  };
}

function getItemQuantity(item) {
  const stackSize = toInt(item && item.stacksize, 0);
  if (stackSize > 0) {
    return stackSize;
  }
  const quantity = toInt(item && item.quantity, 0);
  return quantity > 0 ? quantity : 1;
}

function getItemBasePrice(typeID) {
  const typeRecord = resolveItemByTypeID(typeID);
  return Math.max(0, toNumber(typeRecord && typeRecord.basePrice, 0));
}

function listCargoItems(characterID, shipID) {
  const ownedCargo = listContainerItems(
    characterID,
    shipID,
    ITEM_FLAGS.CARGO_HOLD,
  );
  if (ownedCargo.length > 0) {
    return ownedCargo;
  }
  return listContainerItems(null, shipID, ITEM_FLAGS.CARGO_HOLD);
}

function buildContrabandEntries(characterID, shipID, authority, options = {}) {
  if (!authority) {
    return [];
  }

  const entries = [];
  const seenItemIDs = new Set();
  const visibleHolds = new Set([
    ITEM_FLAGS.CARGO_HOLD, ITEM_FLAGS.FLEET_HANGAR, ITEM_FLAGS.FUEL_BAY,
    ITEM_FLAGS.BOOSTER_BAY, ITEM_FLAGS.GENERAL_MINING_HOLD,
    ITEM_FLAGS.SPECIALIZED_MINERAL_HOLD, ITEM_FLAGS.SPECIALIZED_SALVAGE_HOLD,
    ITEM_FLAGS.SPECIALIZED_AMMO_HOLD, ITEM_FLAGS.SPECIALIZED_COMMAND_CENTER_HOLD,
    ITEM_FLAGS.SPECIALIZED_PLANETARY_COMMODITIES_HOLD, ITEM_FLAGS.SPECIALIZED_MATERIAL_BAY,
    ITEM_FLAGS.QUAFE_BAY, ITEM_FLAGS.SPECIALIZED_GAS_HOLD, ITEM_FLAGS.SPECIALIZED_ICE_HOLD,
    ITEM_FLAGS.SPECIALIZED_ASTEROID_HOLD, ITEM_FLAGS.EXPEDITION_HOLD,
  ]);
  const cargo = options.allCargoHolds === true
    ? listContainerItems(characterID, shipID).filter((item) => visibleHolds.has(Number(item.flagID)))
    : listCargoItems(characterID, shipID);
  for (const item of cargo) {
    const itemID = toInt(item && item.itemID, 0);
    const typeID = toInt(item && item.typeID, 0);
    if (itemID <= 0 || typeID <= 0 || seenItemIDs.has(itemID)) {
      continue;
    }
    seenItemIDs.add(itemID);

    const rule = options.allCargoHolds === true && Array.isArray(authority.laws)
      ? authority.laws.find((law) => law.typeID === typeID && law.factionID === authority.factionID)
      : getContrabandRuleForFaction(typeID, authority.factionID);
    if (!rule) {
      continue;
    }
    const confiscateMinSec = toNumber(rule.confiscateMinSec, 1.1);
    if (authority.security < confiscateMinSec) {
      continue;
    }

    const quantity = getItemQuantity(item);
    const basePrice = Number.isFinite(rule.basePrice) ? rule.basePrice : getItemBasePrice(typeID);
    const fine = roundMoney(quantity * basePrice * Math.max(0, toNumber(rule.fineByValue, 0)));
    entries.push({
      item: cloneValue(item),
      itemID,
      typeID,
      quantity,
      basePrice,
      fineByValue: toNumber(rule.fineByValue, 0),
      fine,
      standingLoss: Math.max(0, toNumber(rule.standingLoss, 0)),
      confiscateMinSec,
      attackMinSec: toNumber(rule.attackMinSec, 1.1),
    });
  }

  return entries;
}

// The system's law and the cargo aboard it acts on. The inspection and the
// undock warning both read this one place, so the warning is raised for
// exactly the cargo an inspection would act on.
function findActionableContraband(characterID, shipID, solarSystemID) {
  const authority = getSystemInspectionAuthority(solarSystemID);
  return {
    authority,
    contraband: authority
      ? buildContrabandEntries(characterID, shipID, authority)
      : [],
  };
}

// What an inspection of this ship in this system would act on, without
// rolling for evasion and without preparing or applying any penalty.
function previewCharacterContraband(characterID, shipID, solarSystemID) {
  const normalizedCharacterID = toInt(characterID, 0);
  const normalizedShipID = toInt(shipID, 0);
  if (normalizedCharacterID <= 0 || normalizedShipID <= 0) {
    return { authority: null, contraband: [] };
  }
  return findActionableContraband(
    normalizedCharacterID,
    normalizedShipID,
    solarSystemID,
  );
}

// UserError arguments for the client's ShipContrabandWarningUndock dialog,
// which base.py _DoUndockAttempt and structureDocking.py Undock answer by
// calling Undock again with ignoreContraband set. The dialog's text (dialog
// 1552, body message 258952 in the 3396210 client's static data) is "Your ship
// is carrying at least one item ({item}) which is contraband somewhere. Are
// you sure you wish to undock?": one parameter, `item`. The client's
// eveCfg.__prepdict turns the tuple (UE_TYPEID, typeID) into the type's name;
// JS arrays marshal as tuples. Which item retail names is not known; this
// names the first one the inspection would act on.
function buildUndockContrabandWarningArguments(contraband) {
  const entries = Array.isArray(contraband) ? contraband : [];
  return [
    UNDOCK_CONTRABAND_WARNING_MESSAGE_ID,
    { item: [USER_ERROR_TYPE_ID, toInt(entries[0] && entries[0].typeID, 0)] },
  ];
}

function getInspectionRoll(options = {}) {
  const explicitRoll = toNumber(
    options.roll ??
      options.detectionRoll,
    NaN,
  );
  if (Number.isFinite(explicitRoll)) {
    return Math.max(0, Math.min(1, explicitRoll));
  }
  const random = typeof options.random === "function" ? options.random : Math.random;
  return Math.max(0, Math.min(1, toNumber(random(), 1)));
}

function applyContrabandPenalties(characterID, authority, entries, options = {}) {
  const totalFine = roundMoney(entries.reduce((sum, entry) => sum + entry.fine, 0));
  const standingLoss = entries.reduce(
    (sum, entry) => sum + Math.max(0, toNumber(entry.standingLoss, 0)),
    0,
  );
  const prepared = prepareContrabandPenalty({
    characterID,
    shipID: toInt(
      options.shipID,
      entries[0] && entries[0].item && entries[0].item.locationID,
    ),
    authority,
    entries,
    totalFine,
    standingLoss,
    disableDerivedStandings: options.disableDerivedStandings,
  });
  if (!prepared || prepared.success !== true) {
    return prepared || { success: false, errorMsg: "PENALTY_PREPARE_FAILED" };
  }
  if (options.deferPenalties === true) {
    return {
      success: true,
      data: {
        operationID: prepared.data.operationID,
        pending: true,
        removedItems: [],
        removedChanges: [],
        removalErrors: [],
        walletResult: null,
        standingResult: null,
        totalFine,
        chargedFine: prepared.data.predictedChargedFine,
        unpaidFine: roundMoney(
          totalFine - prepared.data.predictedChargedFine,
        ),
        standingLoss,
      },
    };
  }
  return settleContrabandPenalty(prepared.data.operationID);
}

function inspectCharacterContraband(characterID, shipID, solarSystemID, options = {}) {
  const normalizedCharacterID = toInt(characterID, 0);
  const normalizedShipID = toInt(shipID, 0);
  if (normalizedCharacterID <= 0 || normalizedShipID <= 0) {
    return {
      success: false,
      errorMsg: "SHIP_REQUIRED",
    };
  }

  const { authority, contraband } = findActionableContraband(
    normalizedCharacterID,
    normalizedShipID,
    solarSystemID,
  );
  if (!authority) {
    return {
      success: true,
      data: {
        inspected: false,
        detected: false,
        evaded: false,
        reason: "NO_FACTION_AUTHORITY",
        contraband: [],
      },
    };
  }

  if (!contraband.length) {
    return {
      success: true,
      data: {
        inspected: true,
        detected: false,
        evaded: false,
        authority,
        smugglingChance: resolveCharacterSmugglingChance(normalizedCharacterID),
        roll: null,
        contraband,
        totalFine: 0,
        standingLoss: 0,
      },
    };
  }

  const smugglingChance = resolveCharacterSmugglingChance(normalizedCharacterID);
  const roll = getInspectionRoll(options);
  const evaded = roll < smugglingChance;
  const totalFine = roundMoney(contraband.reduce((sum, entry) => sum + entry.fine, 0));
  const standingLoss = contraband.reduce((sum, entry) => sum + entry.standingLoss, 0);
  if (evaded) {
    return {
      success: true,
      data: {
        inspected: true,
        detected: false,
        evaded: true,
        authority,
        smugglingChance,
        roll,
        contraband,
        totalFine,
        standingLoss,
      },
    };
  }

  let penaltyResult = null;
  if (options.applyPenalties !== false) {
    penaltyResult = applyContrabandPenalties(
      normalizedCharacterID,
      authority,
      contraband,
      { ...options, shipID: normalizedShipID },
    );
  }

  log.info(
    `[Contraband] char=${normalizedCharacterID} ship=${normalizedShipID} system=${authority.solarSystemID} faction=${authority.factionID} items=${contraband.length} fine=${totalFine} standingLoss=${standingLoss.toFixed(3)}`,
  );

  const buildResult = (settledPenaltyResult) => {
    if (settledPenaltyResult && settledPenaltyResult.success !== true) {
      return settledPenaltyResult;
    }
    return {
      success: true,
      data: {
        inspected: true,
        detected: true,
        evaded: false,
        authority,
        smugglingChance,
        roll,
        contraband,
        totalFine,
        standingLoss,
        penalties: settledPenaltyResult
          ? settledPenaltyResult.data || null
          : null,
      },
    };
  };
  return penaltyResult && typeof penaltyResult.then === "function"
    ? penaltyResult.then(buildResult)
    : buildResult(penaltyResult);
}

module.exports = {
  ATTRIBUTE_SMUGGLING_MODIFIER,
  CONTRABAND_TYPE_RULES,
  UNDOCK_CONTRABAND_WARNING_MESSAGE_ID,
  getContrabandRuleForFaction,
  getSystemInspectionAuthority,
  buildContrabandEntries,
  buildUndockContrabandWarningArguments,
  inspectCharacterContraband,
  previewCharacterContraband,
  resolveCharacterSmugglingChance,
};
