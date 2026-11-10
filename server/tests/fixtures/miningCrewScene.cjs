"use strict";
const assert = require("node:assert/strict");
const database = require("../../src/gameStore"), items = require("../../src/services/inventory/itemStore");
const { seedPilot } = require("../helpers/crewFixture"); seedPilot(database, items);
async function main() {
  const crew = require("../../src/services/crew/crewRuntime").getDefaultCrewService();
  const miners = require("../../src/services/crew/miningCrewRuntime").getDefaultMiningCrewService();
  crew.submit(90001, { commandID: "scene:create", expectedRevision: 0, type: "create", payload: { name: "Scene crew" } });
  const sites = miners.sites(90001, 60000001);
  assert.equal(sites.length, 1); assert.ok(sites[0].ores.some(ore => ore.typeID === 1230 && ore.remainingQuantity > 0));
  const runtime = require("../../src/space/runtime"), scene = runtime.ensureScene(1);
  const mining = require("../../src/services/mining/miningRuntimeState");
  const { createMiningCrewResources } = require("../../src/services/crew/miningCrewResources");
  const resources = createMiningCrewResources({ worldData: require("../../src/space/worldData"), items, sceneForSystem: id => runtime.ensureScene(id) });
  const intent = { ownerID: 90001, escrowLocationID: 8_500_000_000_090_001, systemID: 1, plan: { beltID: 40001, typeID: 1230 },
    job: { jobID: "a".repeat(64), serial: 1, batchM3: 100, extractionAtMs: Date.now() } };
  intent.job.allocation = resources.prepare(intent);
  const before = intent.job.allocation.state.remainingQuantity;
  const cargo = resources.extract(intent); assert.equal(cargo.quantity, 1000);
  const state = mining.getMineableState(scene, intent.job.allocation.resourceID);
  assert.equal(state.remainingQuantity, before - 1000);
  assert.equal(scene.getEntityByID(state.entityID).miningYieldTypeID, 1230);
  assert.equal(items.findItemById(cargo.itemID).locationID, intent.escrowLocationID);
  clearInterval(runtime._tickHandle);
  assert.equal((await database.shutdown("generated-mining-scene-test")).success, true);
}
// The full scene owns background systems. Exit the child before the parent
// removes its attested store, so no delayed callback can reopen that database.
main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
