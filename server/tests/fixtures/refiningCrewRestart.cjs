"use strict";
const assert = require("node:assert/strict");
const database = require("../../src/gameStore"), items = require("../../src/services/inventory/itemStore");
const { createTableRepository } = require("../../src/gameStore/tableRepository");
const { createCrewService } = require("../../src/services/crew/crewService");
const { createCrewWorld } = require("../../src/services/crew/crewRuntime");
const { createCrewInventory } = require("../../src/services/crew/crewInventory");
const { createRefiningCrewService } = require("../../src/services/crew/refiningCrewService");
const { createRefiningCrewInventory } = require("../../src/services/crew/refiningCrewInventory");
const { fundPilot } = require("../helpers/refiningCrewFixture");
const wallet = require("../../src/services/account/walletState");
const custody = require("../../src/services/inventory/reprocessingItemCustody");
const worldData = require("../../src/space/worldData"), [phase, fault, mode] = process.argv.slice(2);
const fragmented = mode === "fragmented", refined = fragmented ? 100 : 1000, outputAmount = refined * 2;
let clock = 0, pending = phase === "fail";
const courier = createCrewService({ repo: createTableRepository("service:crew"), inventory: createCrewInventory({ items }),
  world: createCrewWorld(worldData), character: id => database.read("characters", `/${id}`).data, now: () => clock, legMs: 1000 });
const inventory = createRefiningCrewInventory({ items, worldData });
if (fault === "debit" || fault === "output") {
  const method = fault === "debit" ? "stageInput" : "commitInput", original = custody[method];
  custody[method] = (...args) => { if (pending) { pending = false; throw new Error(`Before ${method}`); } return original(...args); };
} else {
  const method = { reserve: "reserve", completion: "settle", remainder: "returnRemainder", ack: "acknowledge" }[fault];
  const original = inventory[method];
  inventory[method] = async (...args) => { const result = await original(...args); if (pending) { pending = false; throw new Error(`After ${method}`); } return result; };
  // The synchronous inventory phases must throw before their caller checkpoints.
  if (method !== "settle") inventory[method] = (...args) => { const result = original(...args); if (pending) { pending = false; throw new Error(`After ${method}`); } return result; };
}
const service = createRefiningCrewService({ repo: createTableRepository("service:crew-refining"), inventory,
  crew: id => courier.snapshot(id), now: () => clock, cycleMs: 1000 });
const qty = (typeID, location = 60000001) => items.listContainerItems(90001, location, 4).filter(i => i.typeID === typeID).reduce((sum, i) => sum + i.quantity, 0);
async function main() {
  if (phase === "fail") {
    fundPilot(database, items);
    if (fragmented) {
      const first = items.grantItemToOwnerLocation(90001, 60000001, 4, 1230, 75).data.items[0];
      items.moveItemToLocation(first.itemID, 60000002, 4);
      items.grantItemToOwnerLocation(90001, 60000001, 4, 1230, 74);
      items.moveItemToLocation(first.itemID, 60000001, 4);
    } else items.grantItemToOwnerLocation(90001, 60000001, 4, 1230, 1049);
    courier.submit(90001, { commandID: "create", expectedRevision: 0, type: "create", payload: { name: "Persistent refinery" } });
    const order = { commandID: "refine", expectedRevision: 0, type: "start", payload: { stationID: 60000001, typeID: 1230, oreReserve: 0 } };
    if (fault === "reserve") await assert.rejects(service.submit(90001, order));
    else {
      await service.submit(90001, order); clock = 1000;
      assert.equal((await service.tick({ budgetMs: 1000 })).errors.length, 1);
    }
    const output = items.listContainerItems(90001, 60000001, 4).find(i => i.typeID === 34 && i.quantity === outputAmount);
    if (output) { items.moveItemToLocation(output.itemID, 60000003, 4); database.flushTableSync("items"); }
  } else {
    clock = 10000; assert.equal((await service.tick({ budgetMs: 1000 })).errors.length, 0);
    clock = 11000; assert.equal((await service.tick({ budgetMs: 1000 })).errors.length, 0);
    const state = service.snapshot(90001).refining;
    assert.equal(state.completedBatches, 1); assert.equal(state.totalOreProcessed, refined);
    assert.equal(state.skill.xp, 10, "Native replay must not duplicate refining experience");
    assert.equal(qty(1230), 49); assert.equal(qty(34) + qty(34, 60000003), 1000 + outputAmount);
    assert.equal(wallet.getCharacterWallet(90001).balance, 100000 - refined * 0.2);
    assert.equal(state.roster[0].actorID, "refining:90001:member:0");
    assert.equal(items.getIdempotentGrantReceipt(`crew-refine:${state.history[0].jobID}:reserve`).found, false);
  }
  await service.drain(); clearInterval(require.cache[require.resolve("../../src/space/runtime")]?.exports?._tickHandle);
  await new Promise(resolve => setImmediate(resolve)); assert.equal((await database.shutdown("refinery-restart")).success, true);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
