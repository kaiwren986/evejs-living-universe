"use strict";

const path = require("path");

const {
  getFuelStacksForShipStorage,
  getFuelQuantityFromStacks,
  consumeFuelFromShipStorage,
  restoreFuelConsumption,
} = require(path.join(__dirname, "./sharedFuelRuntime"));

function getCargoFuelStacks(entity, fuelTypeID, callbacks = {}) {
  return getFuelStacksForShipStorage(entity, fuelTypeID, callbacks);
}

function consumeShipModuleFuel(entity, fuelTypeID, quantity, callbacks = {}) {
  return consumeFuelFromShipStorage(entity, fuelTypeID, quantity, callbacks);
}

function restoreShipModuleFuel(entity, fuelResult) {
  return restoreFuelConsumption(entity, fuelResult);
}

module.exports = {
  getCargoFuelStacks,
  getFuelStacksForShipStorage,
  getFuelQuantityFromStacks,
  consumeShipModuleFuel,
  restoreShipModuleFuel,
};
