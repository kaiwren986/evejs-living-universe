"use strict";
const assert = require("node:assert/strict");
const database = require("../../src/gameStore"), items = require("../../src/services/inventory/itemStore");
const { createTableRepository } = require("../../src/gameStore/tableRepository");
const { createCrewService } = require("../../src/services/crew/crewService");
const { createCrewWorld } = require("../../src/services/crew/crewRuntime");
const { createCrewInventory } = require("../../src/services/crew/crewInventory");
const { createManufacturingCrewService } = require("../../src/services/crew/manufacturingCrewService");
const { createManufacturingCrewIndustry } = require("../../src/services/crew/manufacturingCrewIndustry");
const { fundManufacturingPilot } = require("../helpers/manufacturingCrewFixture");
const wallet = require("../../src/services/account/walletState"), native = require("../../src/services/industry/industryRuntimeState");
const custody = require("../../src/services/inventory/industryInstallItemCustody");
const worldData = require("../../src/space/worldData"), [phase, fault] = process.argv.slice(2);
let clock = 0, pending = phase === "fail";
const courier = createCrewService({ repo: createTableRepository("service:crew"), inventory: createCrewInventory({ items }),
  world: createCrewWorld(worldData), character: id => database.read("characters", `/${id}`).data, now: () => clock });
const industry = createManufacturingCrewIndustry({ items, worldData, profitability: require("../helpers/nativeIndustryProfitFixture") });
const method = { debit: "stageMaterial", staged: "stageMaterial", committed: "commitMaterial", blueprint: "installBlueprint" }[fault];
if (method) {
  const original = custody[method];
  custody[method] = (...args) => {
    if (fault === "debit" && pending) { pending = false; throw new Error("After debit, before custody"); }
    const result = original(...args); if (pending) { pending = false; throw new Error(`After ${method}`); } return result;
  };
} else {
  const name = { starter: "starter", installed: "install", delivered: "deliver", ack: "acknowledge" }[fault], original = industry[name];
  if (name === "install") industry[name] = async (...args) => { const result = await original(...args); if (pending) { pending = false; throw new Error("After install"); } return result; };
  else industry[name] = (...args) => { const result = original(...args); if (pending) { pending = false; throw new Error(`After ${name}`); } return result; };
}
const service = createManufacturingCrewService({ repo: createTableRepository("service:crew-manufacturing"), industry,
  crew: id => courier.snapshot(id), now: () => clock });
const order = (type, payload = {}) => ({ commandID: type, expectedRevision: service.snapshot(90001).revision, type, payload });
const qty = (typeID, location = 60000001) => items.listContainerItems(90001, location, 4).filter(i => i.typeID === typeID).reduce((sum, i) => sum + i.quantity, 0);
async function start() {
  const blueprint = service.catalog(90001, 60000001).find(b => b.productTypeID === 21857);
  return service.submit(90001, order("start", { stationID: 60000001, orders: [{ blueprintID: blueprint.blueprintID, runs: 1, targetStock: 1 }] }));
}
async function main() {
  if (phase === "fail") {
    fundManufacturingPilot(database, items);
    courier.submit(90001, { commandID: "crew", expectedRevision: 0, type: "create", payload: { name: "Persistent factory" } });
    const starter = service.submit(90001, order("starter", { stationID: 60000001 }));
    if (fault === "starter") await assert.rejects(starter);
    else {
      await starter;
      if (["debit", "staged", "committed", "blueprint", "installed"].includes(fault)) await assert.rejects(start());
      else {
        await start(); await service.submit(90001, order("pause"));
        native.markIndustryJobReady(service.snapshot(90001).manufacturing.job.nativeJobID); clock = 1000;
        assert.equal((await service.tick({ budgetMs: 1000 })).errors.length, 1);
      }
      const output = items.listContainerItems(90001, 60000001, 4).find(i => i.typeID === 21857);
      if (output) { items.moveItemToLocation(output.itemID, 60000003, 4); database.flushTableSync("items"); }
    }
    assert.equal(pending, false, `Fault ${fault} was not reached`);
  } else {
    clock = 10000; assert.deepEqual((await service.tick({ budgetMs: 1000 })).errors, []);
    if (fault === "starter") { assert.equal(service.catalog(90001, 60000001).length, 2); await start(); }
    const job = service.snapshot(90001).manufacturing.job;
    if (job) native.markIndustryJobReady(job.nativeJobID);
    for (let i = 0; i < 3; i++) { clock += 1000; assert.deepEqual((await service.tick({ budgetMs: 1000 })).errors, []); }
    const state = service.snapshot(90001).manufacturing, jobs = native.listJobsByOwner(90001, true);
    assert.equal(state.completedBatches, 1); assert.equal(state.job, null); assert.equal(jobs.length, 1);
    assert.equal(state.skill.xp, 10, "Native replay must not duplicate manufacturing experience");
    assert.equal(qty(34), 933); assert.equal(qty(21857) + qty(21857, 60000003), 1);
    assert.equal(wallet.getCharacterWallet(90001).balance, 100000 - state.totalFeesPaid);
    assert.equal(service.catalog(90001, 60000001).length, 2);
    assert.equal(items.getIdempotentGrantReceipt(`evejsIndustryOutput:${jobs[0].deliveryReceiptID}:v2`).found, false);
    const root = database.read("industryInstallSettlements", "/").data;
    assert.equal(root.byCharacter[90001], undefined); assert.equal(root.crewReceipts[90001].custodyKeys, undefined);
  }
  await service.drain(); clearInterval(require.cache[require.resolve("../../src/space/runtime")]?.exports?._tickHandle);
  await new Promise(resolve => setImmediate(resolve)); assert.equal((await database.shutdown("manufacturing-restart")).success, true);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
