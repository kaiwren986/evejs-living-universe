"use strict";

function installIncursions() {
  require("./incursionHooks").install(require("./incursionEncounterRuntime"));
}

module.exports = { installIncursions };
