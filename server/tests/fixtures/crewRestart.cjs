"use strict";
const assert = require("node:assert/strict");
const database = require("../../src/gameStore");
const items = require("../../src/services/inventory/itemStore");
const { createTableRepository } = require("../../src/gameStore/tableRepository");
const { createCrewService } = require("../../src/services/crew/crewService");
const { createCrewInventory } = require("../../src/services/crew/crewInventory");
const { createCrewWorld } = require("../../src/services/crew/crewRuntime");
const { seedPilot } = require("../helpers/crewFixture");
const inventory = createCrewInventory({ items });
const mode = process.argv[2];
const repo = createTableRepository("service:crew");
let clock = mode === "reserve" ? 1000 : mode === "deliver" ? 100000 : 200000;
let injected = false;
const service = createCrewService({ repo, inventory: { ...inventory, move(...args) {
  const result = inventory.move(...args);
  if (!injected && args[2] === mode) { injected = true; throw new Error("Injected failure after durable inventory effect"); }
  return result;
} }, world: createCrewWorld(require("../../src/space/worldData")), character: (id) => database.read("characters", `/${id}`).data,
  now: () => clock, legMs: 1000 });
async function main() {
  if (mode === "reserve") {
    const itemID = seedPilot(database, items);
    service.submit(90001, { commandID: "restart:create", expectedRevision: 0, type: "create", payload: { name: "Restart crew" } });
    assert.throws(() => service.submit(90001, { commandID: "restart:deliver", expectedRevision: 1, type: "deliver",
      payload: { destinationStationID: 60000003, itemID } }), /Injected/);
    assert.equal(items.findItemById(itemID).locationID, 8_600_000_000_090_001);
    assert.equal(database.read("crewRuntime", "/90001").data.job.phase, "reserving");
  } else if (mode === "deliver") {
    // First recover reservation, then advance with a second, later clock.
    service.tick({ budgetMs: 1000 });
    clock += 10000;
    const result = service.tick({ budgetMs: 1000 });
    assert.equal(result.errors.length, 1);
    assert.equal(database.read("crewRuntime", "/90001").data.job.phase, "delivering");
    assert.equal(items.listContainerItems(90001, 60000003, 4).length, 1);
  } else {
    const result = service.tick({ budgetMs: 1000 });
    assert.equal(result.errors.length, 0);
    assert.equal(service.snapshot(90001).crew.job, null);
    const cargo = items.listContainerItems(90001, 60000003, 4);
    assert.equal(cargo.length, 1); assert.equal(cargo[0].quantity, 1000);
    // A late replay after the player moves delivered cargo must not pull it back.
    assert.equal(items.moveItemToLocation(cargo[0].itemID, 60000002, 4).success, true);
    database.flushTableSync("items");
    const replay = service.submit(90001, { commandID: "restart:deliver", expectedRevision: 1, type: "deliver",
      payload: { destinationStationID: 60000003, itemID: cargo[0].itemID } });
    assert.equal(replay.replayed, true);
    assert.equal(items.findItemById(cargo[0].itemID).locationID, 60000002);
  }
  assert.equal((await database.shutdown("crew-restart-fixture")).success, true);
  console.log(`CREW_RESTART_OK:${mode}`);
}
main().catch(async (error) => { console.error(error); await database.shutdown("fixture-error"); process.exitCode = 1; });
