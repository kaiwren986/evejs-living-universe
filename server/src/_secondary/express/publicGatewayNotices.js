"use strict";

// publicGatewayLocal puts itself here when it loads. Code that publishes gateway notices
// (wallet, Evermarks, reprocessing, skyhooks, ship and structure cosmetics) reads it back, so
// it does not require the gateway and everything the gateway loads. A notice goes only to open
// gateway streams, and a stream exists only once the gateway has loaded, so a notice published
// before then had nowhere to go. This module requires nothing.

let gateway = null;

function setPublicGateway(nextGateway) {
  if (!nextGateway || typeof nextGateway !== "object") {
    throw new TypeError("public gateway must be the gateway module's exports");
  }
  gateway = nextGateway;
}

// The gateway's exports, or null when it is not loaded in this process. Callers read the
// publish function from it at call time, as a require of the gateway did.
function getPublicGateway() {
  return gateway;
}

module.exports = {
  getPublicGateway,
  setPublicGateway,
};
