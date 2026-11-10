"use strict";
const assert = require("node:assert/strict");
const database = require("../../src/gameStore"), items = require("../../src/services/inventory/itemStore");
const { createTableRepository } = require("../../src/gameStore/tableRepository");
const { createCrewService } = require("../../src/services/crew/crewService");
const { createCrewInventory } = require("../../src/services/crew/crewInventory");
const { createCrewWorld } = require("../../src/services/crew/crewRuntime");
const { seedPilot } = require("../helpers/crewFixture");
const phase = process.argv[2], partial = process.argv[3] === "partial", inventory = createCrewInventory({ items });
const initialLoad = partial ? 100000 : 1000, reserve = partial ? 101000 : 0;
let clock = { reserve: 1000, recover: 10000, deliver: 20000, restock: 30000 }[phase];
let fail = phase === "reserve";
const service = createCrewService({ repo: createTableRepository("service:crew"), inventory: { ...inventory, move(...args) {
  const result = inventory.move(...args); if (fail) { fail = false; throw new Error("After reservation"); } return result;
} }, world: createCrewWorld(require("../../src/space/worldData")), character: (id) => database.read("characters", `/${id}`).data,
  now: () => clock, legMs: 1000 });
async function main() {
  if (phase === "reserve") {
    seedPilot(database, items);
    if(partial)items.grantItemToOwnerLocation(90001,60000001,4,34,200000);
    service.submit(90001, { commandID: "auto:create", expectedRevision: 0, type: "create", payload: { name: "Persistent supply crew" } });
    assert.throws(() => service.submit(90001, { commandID: "auto:standing", expectedRevision: 1, type: "automate",
      payload: { sourceStationID: 60000001, destinationStationID: 60000003, typeID: 34, sourceReserve: reserve } }), /After reservation/);
  } else {
    assert.equal(service.tick({ budgetMs: 1000 }).errors.length, 0);
    if (phase === "recover") assert.equal(service.snapshot(90001).crew.job.cargo.quantity, initialLoad);
    if (phase === "deliver") {
      assert.equal(service.snapshot(90001).crew.standingOrder.completedDeliveries, 1);
      assert.equal(service.snapshot(90001).crew.skill.xp, 10);
      assert.equal(items.listContainerItems(90001, 60000003, 4).reduce((sum, item) => sum + item.quantity, 0), initialLoad);
    }
    if (phase === "restock") {
      assert.equal(service.snapshot(90001).crew.standingOrder.status, "waiting_for_stock");
      items.grantItemToOwnerLocation(90001, 60000001, 4, { typeID: 34, name: "Tritanium", groupID: 18, categoryID: 4, volume: 0.01 }, 500);
      clock += 6000; assert.equal(service.tick({ budgetMs: 1000 }).errors.length, 0);
      assert.equal(service.snapshot(90001).crew.job.cargo.quantity, 500);
      clock += 5000; assert.equal(service.tick({ budgetMs: 1000 }).errors.length, 0);
      assert.equal(service.snapshot(90001).crew.standingOrder.completedDeliveries, 2);
      assert.equal(service.snapshot(90001).crew.skill.xp, 20);
      assert.equal(items.listContainerItems(90001, 60000003, 4).reduce((sum, item) => sum + item.quantity, 0), initialLoad+500);
      if(partial)assert.equal(items.listContainerItems(90001,60000001,4).filter(i=>i.typeID===34).reduce((n,i)=>n+i.quantity,0),reserve);
    }
  }
  assert.equal((await database.shutdown("standing-order-restart")).success, true);
}
main().catch(async (error) => { console.error(error); await database.shutdown("failed-fixture"); process.exitCode = 1; });
