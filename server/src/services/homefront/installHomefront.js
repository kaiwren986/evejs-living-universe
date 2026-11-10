"use strict";

// World composition, called before service registration or scene processing.
// Engine services depend on homefrontHooks, never on this installer or its
// implementation modules. No require paths are hidden behind a service locator.
function installHomefront() {
  require("./homefrontHooks").install({
    runtime: require("./homefrontRuntime"),
    weather: require("./homefrontWeather"),
    admission: require("./homefrontAdmission"),
    cargo: require("./homefrontCargo"),
    client: require("./homefrontClient"),
    rewards: require("./homefrontRewards"),
  });
}

module.exports = { installHomefront };
