"use strict";

const config = require("../../config");

function getPlanetResourceAbundanceMultiplier() {
  const number = Number(config.planetResourceAbundanceMultiplier);
  return Number.isFinite(number) && number > 0 ? number : 1;
}

module.exports = {
  getPlanetResourceAbundanceMultiplier,
};
