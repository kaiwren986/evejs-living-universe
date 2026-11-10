"use strict";

const { createPublishedFacade } = require("./publishedFacade");

module.exports = createPublishedFacade([
  "getActiveAbyssalRunForCharacterID",
  "getActiveAbyssalRunForShipID",
  "getActiveAbyssalRunForCharacter",
  "getActiveAbyssalRunForShip",
  "isCharacterInActiveAbyssalRun",
  "isShipInActiveAbyssalRun",
]);
