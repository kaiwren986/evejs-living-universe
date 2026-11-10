"use strict";

// An in-memory command identity; Symbols never enter persisted/wire JSON.
const WARP_TRANSMISSION_RECEIPT = Symbol("warpTransmissionReceipt");
module.exports = { WARP_TRANSMISSION_RECEIPT };
