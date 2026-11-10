"use strict";

module.exports = {
  consumeShipModuleFuelForSession,
  rollbackShipModuleFuelConsumption,
  roundModuleFuelQuantity,
};

const runtimeEntryDirname = require("path").resolve(__dirname, "..");
const path = require("path");
const genericModuleFuelRuntime = require(path.join(
  runtimeEntryDirname,
  "./modules/genericModuleFuelRuntime",
));
const {
  syncInventoryChangesToSession,
} = require("./characterStateBridge");
const {
  getShipEntityInventoryCharacterID,
} = require("./entityDogmaView");
const {
  toFiniteNumber,
  toInt,
} = require("../../common/numbers");

// `consumptionQuantity` (714) is a whole number of units, but every percentage
// bonus that reaches it arrives as a chain of PostPercent multiplications, so
// an answer that is exact in decimal comes back as 99.99999999999997. Truncating
// that undercharged by a unit — and by 20% on a Force Recon covert cyno at
// Cynosural Field Theory V, where 50 x 0.2 x 0.5 = 5 arrived as
// 4.999999999999999 and was spent as 4. Round instead: the true value is always
// integral, only the float is not.
function roundModuleFuelQuantity(rawValue, fallback = 0) {
  return Math.max(0, Math.round(toFiniteNumber(rawValue, fallback)));
}

function consumeShipModuleFuelForSession(
  session,
  entity,
  fuelTypeID,
  fuelPerActivation,
  options = {},
) {
  const normalizedFuelTypeID = Math.max(0, toInt(fuelTypeID, 0));
  const normalizedFuelPerActivation = Math.max(0, toInt(fuelPerActivation, 0));
  if (normalizedFuelTypeID <= 0 || normalizedFuelPerActivation <= 0) {
    return {
      success: true,
      changes: [],
      consumedQuantity: 0,
    };
  }

  const fuelResult = genericModuleFuelRuntime.consumeShipModuleFuel(
    entity,
    normalizedFuelTypeID,
    normalizedFuelPerActivation,
    {
      resolveCharacterID(targetEntity) {
        return getShipEntityInventoryCharacterID(
          targetEntity,
          toInt(session && session.characterID, 0),
        );
      },
    },
  );
  if (!fuelResult.success) {
    return {
      success: false,
      errorMsg: fuelResult.errorMsg || "NO_FUEL",
      changes: Array.isArray(fuelResult.changes) ? fuelResult.changes : [],
    };
  }

  if (session && options.deferSync !== true) {
    syncInventoryChangesToSession(session, fuelResult.changes);
  }

  return {
    success: true,
    changes: Array.isArray(fuelResult.changes) ? fuelResult.changes : [],
    consumedQuantity: Math.max(0, toInt(fuelResult.consumedQuantity, 0)),
    rollbackKind: fuelResult.rollbackKind || null,
    rollbackChanges: Array.isArray(fuelResult.rollbackChanges)
      ? fuelResult.rollbackChanges
      : [],
  };
}

function rollbackShipModuleFuelConsumption(entity, fuelResult) {
  if (
    !fuelResult ||
    fuelResult.success !== true ||
    toInt(fuelResult.consumedQuantity, 0) <= 0
  ) {
    return { success: true, changes: [] };
  }
  try {
    return genericModuleFuelRuntime.restoreShipModuleFuel(entity, fuelResult);
  } catch (error) {
    return {
      success: false,
      errorMsg:
        String(error && error.message || "").trim() ||
        "FUEL_ROLLBACK_FAILED",
    };
  }
}
