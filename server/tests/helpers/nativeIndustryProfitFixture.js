"use strict";
// Custody/replay tests isolate native settlement from market pricing. Economic
// integration tests and production runtimes use the real profitability adapter.
module.exports = { evaluate: async () => ({ allowed: true, status: "profitable", fixture: "native_settlement_only" }) };
