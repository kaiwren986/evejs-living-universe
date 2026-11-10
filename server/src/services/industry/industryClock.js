"use strict";

// Industry deadlines follow a scoped clock in simulations. Persistence leases
// and helper processes continue to use real wall time.
const { currentFileTime: wallFileTime } = require("../_shared/serviceHelpers");
let provider = null;
function currentFileTime() {
  return provider ? BigInt(provider()) : wallFileTime();
}
function setNowFileTimeOverride(fn) { provider = typeof fn === "function" ? fn : null; }
function resetNowFileTimeOverride() { provider = null; }
module.exports = { currentFileTime, setNowFileTimeOverride, resetNowFileTimeOverride };
