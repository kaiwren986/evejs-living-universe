"use strict";
const { createIsolatedGameStore } = require("./helpers/isolatedGameStore");
const store = createIsolatedGameStore();
const { seedMiningStatic } = require("./helpers/miningCrewFixture"); seedMiningStatic(store);
store.writeStatic("asteroidBelts", { belts: [{ itemID: 40001, itemName: "Generated Veldspar field", solarSystemID: 1,
  position: { x: 1e9, y: 0, z: 0 }, typeID: 15, radius: 25000, fieldSeed: 40001,
  fieldStyleID: "empire_highsec_standard", security: 0.9, securityClass: "A", asteroidCount: 4 }] });
store.writeStatic("asteroidFieldStyles", { fieldStyles: [] });
store.writeStatic("itemTypes", { types: [
  { typeID: 34, name: "Tritanium", groupID: 18, categoryID: 4, volume: 0.01 },
  { typeID: 1230, name: "Veldspar", groupID: 462, categoryID: 25, volume: 0.1, published: true },
  ...[92433, 92434, 92435].map(typeID => ({ typeID, name: "Fixture outreach center", groupID: 226, categoryID: 2, radius: 100 })),
] });
process.env.EVEJS_SKIP_NPC_STARTUP = "1";
process.env.EVEJS_CREW_OPERATIONS_ENABLED = "true";
process.env.EVEJS_CREW_MINING_TRAVEL_MS = "1000";
process.env.EVEJS_CREW_MINING_CYCLE_MS = "1000";
const test = require("node:test"), assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process"), path = require("node:path");
test.after(() => store.cleanup());
test("production mining adapter opens a real generated scene and observes shared finite ore", () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, "fixtures/miningCrewScene.cjs")], {
    env: process.env, encoding: "utf8", windowsHide: true, timeout: 30000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
