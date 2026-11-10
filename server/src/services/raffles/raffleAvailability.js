"use strict";

const path = require("path");

const config = require(path.join(__dirname, "../../config"));
const {
  throwWrappedRaffleError,
} = require(path.join(__dirname, "../../common/machoErrors"));

const HYPERNET_DISABLED_ERROR_CLASS = "raffles.RafflesError";
const HYPERNET_DISABLED_ERROR_MESSAGE = "HyperNetDisabled";

function isHyperNetAvailable() {
  return config.hyperNetKillSwitch !== true;
}

function requireHyperNetAvailable() {
  if (!isHyperNetAvailable()) {
    throwWrappedRaffleError(
      HYPERNET_DISABLED_ERROR_CLASS,
      HYPERNET_DISABLED_ERROR_MESSAGE,
    );
  }
}

module.exports = {
  HYPERNET_DISABLED_ERROR_CLASS,
  HYPERNET_DISABLED_ERROR_MESSAGE,
  isHyperNetAvailable,
  requireHyperNetAvailable,
};
