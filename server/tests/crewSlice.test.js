"use strict";
const { createIsolatedGameStore } = require("./helpers/isolatedGameStore");
const store = createIsolatedGameStore();
const { seedStatic, seedPilot } = require("./helpers/crewFixture");
seedStatic(store);
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const database = require("../src/gameStore");
const items = require("../src/services/inventory/itemStore");
const { createTableRepository, domainOwns } = require("../src/gameStore/tableRepository");
const { createCrewService, normalizeCommand } = require("../src/services/crew/crewService");
const { createCrewInventory } = require("../src/services/crew/crewInventory");
const { createCrewWorld } = require("../src/services/crew/crewRuntime");
const world = createCrewWorld(require("../src/space/worldData"));
const repo = createTableRepository("service:crew");
const inventory = createCrewInventory({ items });
let atMs = 1000;
const service = createCrewService({ repo, inventory, world, character: (id) => database.read("characters", `/${id}`).data,
  now: () => atMs, legMs: 1000 });
let sequence = 0;
const order = (id, type, payload = {}, overrides = {}) => ({ commandID: `test:${++sequence}`,
  expectedRevision: service.snapshot(id).revision, type, payload, ...overrides });
const establish = (id) => { const itemID = seedPilot(database, items, id);
  service.submit(id, order(id, "create", { name: `Crew ${id}` })); return itemID; };

test.after(async () => {
  assert.equal((await database.shutdown("crew-tests")).success, true);
  require("../src/gameStore/sqliteStore").close();
  await require("../src/utils/rotatingLog").closeAll();
  store.cleanup();
});

test("new table has a strict domain owner and real SQLite backing", () => {
  assert.equal(domainOwns("service:crew", "crewRuntime"), true);
  assert.equal(database._sqliteTables.has("crewRuntime"), true);
  const foreign = createTableRepository("service:inventory", { store: database });
  assert.throws(() => foreign.write("crewRuntime", "/1", {}), /may not mutate/);
});
test("a crew reserves real cargo, travels through systems and delivers once", () => {
  const itemID = establish(90001);
  const command = order(90001, "deliver", { destinationStationID: 60000003, itemID });
  const accepted = service.submit(90001, command);
  assert.equal(accepted.crew.job.phase, "travelling");
  assert.deepEqual(accepted.crew.job.route, [1, 2, 3]);
  assert.equal(items.listContainerItems(90001, 60000001, 4).length, 0);
  assert.equal(items.findItemById(itemID).quantity, 1000);
  assert.equal(service.submit(90001, command).replayed, true);
  atMs = 1999; service.tick({ budgetMs: 1000 });
  assert.equal(service.snapshot(90001).crew.systemID, 1);
  atMs = 2000; service.tick({ budgetMs: 1000 });
  assert.equal(service.snapshot(90001).crew.systemID, 2);
  assert.equal(items.listContainerItems(90001, 60000003, 4).length, 0);
  atMs = 4000; service.tick({ budgetMs: 1000 });
  const complete = service.snapshot(90001);
  assert.equal(complete.crew.stationID, 60000003); assert.equal(complete.crew.job, null);
  assert.equal(complete.history.length, 1);
  assert.equal(items.listContainerItems(90001, 60000003, 4)[0].itemID, itemID);
  assert.equal(service.submit(90001, command).replayed, true);
  assert.equal(service.snapshot(90001).history.length, 1);
  assert.equal(items.listContainerItems(90001, 60000003, 4)[0].quantity, 1000);
});
test("pause freezes the remaining leg, survives reconstruction and resumes", () => {
  atMs = 10000;
  establish(90002);
  service.submit(90002, order(90002, "travel", { destinationStationID: 60000003 }));
  atMs = 10500;
  service.submit(90002, order(90002, "pause"));
  atMs = 100000;
  const restored = createCrewService({ repo, inventory, world, character: () => null, now: () => atMs, legMs: 99999 });
  restored.tick({ budgetMs: 1000 });
  assert.equal(restored.snapshot(90002).crew.systemID, 1);
  restored.submit(90002, { commandID: "resume:one", expectedRevision: restored.snapshot(90002).revision, type: "resume", payload: {} });
  atMs = 100499; restored.tick({ budgetMs: 1000 });
  assert.equal(restored.snapshot(90002).crew.systemID, 1);
  atMs = 100500; restored.tick({ budgetMs: 1000 });
  assert.equal(restored.snapshot(90002).crew.systemID, 2);
  atMs = 102500; restored.tick({ budgetMs: 1000 });
  assert.equal(restored.snapshot(90002).crew.stationID, 60000003);
});
test("rejects foreign cargo, invalid destinations, stale versions and busy orders", () => {
  atMs = 200000;
  const ownItem = establish(90003), foreignItem = establish(90004);
  assert.throws(() => service.submit(90003, order(90003, "deliver", { destinationStationID: 60000003, itemID: foreignItem })), { code: "CREW_CARGO_INVALID" });
  assert.throws(() => service.submit(90003, order(90003, "travel", { destinationStationID: 60000099 })), { code: "CREW_ROUTE_UNAVAILABLE" });
  assert.throws(() => service.submit(90003, order(90003, "travel", { destinationStationID: 123 })), { code: "CREW_STATION_INVALID" });
  assert.throws(() => service.submit(90003, order(90003, "travel", { destinationStationID: 60000002 }, { expectedRevision: 0 })), { code: "CREW_REVISION_CONFLICT" });
  const command = order(90003, "deliver", { destinationStationID: 60000003, itemID: ownItem });
  service.submit(90003, command);
  assert.throws(() => service.submit(90003, { ...command, payload: { ...command.payload, destinationStationID: 60000002 } }), { code: "CREW_COMMAND_REUSED" });
  assert.throws(() => service.submit(90003, order(90003, "travel", { destinationStationID: 60000002 })), { code: "CREW_BUSY" });
});
test("strict envelopes reject owner injection; unusual command IDs remain ordinary receipts", () => {
  assert.throws(() => normalizeCommand({ commandID: "a", expectedRevision: 0, type: "create", payload: { name: "Crew", ownerID: 99 } }), { code: "CREW_COMMAND_INVALID" });
  seedPilot(database, items, 90005);
  const command = order(90005, "create", { name: "Prototype-safe crew" }, { commandID: "__proto__" });
  service.submit(90005, command);
  assert.equal(service.submit(90005, command).replayed, true);
});
test("a failed crew intent flush performs no inventory effect and recovers on the next tick", () => {
  const itemID = establish(90006);
  let armed = false, failed = false;
  const flakyRepo = { ...repo, write(table, key, value) { if (value.job?.phase === "reserving") armed = true; return repo.write(table, key, value); },
    flushTableSync(table) { if (armed && !failed) { failed = true; return { success: false }; } return repo.flushTableSync(table); } };
  const flaky = createCrewService({ repo: flakyRepo, inventory, world, character: () => null, now: () => atMs, legMs: 1000 });
  const command = order(90006, "deliver", { destinationStationID: 60000003, itemID });
  assert.throws(() => flaky.submit(90006, command), { code: "CREW_STORE_UNAVAILABLE" });
  assert.equal(items.findItemById(itemID).locationID, 60000001);
  assert.equal(flaky.tick({ budgetMs: 1000 }).errors.length, 0);
  assert.equal(flaky.snapshot(90006).crew.job.phase, "travelling");
  assert.equal(flaky.submit(90006, command).replayed, true);
});
test("disabled service starts no persistence; corrupt persisted route fails closed", () => {
  const disabled = createCrewService({ repo: new Proxy({}, { get() { throw new Error("Store must remain unused"); } }), inventory, world,
    character: () => null, enabled: false });
  assert.equal(disabled.snapshot(1).enabled, false);
  assert.equal(disabled.tick().processed, 0);
  establish(90007);
  service.submit(90007, order(90007, "travel", { destinationStationID: 60000003 }));
  const row = JSON.parse(JSON.stringify(database.read("crewRuntime", "/90007").data));
  row.job.route = [99]; database.write("crewRuntime", "/90007", row);
  const restored = createCrewService({ repo, inventory, world, character: () => null });
  assert.throws(() => restored.snapshot(90007), { code: "CREW_STATE_INVALID" });
  row.job.route = [1, 2, 3]; row.job.phase = "delivering";
  database.write("crewRuntime", "/90007", row);
  assert.throws(() => restored.snapshot(90007), { code: "CREW_STATE_INVALID" });
  // Restore the deliberately corrupt fixture before subsequent suite work.
  row.job.phase = "travelling"; database.write("crewRuntime", "/90007", row); database.flushTableSync("crewRuntime");
});
test("separate processes recover failures after reservation and delivery without duplicate cargo", () => {
  const restartedStore = createIsolatedGameStore({ activate: false });
  seedStatic(restartedStore);
  try {
    for (const phase of ["reserve", "deliver", "finish"]) {
      const result = spawnSync(process.execPath, [path.join(__dirname, "fixtures/crewRestart.cjs"), phase], {
        env: { ...process.env, ...restartedStore.env }, encoding: "utf8", timeout: 30000, windowsHide: true, maxBuffer: 2 * 1024 * 1024,
      });
      assert.equal(result.status, 0, result.stderr + result.stdout);
      assert.match(result.stdout, new RegExp(`CREW_RESTART_OK:${phase}`));
    }
  } finally { restartedStore.cleanup(); }
});

test("cargo capacity is enforced without taking any source inventory", () => {
  establish(90008);
  const large = items.grantItemToOwnerLocation(90008, 60000001, 4,
    { typeID: 34, name: "Tritanium", groupID: 18, categoryID: 4, volume: 0.01 }, 110000);
  const itemID = large.data.items[0].itemID;
  assert.throws(() => service.submit(90008, order(90008, "deliver", { destinationStationID: 60000002, itemID })), { code: "CREW_CARGO_CAPACITY" });
  assert.equal(items.findItemById(itemID).locationID, 60000001);
  assert.equal(service.snapshot(90008).crew.job, null);
});
test("late replay of journey A cannot replace active journey B", () => {
  atMs = 300000; establish(90009);
  const first = order(90009, "travel", { destinationStationID: 60000002 });
  service.submit(90009, first); atMs = 303000; service.tick({ budgetMs: 1000 });
  const second = service.submit(90009, order(90009, "travel", { destinationStationID: 60000001 }));
  const replay = service.submit(90009, first);
  assert.equal(replay.replayed, true); assert.equal(replay.crew.job.jobID, second.crew.job.jobID);
  assert.equal(replay.crew.job.destinationStationID, 60000001);
});
test("crew settings hydrate into the world domain without starting a server", () => {
  const configStore = createIsolatedGameStore({ activate: false });
  try {
    const { createConfigManager } = require("../src/config/manager");
    const manager = createConfigManager({ rootDir: configStore.storeRoot, schemaDefinitions: require("../src/config/schema") });
    manager.initializeConfigFiles();
    const raw = JSON.parse(require("node:fs").readFileSync(path.join(configStore.storeRoot, "config/world.json")));
    assert.equal(raw.crew.crewOperationsEnabled, false); assert.equal(raw.crew.crewTravelLegMs, 30000);
    assert.equal(raw.crew.crewMiningTravelMs, 30000); assert.equal(raw.crew.crewMiningCycleMs, 60000); assert.equal(raw.crew.crewMiningBatchM3, 100);
    assert.equal(raw.crew.crewRefiningCycleMs, 30000); assert.equal(raw.crew.crewRefiningBatchM3, 1000);
  } finally { configStore.cleanup(); }
});
