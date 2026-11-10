"use strict";
const assert = require("node:assert/strict");
const database = require("../../src/gameStore"), items = require("../../src/services/inventory/itemStore");
const { createTableRepository } = require("../../src/gameStore/tableRepository");
const { createCrewService } = require("../../src/services/crew/crewService");
const { createCrewInventory } = require("../../src/services/crew/crewInventory");
const { createCrewWorld } = require("../../src/services/crew/crewRuntime");
const { createMiningCrewService } = require("../../src/services/crew/miningCrewService");
const { createMiningCrewResources } = require("../../src/services/crew/miningCrewResources");
const { createFiniteScenes } = require("../helpers/miningCrewFixture");
const { seedPilot } = require("../helpers/crewFixture");
const worldData = require("../../src/space/worldData"), scenes = createFiniteScenes(); scenes.add(40001, 1000);
const mining = require("../../src/services/mining/miningRuntimeState");
const [phase, fault] = process.argv.slice(2); let clock = 0;
const courier = createCrewService({ repo: createTableRepository("service:crew"), inventory: createCrewInventory({ items }),
  world: createCrewWorld(worldData), character: id => database.read("characters", `/${id}`).data, now: () => clock, legMs: 1000 });
const resources = createMiningCrewResources({ worldData, sceneForSystem: scenes.sceneForSystem, items });
let pending = phase === "fail";
if (fault === "source") {
  const original = mining.commitCargoDepletion;
  mining.commitCargoDepletion = (...args) => { const result = original(...args);
    if (pending && !args[1]?.validateOnly && result.success) { pending = false; throw new Error("After source commit"); } return result; };
} else if (fault === "grant") {
  const original = items.grantItemToOwnerLocationIdempotent;
  items.grantItemToOwnerLocationIdempotent = (...args) => { const result = original(...args);
    if (pending && result.success) { pending = false; throw new Error("After inventory grant"); } return result; };
} else if (fault === "unload") {
  const original = resources.unload;
  resources.unload = (...args) => { original(...args); if (pending) { pending = false; throw new Error("After native unload"); } };
} else if (fault === "ack") {
  const original = resources.acknowledge;
  resources.acknowledge = (...args) => { if (pending) { pending = false; throw new Error("Before receipt acknowledgement"); } return original(...args); };
}
const service = createMiningCrewService({ repo: createTableRepository("service:crew-mining"), resources,
  crew: id => courier.snapshot(id), now: () => clock, travelMs: 1000, cycleMs: 1000 });
function tick(time) { clock = time; return service.tick({ budgetMs: 1000 }); }
async function main() {
  if (phase === "fail") {
    seedPilot(database, items);
    courier.submit(90001, { commandID: "create", expectedRevision: 0, type: "create", payload: { name: "Persistent crew" } });
    service.submit(90001, { commandID: "start", expectedRevision: 0, type: "start", payload: { homeStationID: 60000001, beltID: 40001, typeID: 1230 } });
    assert.equal(tick(1000).errors.length, 0);
    const result = tick(2000);
    if (["source", "grant"].includes(fault)) assert.equal(result.errors.length, 1);
    else { assert.equal(result.errors.length, 0); assert.equal(tick(3000).errors.length, 1); }
    if (fault === "unload" || fault === "ack") {
      const ore = items.listContainerItems(90001, 60000001, 4).find(i => i.typeID === 1230);
      assert.equal(items.moveItemToLocation(ore.itemID, 60000003, 4).success, true);
      assert.equal(database.flushTablesSync(["items"]).success, true);
    }
  } else {
    assert.equal(tick(10000).errors.length, 0); assert.equal(tick(11000).errors.length, 0);
    const state = service.snapshot(90001).mining;
    assert.equal(state.totalMined, 1000); assert.equal(state.totalDelivered, 1000); assert.equal(state.completedDeliveries, 1);
    assert.equal(state.skill.xp, 10, "Native replay must not duplicate mining experience");
    assert.equal(mining.getMineableState(scenes.scene, 140001).remainingQuantity, 0);
    const ore = [60000001, 60000003].flatMap(location => items.listContainerItems(90001, location, 4)).filter(i => i.typeID === 1230);
    assert.equal(ore.reduce((sum, i) => sum + i.quantity, 0), 1000);
    assert.equal(ore[0].locationID, ["unload", "ack"].includes(fault) ? 60000003 : 60000001);
    const record = require("../../src/services/mining/miningCargoCommits").listRecords()["crew-mining:90001"];
    assert.equal(items.getIdempotentGrantReceipt(`crew-mining:${record.jobID}:grant`).found, false);
    assert.equal(items.getIdempotentGrantReceipt(`crew-mining:${record.jobID}:unload`).found, false);
    assert.equal(service.universeFacts({ ownerID: 90001 }).actors[0].actorID, "mining:90001:member:0");
  }
  assert.equal((await database.shutdown("mining-process-restart")).success, true);
}
main().catch(async error => { console.error(error); await database.shutdown("failed-mining-restart"); process.exitCode = 1; });
