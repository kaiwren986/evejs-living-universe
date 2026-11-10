"use strict";
const { createIsolatedGameStore } = require("./helpers/isolatedGameStore");
const store = createIsolatedGameStore();
const { seedMiningStatic, createFiniteScenes } = require("./helpers/miningCrewFixture"); seedMiningStatic(store);
const test = require("node:test"), assert = require("node:assert/strict");
const database = require("../src/gameStore"), items = require("../src/services/inventory/itemStore");
const { createTableRepository } = require("../src/gameStore/tableRepository");
const { seedPilot } = require("./helpers/crewFixture");
const { createCrewService } = require("../src/services/crew/crewService");
const { createCrewInventory } = require("../src/services/crew/crewInventory");
const { createCrewWorld } = require("../src/services/crew/crewRuntime");
const { createMiningCrewService } = require("../src/services/crew/miningCrewService");
const { createMiningCrewResources } = require("../src/services/crew/miningCrewResources");
const mining = require("../src/services/mining/miningRuntimeState");
const commits = require("../src/services/mining/miningCargoCommits");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const worldData = require("../src/space/worldData"), scenes = createFiniteScenes();
const notices = [];
const resources = createMiningCrewResources({ worldData, sceneForSystem: scenes.sceneForSystem, items, notify: (id, changes) => notices.push({ id, changes }) });
let clock = 0, sequence = 0;
const courier = createCrewService({ repo: createTableRepository("service:crew"), inventory: createCrewInventory({ items }),
  world: createCrewWorld(worldData), character: id => database.read("characters", `/${id}`).data, now: () => clock, legMs: 1000 });
const make = (overrides = {}) => createMiningCrewService({ repo: createTableRepository("service:crew-mining"), resources,
  crew: id => courier.snapshot(id), now: () => clock, travelMs: 1000, cycleMs: 1000, ...overrides });
const service = make();
function order(runtime, id, type, payload = {}) { return { commandID: `mining-test:${++sequence}`, type, payload, expectedRevision: runtime.snapshot(id).revision }; }
function establish(id) { seedPilot(database, items, id); courier.submit(id, order(courier, id, "create", { name: "Ore logistics" })); }
function start(id, beltID, runtime = service) { return runtime.submit(id, order(runtime, id, "start", { homeStationID: 60000001, beltID, typeID: 1230 })); }
function tick(time, runtime = service, errors = 0) { clock = time; const result = runtime.tick({ budgetMs: 1000 }); assert.equal(result.errors.length, errors, JSON.stringify(result)); }
const qty = (id, location, flag = 4) => items.listContainerItems(id, location, flag).filter(item => item.typeID === 1230).reduce((sum, item) => sum + item.quantity, 0);
test.after(async () => { assert.equal((await database.shutdown("mining-crew-tests")).success, true);
  require("../src/gameStore/sqliteStore").close(); await require("../src/utils/rotatingLog").closeAll(); store.cleanup(); });

test("finite ore travels in miner custody, unloads to native hangar and feeds a repeating courier", () => {
  clock = 0; establish(90200); const rockID = scenes.add(40001, 2500);
  courier.submit(90200, order(courier, 90200, "automate", { sourceStationID: 60000001, destinationStationID: 60000003, typeID: 1230, sourceReserve: 0 }));
  start(90200, 40001);
  tick(1000); assert.equal(service.snapshot(90200).mining.job.phase, "working");
  tick(2000); let state = service.snapshot(90200).mining;
  assert.equal(state.job.phase, "returning"); assert.equal(qty(90200, 60000001), 0);
  assert.equal(qty(90200, state.escrowLocationID, 5), 1000);
  assert.equal(mining.getMineableState(scenes.scene, rockID).remainingQuantity, 1500);
  tick(3000); assert.equal(qty(90200, 60000001), 1000); assert.equal(service.snapshot(90200).mining.totalDelivered, 1000);
  for (let time = 4000; time <= 40000; time += 1000) { tick(time); assert.deepEqual(courier.tick({ budgetMs: 1000 }).errors, []); }
  state = service.snapshot(90200).mining;
  assert.equal(state.status, "depleted"); assert.equal(state.plan.enabled, false); assert.equal(state.job, null);
  assert.equal(state.totalMined, 2500); assert.equal(state.totalDelivered, 2500); assert.equal(state.completedDeliveries, 3);
  assert.equal(qty(90200, 60000003), 2500); assert.equal(qty(90200, 60000001), 0);
  assert.equal(courier.snapshot(90200).crew.standingOrder.status, "waiting_for_stock");
  tick(400000); assert.equal(mining.getMineableState(scenes.scene, rockID).remainingQuantity, 0);
  assert.equal(notices.filter(n => n.id === 90200).length, 3);
  assert.equal(service.snapshot(90200).commandCapacityRemaining, 1023);
});

test("a crash after native grant recovers the same load while another miner consumes the remaining rock", () => {
  clock = 500000; establish(90201); establish(90202); const rockID = scenes.add(40002, 1500);
  let fault = true;
  const runtime = make({ resources: { ...resources, extract(state) { const result = resources.extract(state); if (fault) { fault = false; throw new Error("After native grant"); } return result; } } });
  start(90201, 40002, runtime); tick(501000, runtime); tick(502000, runtime, 1);
  assert.equal(runtime.snapshot(90201).mining.job.phase, "extracting");
  assert.equal(qty(90201, runtime.snapshot(90201).mining.escrowLocationID, 5), 1000);
  start(90202, 40002); tick(503000); tick(504000);
  assert.equal(mining.getMineableState(scenes.scene, rockID).remainingQuantity, 0);
  tick(504000, runtime); assert.equal(runtime.snapshot(90201).mining.totalMined, 1000);
  tick(505000); tick(505000, runtime); assert.equal(qty(90201, 60000001), 1000);
  assert.equal(qty(90202, 60000001), 500);
  assert.equal(commits.listRecords()["crew-mining:90201"].transferred, 1000);
});

test("pending source debit settles before other resource users; no second ore grant", () => {
  clock = 600000; establish(90203); const rockID = scenes.add(40003, 2000);
  start(90203, 40003); tick(601000);
  const original = items.grantItemToOwnerLocationIdempotent;
  items.grantItemToOwnerLocationIdempotent = () => ({ success: false, errorMsg: "Injected inventory outage" });
  try { tick(602000, service, 1); assert.equal(mining.getMineableState(scenes.scene, rockID), null); }
  finally { items.grantItemToOwnerLocationIdempotent = original; }
  assert.equal(mining.getMineableState(scenes.scene, rockID).remainingQuantity, 1000);
  tick(603000); tick(604000);
  assert.equal(qty(90203, 60000001), 1000);
  assert.equal(service.snapshot(90203).mining.totalMined, 1000);
});

test("late unload confirmation cannot recall ore already collected by the supply route", () => {
  clock = 700000; establish(90204); scenes.add(40004, 1000); let fault = true;
  const runtime = make({ resources: { ...resources, unload(state) { resources.unload(state); if (fault) { fault = false; throw new Error("After unload"); } } } });
  start(90204, 40004, runtime); tick(701000, runtime); tick(702000, runtime); tick(703000, runtime, 1);
  courier.submit(90204, order(courier, 90204, "automate", { sourceStationID: 60000001, destinationStationID: 60000003, typeID: 1230, sourceReserve: 0 }));
  clock = 707000; courier.tick({ budgetMs: 1000 }); assert.equal(qty(90204, 60000003), 1000);
  tick(707000, runtime); assert.equal(qty(90204, 60000003), 1000); assert.equal(qty(90204, 60000001), 0);
  assert.equal(runtime.snapshot(90204).mining.completedDeliveries, 1);
  const record = commits.listRecords()["crew-mining:90204"];
  assert.equal(items.getIdempotentGrantReceipt(`crew-mining:${record.jobID}:grant`).found, false);
  assert.equal(items.getIdempotentGrantReceipt(`crew-mining:${record.jobID}:unload`).found, false);
  const replay = commits.commitCrewExtraction({ ownerID: 90204, locationID: 8_500_000_000_090_204, serial: record.serial,
    jobID: record.jobID, systemID: 1, resourceID: record.resourceID, state: record.previousState, quantity: record.transferred, atMs: record.cycleMs });
  assert.equal(replay.success, true); assert.equal(replay.duplicate, true); assert.equal(qty(90204, 60000003), 1000);
});

test("pause freezes work and graceful stop returns an accepted mining load", () => {
  clock = 800000; establish(90205); const rockID = scenes.add(40005, 5000);
  const accepted = order(service, 90205, "start", { homeStationID: 60000001, beltID: 40005, typeID: 1230 });
  service.submit(90205, accepted); assert.equal(service.submit(90205, accepted).replayed, true);
  service.submit(90205, order(service, 90205, "pause")); tick(900000);
  assert.equal(mining.getMineableState(scenes.scene, rockID).remainingQuantity, 5000);
  service.submit(90205, order(service, 90205, "resume")); tick(901000); tick(902000);
  service.submit(90205, order(service, 90205, "stop")); tick(903000);
  assert.equal(qty(90205, 60000001), 1000); assert.equal(service.snapshot(90205).mining.plan.enabled, false);
  assert.equal(service.snapshot(90205).mining.job, null); tick(1000000);
  assert.equal(mining.getMineableState(scenes.scene, rockID).remainingQuantity, 4000);
  const facts = service.universeFacts({ ownerID: 90205 }); assert.equal(facts.actors.length, 2);
  assert.equal(facts.actors[0].actorID, "mining:90205:member:0"); assert.equal(facts.recentEvents[0].type, "ore_delivered");
});

test("invalid ownership, plans and revisions leave resources untouched", () => {
  clock = 1100000; scenes.add(40006, 1000);
  assert.throws(() => start(90206, 40006), { code: "CREW_NOT_FOUND" }); establish(90206);
  assert.throws(() => service.submit(90206, order(service, 90206, "start", { homeStationID: 60000002, beltID: 40006, typeID: 1230 })), { code: "CREW_STATION_INVALID" });
  assert.throws(() => service.submit(90206, order(service, 90206, "start", { homeStationID: 60000001, beltID: 40006, typeID: 34 })), { code: "CREW_CARGO_INVALID" });
  assert.throws(() => service.submit(90206, { ...order(service, 90206, "start", { homeStationID: 60000001, beltID: 40006, typeID: 1230 }), expectedRevision: 42 }), { code: "CREW_REVISION_CONFLICT" });
  assert.equal(mining.getMineableState(scenes.scene, 140006).remainingQuantity, 1000);
});

test("100 automatic loads keep the source journal and inventory receipts bounded", () => {
  clock = 1200000; establish(90207); const rockID = scenes.add(40007, 100000); start(90207, 40007);
  for (let index = 1; index <= 405; index++) tick(1200000 + index * 1000);
  const state = service.snapshot(90207).mining;
  assert.equal(state.totalDelivered, 100000); assert.equal(state.completedDeliveries, 100); assert.equal(state.history.length, 20);
  assert.equal(mining.getMineableState(scenes.scene, rockID).remainingQuantity, 0); assert.equal(qty(90207, 60000001), 100000);
  assert.equal(service.snapshot(90207).commandCapacityRemaining, 1023);
  assert.equal(Object.keys(commits.listRecords()).filter(key => key === "crew-mining:90207").length, 1);
  const record = commits.listRecords()["crew-mining:90207"];
  assert.equal(items.getIdempotentGrantReceipt(`crew-mining:${record.jobID}:grant`).found, false);
});

test("an intervening native mining cycle invalidates an unaccepted crew allocation", () => {
  clock = 1700000; const rockID = scenes.add(40008, 1500);
  const intent = { ownerID: 90208, escrowLocationID: 8_500_000_000_090_208, systemID: 1,
    plan: { beltID: 40008, typeID: 1230 }, job: { serial: 1, jobID: "b".repeat(64), batchM3: 100, extractionAtMs: clock } };
  intent.job.allocation = resources.prepare(intent);
  const result = commits.commit({ scene: scenes.scene, entity: { itemID: 99008 }, target: { itemID: rockID },
    state: mining.getMineableState(scenes.scene, rockID), moduleID: 88008, cycleMs: clock,
    transferred: 0, mined: 750, wasted: 0 });
  assert.equal(result.success, true); assert.deepEqual(resources.extract(intent), { retry: true });
  assert.equal(qty(90208, intent.escrowLocationID, 5), 0);
  intent.job.allocation = resources.prepare(intent);
  assert.equal(resources.extract(intent).quantity, 750);
  assert.equal(mining.getMineableState(scenes.scene, rockID).remainingQuantity, 0);
});

test("an uncertain team-intent flush moves no ore and a long downtime does not produce a backlog", () => {
  clock = 1800000; establish(90209); const rockID = scenes.add(40009, 5000);
  const ownerRepo = createTableRepository("service:crew-mining"); let fault = false;
  const command = order(make(), 90209, "start", { homeStationID: 60000001, beltID: 40009, typeID: 1230 });
  const originalWrite = ownerRepo.write;
  // Fail the fence after the order's aggregate has entered the cache.
  const broken = make({ repo: { ...ownerRepo, write(...args) { const result = originalWrite(...args); fault = true; return result; },
    flushTableSync(table) { if (fault) { fault = false; return { success: false }; } return ownerRepo.flushTableSync(table); } } });
  assert.throws(() => broken.submit(90209, command), { code: "CREW_STORE_UNAVAILABLE" });
  assert.equal(mining.getMineableState(scenes.scene, rockID).remainingQuantity, 5000);
  const recovered = make(); assert.equal(recovered.submit(90209, command).replayed, true);
  tick(100000000, recovered); assert.equal(recovered.snapshot(90209).mining.totalMined, 0);
  tick(100001000, recovered); assert.equal(recovered.snapshot(90209).mining.totalMined, 0);
  tick(100002000, recovered); assert.equal(recovered.snapshot(90209).mining.totalMined, 1000);
  tick(200000000, recovered); assert.equal(recovered.snapshot(90209).mining.totalDelivered, 1000);
  assert.equal(mining.getMineableState(scenes.scene, rockID).remainingQuantity, 4000);
});

test("separate processes recover after source debit, grant, unload and acknowledgement faults", () => {
  for (const fault of ["source", "grant", "unload", "ack"]) {
    const isolated = createIsolatedGameStore({ activate: false }); seedMiningStatic(isolated);
    try {
      for (const phase of ["fail", "recover"]) {
        const result = spawnSync(process.execPath, [path.join(__dirname, "fixtures/miningCrewRestart.cjs"), phase, fault],
          { env: { ...process.env, ...isolated.env }, encoding: "utf8", timeout: 30000, windowsHide: true });
        assert.equal(result.status, 0, `${fault}/${phase}: ${result.stdout}\n${result.stderr}`);
      }
    } finally { isolated.cleanup(); }
  }
});
