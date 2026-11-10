"use strict";
const { createIsolatedGameStore } = require("./helpers/isolatedGameStore"); const store = createIsolatedGameStore();
const { seedManufacturingStatic, fundManufacturingPilot } = require("./helpers/manufacturingCrewFixture"); seedManufacturingStatic(store);
const test = require("node:test"), assert = require("node:assert/strict");
const database = require("../src/gameStore"), items = require("../src/services/inventory/itemStore");
const { createTableRepository } = require("../src/gameStore/tableRepository");
const { createCrewService } = require("../src/services/crew/crewService");
const { createCrewWorld } = require("../src/services/crew/crewRuntime");
const { createCrewInventory } = require("../src/services/crew/crewInventory");
const { createManufacturingCrewService } = require("../src/services/crew/manufacturingCrewService");
const { createManufacturingCrewIndustry } = require("../src/services/crew/manufacturingCrewIndustry");
const native = require("../src/services/industry/industryRuntimeState"), wallet = require("../src/services/account/walletState");
const worldData = require("../src/space/worldData"); let clock = 0, sequence = 0;
const courier = createCrewService({ repo: createTableRepository("service:crew"), inventory: createCrewInventory({ items }),
  world: createCrewWorld(worldData), character: id => database.read("characters", `/${id}`).data, now: () => clock, legMs: 1000 });
const industry = createManufacturingCrewIndustry({ items, worldData, profitability: require("./helpers/nativeIndustryProfitFixture") });
const make = (overrides = {}) => createManufacturingCrewService({ repo: createTableRepository("service:crew-manufacturing"), industry,
  crew: id => courier.snapshot(id), now: () => clock, ...overrides });
const service = make();
const order = (runtime, id, type, payload = {}) => ({ commandID: `manufacturing-test:${++sequence}`, expectedRevision: runtime.snapshot(id).revision, type, payload });
async function establish(id, balance) { fundManufacturingPilot(database, items, id, balance); courier.submit(id, order(courier, id, "create", { name: "Factory logistics" }));
  await service.submit(id, order(service, id, "starter", { stationID: 60000001 })); return service.catalog(id, 60000001); }
const qty = (id, typeID, station = 60000001) => items.listContainerItems(id, station, 4).filter(i => i.typeID === typeID).reduce((sum, i) => sum + i.quantity, 0);
const plan = (blueprint, targetStock = 1) => ({ blueprintID: blueprint.blueprintID, runs: 1, targetStock });
const start = (id, orders, runtime = service) => runtime.submit(id, order(runtime, id, "start", { stationID: 60000001, orders }));
async function tick(time, runtime = service, errors = 0) { clock = time; const result = await runtime.tick({ budgetMs: 1000 }); assert.equal(result.errors.length, errors, JSON.stringify(result)); }
function ready(id, runtime = service) { const job = runtime.snapshot(id).manufacturing.job; assert.ok(job); assert.equal(native.markIndustryJobReady(job.nativeJobID).success, true); }
test.after(async () => { await service.drain(); clearInterval(require.cache[require.resolve("../src/space/runtime")]?.exports?._tickHandle);
  await new Promise(resolve => setImmediate(resolve)); await database.shutdown("manufacturing-tests"); require("../src/gameStore/sqliteStore").close();
  await require("../src/utils/rotatingLog").closeAll(); store.cleanup(); });

test("one-time starter blueprints persist without duplication or resetting an installed blueprint", async () => {
  const catalog = await establish(90400); assert.equal(catalog.length, 2);
  await service.submit(90400, order(service, 90400, "starter", { stationID: 60000001 }));
  assert.equal(service.catalog(90400, 60000001).length, 2);
  const module = catalog.find(b => b.productTypeID === 21857); await start(90400, [plan(module)]);
  const installed = native.getBlueprintState(module.blueprintID).jobID;
  await service.submit(90400, order(service, 90400, "starter", { stationID: 60000001 }));
  assert.equal(native.getBlueprintState(module.blueprintID).jobID, installed);
  ready(90400); await tick(1000); assert.equal(qty(90400, 21857), 1);
});

test("an installation fee race waits for income and retries without disabling the production queue", async () => {
  clock=5000;const id=90415,catalog=await establish(id);let fault=true;
  const runtime=make({industry:{...industry,async install(job){if(fault){fault=false;await wallet.adjustCharacterBalanceAsync(id,-100000,{description:"Concurrent expense"});}return industry.install(job);}}});
  await start(id,[plan(catalog.find(b=>b.productTypeID===21857))],runtime);
  assert.equal(runtime.snapshot(id).manufacturing.plan.enabled,true);
  assert.equal(runtime.snapshot(id).manufacturing.status,"insufficient_funds");
  assert.equal(qty(id,34),1000);assert.equal(wallet.getCharacterWallet(id).balance,0);
  await wallet.adjustCharacterBalanceAsync(id,100,{description:"Crew sale income"});await tick(10000,runtime);
  assert.equal(runtime.snapshot(id).manufacturing.job.phase,"building");
  ready(id,runtime);await tick(11000,runtime);assert.equal(qty(id,21857),1);
});

test("native jobs consume minerals and fees once, wait for readiness, deliver products and return blueprints", async () => {
  clock = 10000; const catalog = await establish(90401), module = catalog.find(b => b.productTypeID === 21857);
  const before = wallet.getCharacterWallet(90401).balance; const accepted = await start(90401, [plan(module)]);
  assert.equal(accepted.manufacturing.job.phase, "building"); assert.equal(qty(90401, 34), 933);
  assert.equal(qty(90401, 21857), 0); assert.equal(items.findItemById(module.blueprintID).locationID, 2003);
  const cost = accepted.manufacturing.job.summary.cost; assert.equal(wallet.getCharacterWallet(90401).balance, before - cost);
  await tick(11000); assert.equal(qty(90401, 21857), 0);
  ready(90401); await tick(12000); assert.equal(qty(90401, 21857), 1);
  assert.equal(items.findItemById(module.blueprintID).locationID, 60000001); assert.equal(native.getBlueprintState(module.blueprintID).jobID, null);
  await tick(13000); assert.equal(service.snapshot(90401).manufacturing.status, "stock_target_met");
});

test("a missing ammo mineral does not block modules; restocking resumes ammo and honors product targets", async () => {
  clock = 20000; const catalog = await establish(90402), ammo = catalog.find(b => b.productTypeID === 215), module = catalog.find(b => b.productTypeID === 21857);
  await start(90402, [plan(ammo, 100), plan(module)]); assert.equal(service.snapshot(90402).manufacturing.job.summary.productTypeID, 21857);
  ready(90402); await tick(21000); await tick(22000); assert.equal(service.snapshot(90402).manufacturing.status, "waiting_for_materials");
  items.grantItemToOwnerLocation(90402, 60000001, 4, 35, 21); await tick(28000);
  assert.equal(service.snapshot(90402).manufacturing.job.summary.productTypeID, 215); ready(90402); await tick(29000); await tick(30000);
  assert.equal(qty(90402, 215), 100); assert.equal(qty(90402, 35), 0); assert.equal(service.snapshot(90402).manufacturing.status, "stock_target_met");
});

test("a lost installation reply cannot install a duplicate job or pay twice", async () => {
  clock = 40000; const catalog = await establish(90403); let fault = true;
  const runtime = make({ industry: { ...industry, async install(job) { const result = await industry.install(job); if (fault) { fault = false; throw new Error("After native installation"); } return result; } } });
  await assert.rejects(start(90403, [plan(catalog.find(b => b.productTypeID === 21857))], runtime));
  const before = wallet.getCharacterWallet(90403).balance, jobs = native.listJobsByOwner(90403, true).length;
  await tick(41000, runtime); assert.equal(wallet.getCharacterWallet(90403).balance, before); assert.equal(native.listJobsByOwner(90403, true).length, jobs);
  ready(90403, runtime); await tick(42000, runtime); assert.equal(qty(90403, 21857), 1);
});

test("pause and stop prevent new work while collecting the accepted native job", async () => {
  clock = 50000; const catalog = await establish(90404); await start(90404, [plan(catalog.find(b => b.productTypeID === 21857), 3)]);
  await service.submit(90404, order(service, 90404, "pause")); ready(90404); await tick(51000);
  assert.equal(qty(90404, 21857), 1); await tick(60000); assert.equal(service.snapshot(90404).manufacturing.job, null);
  await service.submit(90404, order(service, 90404, "stop")); await tick(70000); assert.equal(qty(90404, 21857), 1);
});

test("a lost delivery reply does not recall products moved onward or count another batch", async () => {
  clock = 80000; const catalog = await establish(90405); let fault = true;
  const runtime = make({ industry: { ...industry, deliver(job) { const result = industry.deliver(job); if (fault) { fault = false; throw new Error("After native delivery"); } return result; } } });
  await start(90405, [plan(catalog.find(b => b.productTypeID === 21857))], runtime); ready(90405, runtime); await tick(81000, runtime, 1);
  const output = items.listContainerItems(90405, 60000001, 4).find(i => i.typeID === 21857); assert.ok(output);
  items.moveItemToLocation(output.itemID, 60000003, 4); database.flushTableSync("items");
  await tick(82000, runtime); assert.equal(runtime.snapshot(90405).manufacturing.completedBatches, 1);
  assert.equal(qty(90405, 21857, 60000003), 1); assert.equal(qty(90405, 21857), 0);
});

test("blueprint copies consume their licensed run without granting another copy or product", async () => {
  clock = 90000; await establish(90406);
  const copy = native.seedBlueprintForOwner(90406, 60000001, { blueprintTypeID: 21858, original: false, runsRemaining: 1 });
  assert.equal(copy.success, true); const b = industry.describe(90406, 60000001, copy.data.item.itemID);
  await start(90406, [plan(b, 2)]); ready(90406); await tick(91000); await tick(92000);
  assert.equal(qty(90406, 21857), 1); assert.equal(items.findItemById(b.blueprintID), null);
  assert.equal(service.snapshot(90406).manufacturing.status, "blueprint_unavailable");
});

test("foreign blueprints, non-factories, forged payloads and stale revisions cannot consume minerals", async () => {
  clock = 100000; const a = await establish(90407), b = await establish(90408);
  await assert.rejects(start(90407, [plan(b[0])]), { code: "CREW_CARGO_INVALID" });
  await assert.rejects(service.submit(90407, order(service, 90407, "start", { stationID: 60000099, orders: [plan(a[0])] })), { code: "CREW_STATION_INVALID" });
  await assert.rejects(service.submit(90407, order(service, 90407, "start", { stationID: 60000001, orders: [{ ...plan(a[0]), productTypeID: 34 }] })), { code: "CREW_COMMAND_INVALID" });
  await assert.rejects(service.submit(90407, { ...order(service, 90407, "pause"), expectedRevision: 99999 }), { code: "CREW_REVISION_CONFLICT" });
  assert.equal(qty(90407, 34), 1000);
});

test("the native completion clock advances while the manufacturing owner is offline", async () => {
  clock = 110000; const catalog = await establish(90409); await start(90409, [plan(catalog.find(b => b.productTypeID === 21857))]);
  assert.equal(qty(90409, 21857), 0);
  await new Promise(resolve => setTimeout(resolve, 2100));
  const recovered = make(); await tick(111000, recovered); assert.equal(qty(90409, 21857), 1);
});

test("mining, refining and mixed-mineral hauling feed real ammo and module jobs", async () => {
  clock = 120000; const catalog = await establish(90410);
  const { createFiniteScenes } = require("./helpers/miningCrewFixture"), scenes = createFiniteScenes(); scenes.add(40010, 1000, 1228);
  const miners = require("../src/services/crew/miningCrewService").createMiningCrewService({ repo: createTableRepository("service:crew-mining"),
    resources: require("../src/services/crew/miningCrewResources").createMiningCrewResources({ worldData, items, sceneForSystem: scenes.sceneForSystem }),
    crew: id => courier.snapshot(id), now: () => clock, cycleMs: 1000, travelMs: 1000, batchM3: 150 });
  const refiners = require("../src/services/crew/refiningCrewService").createRefiningCrewService({ repo: createTableRepository("service:crew-refining"),
    inventory: require("../src/services/crew/refiningCrewInventory").createRefiningCrewInventory({ items, worldData }),
    crew: id => courier.snapshot(id), now: () => clock, cycleMs: 1000 });
  miners.submit(90410, order(miners, 90410, "start", { homeStationID: 60000001, beltID: 40010, typeID: 1228 }));
  await refiners.submit(90410, order(refiners, 90410, "start", { stationID: 60000001, typeID: 1228, oreReserve: 0 }));
  courier.submit(90410, order(courier, 90410, "automate", { sourceStationID: 60000001, destinationStationID: 60000003, typeID: 34, typeIDs: [34, 35], sourceReserve: 0 }));
  const blueprintIDs = catalog.map(b => b.blueprintID);
  for (const id of blueprintIDs) items.moveItemToLocation(id, 60000003, 4); database.flushTableSync("items");
  await service.submit(90410, order(service, 90410, "start", { stationID: 60000003, orders: catalog.map(b => plan(b, b.productTypeID === 215 ? 100 : 1)) }));
  for (let time = 121000; time <= 150000; time += 1000) {
    clock = time; assert.deepEqual(miners.tick({ budgetMs: 1000 }).errors, []); assert.deepEqual((await refiners.tick({ budgetMs: 1000 })).errors, []);
    assert.deepEqual(courier.tick({ budgetMs: 1000 }).errors, []); const current = service.snapshot(90410).manufacturing.job;
    if (current?.phase === "building") native.markIndustryJobReady(current.nativeJobID);
    await tick(time);
  }
  assert.equal(qty(90410, 215, 60000003), 100); assert.equal(qty(90410, 21857, 60000003), 1);
  assert.equal(refiners.snapshot(90410).refining.totalOreProcessed, 1000);
  assert.equal(qty(90410, 35, 60000003), 429);
  assert.equal(qty(90410, 34, 60000003), 1656);
  assert.equal(service.snapshot(90410).manufacturing.status, "stock_target_met");
});

test("100 factory batches retire custody receipts and retain a bounded crew history", async () => {
  clock = 200000; const catalog = await establish(90411);
  items.grantItemToOwnerLocation(90411, 60000001, 4, 34, 10000);
  await start(90411, [plan(catalog.find(b => b.productTypeID === 21857), 100)]);
  for (let i = 0; i < 400 && service.snapshot(90411).manufacturing.completedBatches < 100; i++) {
    const job = service.snapshot(90411).manufacturing.job;
    if (job?.phase === "building") native.markIndustryJobReady(job.nativeJobID);
    await tick(201000 + i * 1000);
  }
  const state = service.snapshot(90411).manufacturing;
  assert.equal(state.completedBatches, 100); assert.equal(state.history.length, 20);
  assert.equal(qty(90411, 21857), 100); assert.equal(qty(90411, 34), 4300);
  assert.equal(wallet.getCharacterWallet(90411).balance, 100000 - state.totalFeesPaid);
  const root = database.read("industryInstallSettlements", "/").data;
  assert.equal(root.byCharacter[90411], undefined); assert.equal(root.crewReceipts[90411].serial, 100);
  assert.equal(root.crewReceipts[90411].custodyKeys, undefined);
  for (const job of native.listJobsByOwner(90411, true)) assert.equal(items.getIdempotentGrantReceipt(`evejsIndustryOutput:${job.deliveryReceiptID}:v2`).found, false);
});

test("separate processes recover starter, debit, custody, install, delivery and receipt interruptions", () => {
  const { spawnSync } = require("node:child_process"), path = require("node:path");
  for (const fault of ["starter", "debit", "staged", "committed", "blueprint", "installed", "delivered", "ack"]) {
    const isolated = createIsolatedGameStore({ activate: false }); seedManufacturingStatic(isolated);
    try {
      for (const phase of ["fail", "recover"]) {
        const result = spawnSync(process.execPath, [path.join(__dirname, "fixtures/manufacturingCrewRestart.cjs"), phase, fault], {
          env: { ...process.env, ...isolated.env }, encoding: "utf8", windowsHide: true, timeout: 30000 });
        assert.equal(result.status, 0, `${fault}/${phase}: ${result.stdout}\n${result.stderr}`);
      }
    } finally { isolated.cleanup(); }
  }
});

test("ordinary native manufacturing still installs and delivers without a crew settlement tag", async () => {
  clock = 800000; const catalog = await establish(90412), b = catalog.find(b => b.productTypeID === 21857);
  const pilot = { characterID: 90412, stationid: 60000001, solarsystemid2: 1 };
  const installed = await native.installManufacturingJob(pilot, { blueprintID: b.blueprintID, activityID: 1, facilityID: 60000001, runs: 1,
    inputLocation: { itemID: 60000001, ownerID: 90412, flagID: 4 }, outputLocation: { itemID: 60000001, ownerID: 90412, flagID: 4 } });
  assert.equal(installed.success, true); assert.equal(native.getJobByID(installed.data.jobID).crewOrder, undefined);
  native.markIndustryJobReady(installed.data.jobID); assert.equal(native.deliverManufacturingJob(pilot, installed.data.jobID).success, true);
  assert.equal(qty(90412, 21857), 1); assert.equal(qty(90412, 34), 933);
  assert.equal(database.read("industryInstallSettlements", "/").data.crewReceipts[90412], undefined);
});

test("remote factory crews retain native wallet requirements without moving the pilot", async () => {
  clock = 900000; const catalog = await establish(90413, 0), b = catalog.find(b => b.productTypeID === 21857);
  const result = await start(90413, [plan(b)]);
  assert.equal(result.manufacturing.status, "insufficient_funds"); assert.equal(result.manufacturing.job, null);
  assert.equal(qty(90413, 34), 1000);
  const owned = await establish(90414), module = owned.find(b => b.productTypeID === 21857);
  items.moveItemToLocation(module.blueprintID, 60000003, 4); items.grantItemToOwnerLocation(90414, 60000003, 4, 34, 1000);
  const before = database.read("characters", "/90414").data;
  const remote = await service.submit(90414, order(service, 90414, "start", { stationID: 60000003, orders: [plan(module)] }));
  assert.equal(remote.manufacturing.job.phase, "building");
  assert.equal(database.read("characters", "/90414").data.stationID, before.stationID);
  ready(90414); for (let i = 0; i < 3; i++) await tick(901000 + i * 1000);
  assert.equal(qty(90414, 21857, 60000003), 1);
});
