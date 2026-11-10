"use strict";
const { createIsolatedGameStore } = require("./helpers/isolatedGameStore"); const store = createIsolatedGameStore();
const { seedRefiningStatic, fundPilot } = require("./helpers/refiningCrewFixture"); seedRefiningStatic(store);
const test = require("node:test"), assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process"), path = require("node:path");
const database = require("../src/gameStore"), items = require("../src/services/inventory/itemStore");
const { createTableRepository } = require("../src/gameStore/tableRepository");
const { createCrewService } = require("../src/services/crew/crewService");
const { createCrewWorld } = require("../src/services/crew/crewRuntime");
const { createCrewInventory } = require("../src/services/crew/crewInventory");
const { createMiningCrewService } = require("../src/services/crew/miningCrewService");
const { createMiningCrewResources } = require("../src/services/crew/miningCrewResources");
const { createFiniteScenes } = require("./helpers/miningCrewFixture");
const { createRefiningCrewService } = require("../src/services/crew/refiningCrewService");
const { createRefiningCrewInventory } = require("../src/services/crew/refiningCrewInventory");
const settlements = require("../src/services/reprocessing/reprocessingSettlementState");
const wallet = require("../src/services/account/walletState");
const worldData = require("../src/space/worldData"), scenes = createFiniteScenes();
let clock = 0, sequence = 0;
const courier = createCrewService({ repo: createTableRepository("service:crew"), inventory: createCrewInventory({ items }),
  world: createCrewWorld(worldData), character: id => database.read("characters", `/${id}`).data, now: () => clock, legMs: 1000 });
const mining = createMiningCrewService({ repo: createTableRepository("service:crew-mining"), crew: id => courier.snapshot(id),
  resources: createMiningCrewResources({ worldData, items, sceneForSystem: scenes.sceneForSystem }), now: () => clock, cycleMs: 1000, travelMs: 1000 });
const inventory = createRefiningCrewInventory({ items, worldData });
const make = (overrides = {}) => createRefiningCrewService({ repo: createTableRepository("service:crew-refining"), inventory,
  crew: id => courier.snapshot(id), now: () => clock, cycleMs: 1000, ...overrides });
const service = make();
const order = (runtime, id, type, payload = {}) => ({ commandID: `refining-test:${++sequence}`, expectedRevision: runtime.snapshot(id).revision, type, payload });
function establish(id, balance) { fundPilot(database, items, id, balance); courier.submit(id, order(courier, id, "create", { name: "Industrial crew" })); }
const grantOre = (id, quantity, typeID = 1230) => items.grantItemToOwnerLocation(id, 60000001, 4, typeID, quantity);
const qty = (id, typeID, station = 60000001, flag = 4) => items.listContainerItems(id, station, flag).filter(i => i.typeID === typeID).reduce((sum, i) => sum + i.quantity, 0);
const start = (id, runtime = service, extra = {}) => runtime.submit(id, order(runtime, id, "start", { stationID: 60000001, typeID: 1230, oreReserve: 0, ...extra }));
async function tick(time, runtime = service, errors = 0) { clock = time; const result = await runtime.tick({ budgetMs: 1000 }); assert.equal(result.errors.length, errors, JSON.stringify(result)); }
test.after(async () => { await service.drain(); clearInterval(require.cache[require.resolve("../src/space/runtime")]?.exports?._tickHandle);
  await new Promise(resolve => setImmediate(resolve)); assert.equal((await database.shutdown("refining-tests")).success, true);
  require("../src/gameStore/sqliteStore").close(); await require("../src/utils/rotatingLog").closeAll(); store.cleanup(); });

test("native refining reserves ore, charges the quoted tax and returns incomplete portions", async () => {
  establish(90300); grantOre(90300, 1049); const before = wallet.getCharacterWallet(90300).balance;
  const result = await start(90300); assert.equal(result.refining.job.phase, "working");
  assert.equal(qty(90300, 1230), 0); assert.equal(qty(90300, 1230, result.refining.escrowLocationID, 5), 1049);
  const cost = result.refining.job.quote.totalCost; assert.equal(cost, 200);
  await tick(1000); const state = service.snapshot(90300).refining;
  assert.equal(state.totalOreProcessed, 1000); assert.equal(state.completedBatches, 1); assert.equal(state.job, null);
  assert.equal(qty(90300, 1230), 49); assert.equal(qty(90300, 34), 3000);
  assert.equal(wallet.getCharacterWallet(90300).balance, before - cost);
  assert.equal(service.universeFacts({ ownerID: 90300 }).recentEvents[0].type, "ore_refined");
});

test("finite mining feeds refining, mineral hauling and the native manufacturing material view", async () => {
  clock = 10000; establish(90301); scenes.add(40001, 2500);
  mining.submit(90301, order(mining, 90301, "start", { homeStationID: 60000001, beltID: 40001, typeID: 1230 }));
  await start(90301);
  courier.submit(90301, order(courier, 90301, "automate", { sourceStationID: 60000001, destinationStationID: 60000003, typeID: 34, sourceReserve: 1000 }));
  for (let time = 11000; time <= 50000; time += 1000) {
    clock = time; assert.deepEqual(mining.tick({ budgetMs: 1000 }).errors, []); await tick(time); assert.deepEqual(courier.tick({ budgetMs: 1000 }).errors, []);
  }
  assert.equal(service.snapshot(90301).refining.totalOreProcessed, 2500); assert.equal(qty(90301, 1230), 0);
  assert.equal(qty(90301, 34), 1000); assert.equal(qty(90301, 34, 60000003), 5000);
  const industry = require("../src/services/industry/industryRuntimeState");
  const materials = industry.resolveAvailableMaterials(90301, { itemID: 60000003, flagID: 4 });
  assert.equal(materials[34], 5000, "Manufacturing must see the delivered native minerals");
  assert.equal(service.snapshot(90301).refining.status, "waiting_for_ore");
});

test("lost native completion reply cannot double charge, consume or recreate moved output", async () => {
  clock = 60000; establish(90302); grantOre(90302, 1000); let fault = true;
  const runtime = make({ inventory: { ...inventory, async settle(state) { const result = await inventory.settle(state); if (fault) { fault = false; throw new Error("After native completion"); } return result; } } });
  const accepted = await start(90302, runtime); const before = wallet.getCharacterWallet(90302).balance;
  await tick(61000, runtime, 1); const balance = wallet.getCharacterWallet(90302).balance;
  assert.equal(balance, before - 200); const oreState = runtime.snapshot(90302).refining;
  assert.equal(oreState.job.phase, "settling"); assert.equal(settlements.getPendingReprocessingSettlement(90302), null);
  const trit = items.listContainerItems(90302, 60000001, 4).find(i => i.typeID === 34 && i.quantity === 2000);
  assert.ok(trit); items.moveItemToLocation(trit.itemID, 60000003, 4); database.flushTableSync("items");
  await tick(62000, runtime); assert.equal(wallet.getCharacterWallet(90302).balance, balance);
  assert.equal(qty(90302, 34, 60000003), 2000); assert.equal(qty(90302, 1230), 0);
  assert.equal(runtime.snapshot(90302).refining.completedBatches, 1);
  assert.equal((await runtime.submit(90302, { commandID: "replay-after-cleanup", expectedRevision: accepted.revision, type: "pause", payload: {} }).catch(e => e)).code, "CREW_REVISION_CONFLICT");
});

test("insufficient funds leaves ore available and resumes automatically when income arrives", async () => {
  clock = 70000; establish(90303, 0); grantOre(90303, 1000); await start(90303); await tick(71000);
  const state = service.snapshot(90303).refining;
  assert.equal(state.status, "insufficient_funds"); assert.equal(state.plan.enabled, true); assert.equal(state.job, null);
  assert.equal(qty(90303, 1230), 1000); assert.equal(qty(90303, 34), 1000); assert.equal(state.totalOreProcessed, 0);
  await wallet.adjustCharacterBalanceAsync(90303, 200, { description: "Crew sale income" });
  await tick(75000); await tick(76000);
  assert.equal(service.snapshot(90303).refining.totalOreProcessed, 1000);
  assert.equal(wallet.getCharacterWallet(90303).balance, 0);
});

test("pause freezes the cycle; stop finishes its reserved batch and starts no other", async () => {
  clock = 80000; establish(90304); grantOre(90304, 1000);
  const command = order(service, 90304, "start", { stationID: 60000001, typeID: 1230, oreReserve: 0 });
  await service.submit(90304, command); assert.equal((await service.submit(90304, command)).replayed, true);
  grantOre(90304, 1000);
  await service.submit(90304, order(service, 90304, "pause")); await tick(90000);
  assert.equal(service.snapshot(90304).refining.totalOreProcessed, 0);
  await service.submit(90304, order(service, 90304, "stop")); await tick(91000);
  assert.equal(service.snapshot(90304).refining.totalOreProcessed, 1000); assert.equal(qty(90304, 1230), 1000);
  await tick(100000); assert.equal(service.snapshot(90304).refining.completedBatches, 1);
});

test("invalid facilities, non-ore recipes and forged order fields fail before taking input", async () => {
  clock = 110000; establish(90305); grantOre(90305, 1000);
  await assert.rejects(start(90305, service, { stationID: 60000099 }), { code: "CREW_STATION_INVALID" });
  await assert.rejects(start(90305, service, { typeID: 34 }), { code: "CREW_CARGO_INVALID" });
  const bad = order(service, 90305, "start", { stationID: 60000001, typeID: 1230, oreReserve: 0, ownerID: 90300 });
  await assert.rejects(service.submit(90305, bad), { code: "CREW_COMMAND_INVALID" }); assert.equal(qty(90305, 1230), 1000);
});

test("mixed ore recovers all fixed minerals, rounds portions and respects source reserves", async () => {
  clock = 120000; establish(90306); grantOre(90306, 250, 1228);
  const result = await start(90306, service, { typeID: 1228 }); assert.equal(result.refining.job.quote.quantityToProcess, 200);
  await tick(121000); assert.equal(qty(90306, 35), 90); assert.equal(qty(90306, 34), 1150); assert.equal(qty(90306, 1228), 50);
  establish(90307); grantOre(90307, 1000); await start(90307, service, { oreReserve: 1000 });
  await tick(130000); assert.equal(qty(90307, 1230), 1000); assert.equal(service.snapshot(90307).refining.status, "waiting_for_ore");
  await service.submit(90307, order(service, 90307, "stop"));
});

test("100 refining batches retire native custody receipts and keep one completion watermark", async () => {
  clock = 140000; establish(90308); await start(90308);
  for (let i = 0; i < 100; i++) {
    grantOre(90308, 1000); await tick(150000 + i * 10000); await tick(151000 + i * 10000);
  }
  const state = service.snapshot(90308).refining;
  assert.equal(state.completedBatches, 100); assert.equal(state.history.length, 20); assert.equal(state.totalOreProcessed, 100000);
  assert.equal(qty(90308, 34), 201000); assert.equal(wallet.getCharacterWallet(90308).balance, 80000);
  assert.equal(service.snapshot(90308).commandCapacityRemaining, 1023);
  const root = database.read("reprocessingSettlements", "/").data;
  assert.equal(root.byCharacter[90308], undefined); assert.equal(root.crewReceipts[90308].serial, 100);
  assert.equal(root.crewReceipts[90308].custodyKeys, undefined);
  assert.equal(items.getIdempotentGrantReceipt(`crew-refine:${state.history[0].jobID}:reserve`).found, false);
});

test("a refinery takes capacity-limited portions from a large stack without crossing its ore reserve", async () => {
  clock=2000000;const id=90309;establish(id);grantOre(id,25049);
  const runtime=make({batchM3:100});
  await start(id,runtime,{oreReserve:49});
  assert.equal(runtime.snapshot(id).refining.job.cargo.quantity,1000);
  for(let i=1;i<=50;i++)await tick(2000000+i*1000,runtime);
  const s=runtime.snapshot(id).refining;
  assert.equal(s.totalOreProcessed,25000);assert.equal(qty(id,1230),49);
  assert.equal(s.totalTaxPaid,5000);assert.equal(wallet.getCharacterWallet(id).balance,95000);
  await runtime.submit(id,order(runtime,id,"stop"));
});

test("a tax debit race returns ore and retries the standing order when funds recover", async () => {
  clock=2100000;const id=90310;establish(id);grantOre(id,1000);let fault=true;
  const runtime=make({inventory:{...inventory,async settle(s){if(fault){fault=false;await wallet.adjustCharacterBalanceAsync(id,-100000,{description:"Concurrent expense"});}return inventory.settle(s);}}});
  await start(id,runtime);await tick(2101000,runtime);
  assert.equal(runtime.snapshot(id).refining.plan.enabled,true);
  assert.equal(runtime.snapshot(id).refining.status,"insufficient_funds");assert.equal(qty(id,1230),1000);
  await wallet.adjustCharacterBalanceAsync(id,200,{description:"Income"});
  await tick(2107000,runtime);await tick(2108000,runtime);
  assert.equal(runtime.snapshot(id).refining.totalOreProcessed,1000);assert.equal(wallet.getCharacterWallet(id).balance,0);
  await runtime.submit(id,order(runtime,id,"stop"));
});

test("separate processes recover whole and fragmented batches after custody, tax, output and receipt faults", () => {
  for (const mode of ["whole", "fragmented"]) for (const fault of ["reserve", "debit", "output", "completion", "remainder", "ack"]) {
    const isolated = createIsolatedGameStore({ activate: false }); seedRefiningStatic(isolated);
    try {
      for (const phase of ["fail", "recover"]) {
        const result = spawnSync(process.execPath, [path.join(__dirname, "fixtures/refiningCrewRestart.cjs"), phase, fault, mode], {
          env: { ...process.env, ...isolated.env }, encoding: "utf8", windowsHide: true, timeout: 30000 });
        assert.equal(result.status, 0, `${mode}/${fault}/${phase}: ${result.stdout}\n${result.stderr}`);
      }
    } finally { isolated.cleanup(); }
  }
});
