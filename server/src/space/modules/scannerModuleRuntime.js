"use strict";

const {
  toFiniteNumber,
} = require("../../common/numbers");

// Cargo Scanners (effect 47 `cargoScan`, guid effects.CargoScan) and Ship
// Scanners (effect 46 `shipScan`, guid effects.ShipScan).
//
// Seven published types, two groups, one job each: reveal a target's cargo or
// ship fittings to the pilot who scanned it. Neither effect name appeared
// anywhere in `server/src` before this file — both fell through to the generic
// module path, which cycled the module, charged capacitor, and delivered
// nothing at all. The pair also ignored every gate their own effect records
// declare:
//
//   effectCategoryID 2 (activeTarget)      -> a locked target is required
//   cargoScan  rangeAttributeID 126        -> 50/55/65/70 km, hard cutoff
//   shipScan   rangeAttributeID 125        -> 50/55/60 km optimal
//              falloffAttributeID 510      -> 30/33/36 km falloff
//
// Attribute 510's own SDE description is the specification for the falloff:
// "Distance from maximum range at which accuracy has fallen by half." That is
// exactly the engine's standard falloff curve, so a ship scan reveals every
// fitted item inside optimal and rolls per item beyond it, reaching a coin flip
// at optimal + 1x falloff. `cargoScan` declares no falloff at all, so it is a
// hard cutoff and its result is never partial — the two effects differ in the
// SDE and they differ here.
//
// The client contract is fixed by the decompiled V24 client
// (`eve/client/script/ui/inflight/shipHud/shipUI.py`, and the two windows in
// `eve/client/script/ui/inflight/shipscan.py` that unpack the payloads):
//
//   OnCargoScanComplete(shipID, cargoList)
//     cargoList: [(typeID, quantity), ...]  -- `for typeID, quantity in
//     cargoList` is an unguarded 2-tuple unpack, and a blueprint's copy/original
//     bit rides in the sign: quantity == -2 is a copy, any other non-positive
//     value is an original.
//
//   OnShipScanCompleted(shipID, capacitorCharge, capacitorCapacity, hardwareList)
//     hardwareList: [(typeID, quantity), ...] -- the client re-derives the slot
//     bucket from static type data (`GetSlotTypeForModuleType`), so the payload
//     carries no flags and no itemIDs. capacitor is two absolute GJ numbers.
//
// Neither notification has any counterpart on the scanned pilot's side: the
// whole V24 dump contains no "you were scanned" event, and scanning carries no
// aggression. The target is deliberately told nothing.
const path = require("path");

const {
  SLOT_FAMILY_FLAGS,
} = require(path.join(__dirname, "../../services/fitting/liveFittingState"));
const {
  buildLiveModuleAttributeMap,
} = require(path.join(__dirname, "./liveModuleAttributes"));

const EFFECT_ID_SHIP_SCAN = 46;
const EFFECT_ID_CARGO_SCAN = 47;
const EFFECT_NAME_SHIP_SCAN = "shipscan";
const EFFECT_NAME_CARGO_SCAN = "cargoscan";
const EFFECT_GUID_SHIP_SCAN = "effects.shipscan";
const EFFECT_GUID_CARGO_SCAN = "effects.cargoscan";

const GROUP_CARGO_SCANNER = 47;
const GROUP_SHIP_SCANNER = 48;

const SCAN_KIND_CARGO = "cargo";
const SCAN_KIND_SHIP = "ship";

// dogma/const.py: attributeCargoScanRange = 126, attributeShipScanRange = 125,
// attributeShipScanFalloff = 510, attributeCargoScanResistance = 188,
// attributeShipScanResistance = 511.
const ATTRIBUTE_CARGO_SCAN_RANGE = 126;
const ATTRIBUTE_SHIP_SCAN_RANGE = 125;
const ATTRIBUTE_SHIP_SCAN_FALLOFF = 510;
const ATTRIBUTE_CARGO_SCAN_RESISTANCE = 188;
const ATTRIBUTE_SHIP_SCAN_RESISTANCE = 511;

const NOTIFY_CARGO_SCAN_COMPLETE = "OnCargoScanComplete";
const NOTIFY_SHIP_SCAN_COMPLETED = "OnShipScanCompleted";

const CATEGORY_BLUEPRINT = 9;

// inventorycommon/const.py — the four container groups a scan sees through, plus
// the courier package type. A cargo scan reveals what is inside one layer of
// concealment and omits the wrapper itself; anything nested a second deep is
// reported as the wrapper's own type instead of its contents.
const CONTAINER_GROUP_IDS = new Set([12, 340, 448, 649]);
const PLASTIC_WRAP_TYPE_ID = 3468;

// Surface-to-surface range comparisons carry the same 1 m grace the weapon path
// uses, so a target sitting exactly on the range boundary is in range.
const RANGE_GRACE_METERS = 1;

const FITTING_SLOT_FLAGS = new Set([
  ...SLOT_FAMILY_FLAGS.low,
  ...SLOT_FAMILY_FLAGS.med,
  ...SLOT_FAMILY_FLAGS.high,
  ...SLOT_FAMILY_FLAGS.rig,
  ...SLOT_FAMILY_FLAGS.subsystem,
  ...SLOT_FAMILY_FLAGS.service,
]);
// flagID 0 (flagNone) also marks cargo inside jetcans and other containers.
// The inventory read is scoped to the target's locationID, so those rows are
// contents, not unrelated objects floating in space. Only fitting slots and
// the hidden-modifier bucket (156) are excluded from cargo results.
const NON_CARGO_FLAGS = new Set([156]);

function toInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function roundNumber(value, digits = 6) {
  const numeric = toFiniteNumber(value, 0);
  const factor = 10 ** Math.max(0, toInt(digits, 0));
  return Math.round(numeric * factor) / factor;
}

function resolveScanKind(effectRecord, moduleItem = null) {
  const effectID = toInt(effectRecord && effectRecord.effectID, 0);
  if (effectID === EFFECT_ID_CARGO_SCAN) {
    return SCAN_KIND_CARGO;
  }
  if (effectID === EFFECT_ID_SHIP_SCAN) {
    return SCAN_KIND_SHIP;
  }
  const name = normalizeText(effectRecord && effectRecord.name);
  if (name === EFFECT_NAME_CARGO_SCAN) {
    return SCAN_KIND_CARGO;
  }
  if (name === EFFECT_NAME_SHIP_SCAN) {
    return SCAN_KIND_SHIP;
  }
  const guid = normalizeText(effectRecord && effectRecord.guid);
  if (guid === EFFECT_GUID_CARGO_SCAN) {
    return SCAN_KIND_CARGO;
  }
  if (guid === EFFECT_GUID_SHIP_SCAN) {
    return SCAN_KIND_SHIP;
  }
  const groupID = toInt(moduleItem && moduleItem.groupID, 0);
  if (groupID === GROUP_CARGO_SCANNER) {
    return SCAN_KIND_CARGO;
  }
  if (groupID === GROUP_SHIP_SCANNER) {
    return SCAN_KIND_SHIP;
  }
  return null;
}

function isScannerEffect(effectRecord, moduleItem = null) {
  return resolveScanKind(effectRecord, moduleItem) !== null;
}

function isScannerEffectState(effectState) {
  return Boolean(effectState && effectState.scannerModuleEffect === true);
}

function isCargoHoldFlag(flagID) {
  const normalizedFlagID = toInt(flagID, -1);
  if (normalizedFlagID < 0) {
    return false;
  }
  return (
    !FITTING_SLOT_FLAGS.has(normalizedFlagID) &&
    !NON_CARGO_FLAGS.has(normalizedFlagID)
  );
}

function isFittingSlotFlag(flagID) {
  return FITTING_SLOT_FLAGS.has(toInt(flagID, -1));
}

function isContainerItem(item) {
  return (
    CONTAINER_GROUP_IDS.has(toInt(item && item.groupID, 0)) ||
    toInt(item && item.typeID, 0) === PLASTIC_WRAP_TYPE_ID
  );
}

// The client displays a blueprint's copy/original state by reading the sign of
// the quantity it was sent, so a scan has to carry the singleton value the same
// way the item store's own removal notifications do: -2 for a copy, -1 for an
// original.
function resolveScannedQuantity(item) {
  const singleton = toInt(item && item.singleton, 0);
  if (toInt(item && item.categoryID, 0) === CATEGORY_BLUEPRINT && singleton > 0) {
    return -singleton;
  }
  const quantity = toInt(
    item && (item.quantity ?? item.stacksize),
    0,
  );
  return quantity > 0 ? quantity : 1;
}

function pushScannedRow(rows, item) {
  const typeID = toInt(item && item.typeID, 0);
  if (typeID <= 0) {
    return;
  }
  rows.push([typeID, resolveScannedQuantity(item)]);
}

// A cargo scan reads ship holds or container contents, descends exactly one
// level into containers and courier packages, and never reports the wrapper itself. The
// widely repeated claim that a secure container hides its contents from a
// scanner is false; what actually hides cargo is a second layer, which is why
// double-wrapped courier packages report only plastic wrap.
function buildCargoScanRows(targetItems, callbacks = {}) {
  const rows = [];
  for (const item of Array.isArray(targetItems) ? targetItems : []) {
    if (!item || !isCargoHoldFlag(item.flagID)) {
      continue;
    }
    if (!isContainerItem(item)) {
      pushScannedRow(rows, item);
      continue;
    }
    const nested =
      typeof callbacks.listContainedItems === "function"
        ? callbacks.listContainedItems(toInt(item.itemID, 0))
        : [];
    for (const nestedItem of Array.isArray(nested) ? nested : []) {
      if (!nestedItem) {
        continue;
      }
      pushScannedRow(rows, nestedItem);
    }
  }
  return rows;
}

// Standard EVE falloff, which is what attribute 510 describes in so many words:
// full accuracy inside optimal, half at optimal + one falloff. Beyond optimal +
// one falloff the engine refuses the activation outright, matching every other
// falloff-bearing module family here.
function resolveScanRevealChance(surfaceDistanceMeters, optimalMeters, falloffMeters) {
  const distance = Math.max(0, toFiniteNumber(surfaceDistanceMeters, 0));
  const optimal = Math.max(0, toFiniteNumber(optimalMeters, 0));
  const falloff = Math.max(0, toFiniteNumber(falloffMeters, 0));
  if (distance <= optimal + RANGE_GRACE_METERS) {
    return 1;
  }
  if (falloff <= 0) {
    return 0;
  }
  const distanceIntoFalloff = distance - optimal;
  if (distanceIntoFalloff > falloff + RANGE_GRACE_METERS) {
    return 0;
  }
  return roundNumber(0.5 ** ((distanceIntoFalloff / falloff) ** 2), 6);
}

function drawRandom(callbacks = {}) {
  if (callbacks && typeof callbacks.random === "function") {
    const value = Number(callbacks.random());
    if (Number.isFinite(value)) {
      return Math.max(0, Math.min(0.999999999, value));
    }
  }
  return Math.random();
}

// A ship scan reports fitted hardware, which in the item store is exactly the
// set of items sitting in a fitting slot: the modules, plus the charges loaded
// into them, which share their module's flag. The client buckets them back into
// slots from static type data, so quantity here is a count of that type.
//
// CCP's Retribution note is the specification for the partial result: "Ship
// scanners have been upgraded to no longer show higher quantities of fitted
// items. They still have a chance of missing items in their scan." So the roll
// is per fitted item and the surviving quantities are truthful.
function buildShipScanRows(targetItems, revealChance, callbacks = {}) {
  const quantityByTypeID = new Map();
  const chance = Math.max(0, Math.min(1, toFiniteNumber(revealChance, 1)));
  for (const item of Array.isArray(targetItems) ? targetItems : []) {
    if (!item || !isFittingSlotFlag(item.flagID)) {
      continue;
    }
    const typeID = toInt(item.typeID, 0);
    if (typeID <= 0) {
      continue;
    }
    if (chance < 1 && drawRandom(callbacks) >= chance) {
      continue;
    }
    const quantity = Math.max(1, toInt(item.quantity ?? item.stacksize, 1));
    quantityByTypeID.set(typeID, (quantityByTypeID.get(typeID) || 0) + quantity);
  }
  return [...quantityByTypeID.entries()].map(([typeID, quantity]) => [typeID, quantity]);
}

function resolveScannerAttributeMap({
  moduleItem,
  shipItem = null,
  chargeItem = null,
  skillMap = null,
  fittedItems = null,
  activeModuleContexts = null,
  additionalLocationModifierSources = null,
} = {}) {
  if (!shipItem) {
    return null;
  }
  // Read the live map, not the raw type. Two published bonuses ride ordinary
  // dogma here and both arrive for free through it: the Survey skill's
  // -5%/level cycle time (effect 744, `duration` PostPercent by
  // `scanSpeedBonus`, LocationRequiredSkillModifier on skill 3426, which is why
  // every scanner declares CPU Management as requiredSkill1) and the Rorqual's
  // +200% cargo scanner range (effect 3493, `cargoScanRange` PostPercent by
  // `cargoScannerRangeBonus`, LocationGroupModifier on group 47).
  return buildLiveModuleAttributeMap(
    shipItem,
    moduleItem,
    chargeItem,
    skillMap,
    fittedItems,
    activeModuleContexts,
    Array.isArray(additionalLocationModifierSources)
      ? { additionalLocationModifierSources }
      : {},
  );
}

function resolveScannerRanges({ scanKind, effectRecord, attributes }) {
  const rangeAttributeID =
    toInt(effectRecord && effectRecord.rangeAttributeID, 0) ||
    (scanKind === SCAN_KIND_CARGO ? ATTRIBUTE_CARGO_SCAN_RANGE : ATTRIBUTE_SHIP_SCAN_RANGE);
  const falloffAttributeID = toInt(effectRecord && effectRecord.falloffAttributeID, 0) ||
    (scanKind === SCAN_KIND_SHIP ? ATTRIBUTE_SHIP_SCAN_FALLOFF : 0);
  return {
    optimalMeters: Math.max(
      0,
      toFiniteNumber(attributes && attributes[rangeAttributeID], 0),
    ),
    // cargoScan declares no falloffAttributeID at all, so a Cargo Scanner is a
    // hard cutoff however the type data changes.
    falloffMeters:
      scanKind === SCAN_KIND_SHIP && falloffAttributeID > 0
        ? Math.max(0, toFiniteNumber(attributes && attributes[falloffAttributeID], 0))
        : 0,
  };
}

// 188 `cargoScanResistance` is "Chance of being able to resist a cargo scan".
// Of the 591 types that declare it, only eight published types carry a non-zero
// value and all eight carry exactly 1.0: the five Blockade Runners (Crane,
// Prorator, Prowler, Viator, Deluge) plus the Boobook, the Cenotaph and the
// Tholos. Reading the attribute covers all eight; a Blockade Runner whitelist
// would have covered five. 511 `shipScanResistance` exists with the same
// meaning and is zero on every one of the 159 types that declare it, so nothing
// in the game resists a ship scan — but it is read the same way rather than
// assumed away.
//
// It is read live rather than off the raw type because effect 8518
// `cargoScanResistanceAssign` PostAssigns 188 onto the ship from a fitted item,
// which is how the (currently unpublished) Smuggler Blockade Running Boosters
// and the Guri Malakim Expanded Cargohold grant immunity.
function resolveScanResistance(scanKind, targetEntity, callbacks = {}) {
  const attributeID =
    scanKind === SCAN_KIND_CARGO
      ? ATTRIBUTE_CARGO_SCAN_RESISTANCE
      : ATTRIBUTE_SHIP_SCAN_RESISTANCE;
  const raw =
    typeof callbacks.getEntityAttributeValue === "function"
      ? callbacks.getEntityAttributeValue(targetEntity, attributeID, 0)
      : 0;
  return Math.max(0, Math.min(1, toFiniteNumber(raw, 0)));
}

function measureSurfaceDistance(callbacks, sourceEntity, targetEntity) {
  if (!callbacks || typeof callbacks.getEntitySurfaceDistance !== "function") {
    return { available: false, surfaceDistance: 0 };
  }
  const distance = callbacks.getEntitySurfaceDistance(sourceEntity, targetEntity);
  if (!Number.isFinite(Number(distance))) {
    return { available: false, surfaceDistance: 0 };
  }
  return { available: true, surfaceDistance: Math.max(0, Number(distance)) };
}

function resolveScannerActivation({
  entity = null,
  moduleItem = null,
  effectRecord = null,
  chargeItem = null,
  shipItem = null,
  skillMap = null,
  fittedItems = null,
  activeModuleContexts = null,
  additionalLocationModifierSources = null,
  targetID = 0,
  callbacks = {},
} = {}) {
  const scanKind = resolveScanKind(effectRecord, moduleItem);
  if (!scanKind) {
    return { matched: false };
  }
  if (!entity || !moduleItem) {
    return { matched: true, success: false, errorMsg: "UNSUPPORTED_MODULE" };
  }

  const attributes = resolveScannerAttributeMap({
    moduleItem,
    shipItem,
    chargeItem,
    skillMap,
    fittedItems,
    activeModuleContexts,
    additionalLocationModifierSources,
  });
  const { optimalMeters, falloffMeters } = resolveScannerRanges({
    scanKind,
    effectRecord,
    attributes,
  });
  if (optimalMeters <= 0) {
    return { matched: true, success: false, errorMsg: "UNSUPPORTED_MODULE" };
  }

  const normalizedTargetID = toInt(targetID, 0);
  if (normalizedTargetID <= 0) {
    return { matched: true, success: false, errorMsg: "TARGET_REQUIRED" };
  }
  const targetEntity =
    typeof callbacks.getEntityByID === "function"
      ? callbacks.getEntityByID(normalizedTargetID)
      : null;
  if (!targetEntity) {
    return { matched: true, success: false, errorMsg: "TARGET_NOT_FOUND" };
  }
  if (targetEntity === entity || toInt(targetEntity.itemID, 0) === toInt(entity.itemID, 0)) {
    return { matched: true, success: false, errorMsg: "TARGET_SELF" };
  }
  if (
    typeof callbacks.isEntityLockedTarget === "function" &&
    !callbacks.isEntityLockedTarget(entity, normalizedTargetID)
  ) {
    return { matched: true, success: false, errorMsg: "TARGET_NOT_LOCKED" };
  }

  const distance = measureSurfaceDistance(callbacks, entity, targetEntity);
  if (!distance.available) {
    return { matched: true, success: false, errorMsg: "TARGET_NOT_FOUND" };
  }
  const revealChance = resolveScanRevealChance(
    distance.surfaceDistance,
    optimalMeters,
    falloffMeters,
  );
  if (revealChance <= 0) {
    return {
      matched: true,
      success: false,
      errorMsg: "TARGET_OUT_OF_RANGE",
      data: {
        optimalMeters,
        falloffMeters,
        surfaceDistanceMeters: distance.surfaceDistance,
      },
    };
  }

  const resistance = resolveScanResistance(scanKind, targetEntity, callbacks);
  // A Blockade Runner does not eat the cycle: the module refuses to start.
  if (resistance > 0 && drawRandom(callbacks) < resistance) {
    return {
      matched: true,
      success: false,
      errorMsg: "TARGET_RESISTS_SCAN",
      data: { scanKind, resistance },
    };
  }

  return {
    matched: true,
    success: true,
    data: {
      targetEntity,
      scanKind,
      optimalMeters,
      falloffMeters,
    },
    effectStatePatch: {
      scannerModuleEffect: true,
      scannerScanKind: scanKind,
      scannerOptimalMeters: optimalMeters,
      scannerFalloffMeters: falloffMeters,
    },
  };
}

// The result lands at the cycle boundary, which is where the client opens its
// result window. Everything activation checked is rechecked: a target that has
// died, unlocked or left range before the cycle completes returns nothing at
// all, which is also what the client shows for a scan that never arrives.
function executeScannerCycle({
  entity = null,
  effectState = null,
  session = null,
  callbacks = {},
} = {}) {
  if (!isScannerEffectState(effectState)) {
    return { success: true, data: {} };
  }
  if (!entity) {
    return { success: false, stopReason: "scanner" };
  }

  const scanKind = normalizeText(effectState.scannerScanKind) === SCAN_KIND_SHIP
    ? SCAN_KIND_SHIP
    : SCAN_KIND_CARGO;
  const targetID = toInt(effectState.targetID, 0);
  if (targetID <= 0) {
    return { success: false, stopReason: "target" };
  }
  const targetEntity =
    typeof callbacks.getEntityByID === "function"
      ? callbacks.getEntityByID(targetID)
      : null;
  if (!targetEntity) {
    return { success: false, stopReason: "target" };
  }
  if (
    typeof callbacks.isEntityLockedTarget === "function" &&
    !callbacks.isEntityLockedTarget(entity, targetID)
  ) {
    return { success: false, stopReason: "target" };
  }

  const distance = measureSurfaceDistance(callbacks, entity, targetEntity);
  if (!distance.available) {
    return { success: false, stopReason: "target" };
  }
  const optimalMeters = Math.max(0, toFiniteNumber(effectState.scannerOptimalMeters, 0));
  const falloffMeters = Math.max(0, toFiniteNumber(effectState.scannerFalloffMeters, 0));
  const revealChance = resolveScanRevealChance(
    distance.surfaceDistance,
    optimalMeters,
    falloffMeters,
  );
  if (revealChance <= 0) {
    return { success: false, stopReason: "range" };
  }

  const targetItems =
    typeof callbacks.listEntityInventoryItems === "function"
      ? callbacks.listEntityInventoryItems(targetEntity)
      : [];

  const scannedShipID = toInt(targetEntity.itemID, 0);
  let notifyType = "";
  let payload = null;
  let rows = [];
  if (scanKind === SCAN_KIND_CARGO) {
    rows = buildCargoScanRows(targetItems, callbacks);
    notifyType = NOTIFY_CARGO_SCAN_COMPLETE;
    payload = [scannedShipID, rows];
  } else {
    rows = buildShipScanRows(targetItems, revealChance, callbacks);
    const capacitorCharge = roundNumber(
      typeof callbacks.getEntityCapacitorAmount === "function"
        ? callbacks.getEntityCapacitorAmount(targetEntity)
        : 0,
      2,
    );
    const capacitorCapacity = roundNumber(
      typeof callbacks.getEntityCapacitorCapacity === "function"
        ? callbacks.getEntityCapacitorCapacity(targetEntity)
        : 0,
      2,
    );
    notifyType = NOTIFY_SHIP_SCAN_COMPLETED;
    payload = [scannedShipID, capacitorCharge, capacitorCapacity, rows];
  }

  const delivered =
    typeof callbacks.deliverScanResult === "function"
      ? Boolean(callbacks.deliverScanResult(session, notifyType, payload))
      : false;

  return {
    success: true,
    data: {
      scanKind,
      notifyType,
      payload,
      rows,
      revealChance,
      delivered,
      surfaceDistanceMeters: distance.surfaceDistance,
    },
  };
}

module.exports = {
  EFFECT_ID_CARGO_SCAN,
  EFFECT_ID_SHIP_SCAN,
  GROUP_CARGO_SCANNER,
  GROUP_SHIP_SCANNER,
  NOTIFY_CARGO_SCAN_COMPLETE,
  NOTIFY_SHIP_SCAN_COMPLETED,
  SCAN_KIND_CARGO,
  SCAN_KIND_SHIP,
  buildCargoScanRows,
  buildShipScanRows,
  executeScannerCycle,
  isCargoHoldFlag,
  isFittingSlotFlag,
  isScannerEffect,
  isScannerEffectState,
  resolveScanKind,
  resolveScanRevealChance,
  resolveScannerActivation,
};
