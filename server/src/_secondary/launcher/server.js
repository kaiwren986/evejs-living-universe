"use strict";

/**
 * Client launching is owned by Play.bat / PlayDebug.bat and ClientSETUP.
 *
 * Keep the legacy service name registered as disabled so secondary-service
 * discovery remains stable without reviving the removed clientPath and
 * autoLaunch configuration keys.
 */

const path = require("path");

const log = require(path.join(__dirname, "../../utils/logger"));

module.exports = {
  enabled: false,
  serviceName: "clientLauncher",
  exec() {
    log.debug("client launching is handled by the EveJS play scripts");
  },
};
