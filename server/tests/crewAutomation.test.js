"use strict";
const { createIsolatedGameStore } = require("./helpers/isolatedGameStore");
const store = createIsolatedGameStore();
const { seedStatic, seedPilot } = require("./helpers/crewFixture");
seedStatic(store);
store.writeStatic("itemTypes", { types: [34, 35].map(typeID => ({ typeID, name: typeID === 34 ? "Tritanium" : "Pyerite", groupID: 18, categoryID: 4, volume: 0.01, published: true })) });
const test = require("node:test"), assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const database = require("../src/gameStore"), items = require("../src/services/inventory/itemStore");
const { createTableRepository } = require("../src/gameStore/tableRepository");
const { createCrewService } = require("../src/services/crew/crewService");
const { createCrewInventory } = require("../src/services/crew/crewInventory");
const { createCrewWorld } = require("../src/services/crew/crewRuntime");
const { createActorDirectory } = require("../src/services/livingUniverse/actorDirectory");
const repo = createTableRepository("service:crew"), inventory = createCrewInventory({ items });
const world = createCrewWorld(require("../src/space/worldData"));
let clock = 1000, sequence = 0;
const create = (overrides = {}) => createCrewService({ repo, inventory, world, character: (id) => database.read("characters", `/${id}`).data,
  now: () => clock, legMs: 1000, ...overrides });
const service = create();
const command = (id, type, payload = {}) => ({ commandID: `auto:${++sequence}`, type, payload, expectedRevision: service.snapshot(id).revision });
const establish = (id) => { const itemID = seedPilot(database, items, id); service.submit(id, command(id, "create", { name: `Supply crew ${id}` })); return itemID; };
const plan = { sourceStationID: 60000001, destinationStationID: 60000003, typeID: 34, sourceReserve: 0 };
const tick = (time, runtime = service) => { clock = time; assert.deepEqual(runtime.tick({ budgetMs: 1000 }).errors, []); };
const qty = (id, station) => items.listContainerItems(id, station, 4).reduce((sum, item) => sum + item.quantity, 0);
const grant = (id, amount) => items.grantItemToOwnerLocation(id, 60000001, 4, { typeID: 34, name: "Tritanium", groupID: 18, categoryID: 4, volume: 0.01 }, amount);
test.after(async () => { assert.equal((await database.shutdown("crew-automation-tests")).success, true);
  require("../src/gameStore/sqliteStore").close(); await require("../src/utils/rotatingLog").closeAll(); store.cleanup(); });

test("standing order hauls, returns empty, waits and picks up newly supplied material", () => {
  establish(90100);
  const accepted = service.submit(90100, command(90100, "automate", plan));
  const firstJobID = accepted.crew.job.jobID;
  assert.equal(accepted.crew.job.cargo.quantity, 1000);
  tick(5000);
  let state = service.snapshot(90100);
  assert.equal(state.crew.standingOrder.completedDeliveries, 1);
  assert.equal(state.crew.job.type, "travel"); assert.equal(state.crew.job.cargo, null);
  assert.equal(qty(90100, 60000003), 1000);
  assert.equal(items.getIdempotentGrantReceipt(`crew:${firstJobID}:reserve`).found, false);
  assert.equal(items.getIdempotentGrantReceipt(`crew:${firstJobID}:deliver`).found, false);
  tick(9000); state = service.snapshot(90100);
  assert.equal(state.crew.job, null); assert.equal(state.crew.standingOrder.status, "waiting_for_stock");
  assert.equal(grant(90100, 2000).success, true);
  tick(15000); assert.equal(service.snapshot(90100).crew.job.cargo.quantity, 2000);
  tick(19000); assert.equal(qty(90100, 60000003), 3000);
  state = service.snapshot(90100);
  assert.equal(state.crew.standingOrder.completedDeliveries, 2);
  assert.equal(state.commandCapacityRemaining, 1022, "Automatic jobs must not consume player command receipts");
});
test("source reserve and pause prevent automatic cargo withdrawal; stop finishes an accepted delivery", () => {
  clock = 30000; const itemID = establish(90101);
  const configured = service.submit(90101, command(90101, "automate", { ...plan, sourceReserve: 1000 }));
  assert.equal(configured.crew.standingOrder.status, "waiting_for_stock");
  assert.equal(items.findItemById(itemID).locationID, 60000001);
  service.submit(90101, command(90101, "pause"));
  tick(100000);
  assert.equal(service.snapshot(90101).crew.standingOrder.paused, true);
  service.submit(90101, command(90101, "stop"));
  assert.equal(service.snapshot(90101).crew.standingOrder.enabled, false);
  service.submit(90101, command(90101, "automate", plan));
  service.submit(90101, command(90101, "pause"));
  tick(200000);
  assert.equal(service.snapshot(90101).crew.systemID, 1);
  service.submit(90101, command(90101, "stop"));
  tick(210000);
  assert.equal(qty(90101, 60000003), 1000);
  assert.equal(service.snapshot(90101).crew.job, null);
  assert.equal(service.snapshot(90101).crew.standingOrder.status, "stopped");
  assert.equal(grant(90101, 500).success, true); tick(220000);
  assert.equal(qty(90101, 60000001), 500);
});
test("standing-order replay, busy/manual conflicts and unavailable routes do not redirect a crew", () => {
  clock = 300000; establish(90102);
  assert.throws(() => service.submit(90102, command(90102, "automate", { ...plan, destinationStationID: 60000099 })), { code: "CREW_ROUTE_UNAVAILABLE" });
  const order = command(90102, "automate", plan), accepted = service.submit(90102, order);
  assert.equal(service.submit(90102, order).crew.job.jobID, accepted.crew.job.jobID);
  assert.throws(() => service.submit(90102, { ...order, payload: { ...plan, sourceReserve: 99 } }), { code: "CREW_COMMAND_REUSED" });
  tick(310000); tick(320000);
  assert.equal(service.snapshot(90102).crew.standingOrder.status, "waiting_for_stock");
  assert.throws(() => service.submit(90102, command(90102, "travel", { destinationStationID: 60000002 })), { code: "CREW_AUTOMATION_ACTIVE" });
});
test("receipt acknowledgement failures stop new trips and reconcile without another delivery", () => {
  clock = 400000; establish(90103);
  let rejectAck = true;
  const runtime = create({ inventory: { ...inventory, acknowledge(jobID) {
    inventory.acknowledge(jobID);
    if (rejectAck) throw new Error("Injected after receipt retirement");
  } } });
  runtime.submit(90103, command(90103, "automate", plan));
  clock = 410000;
  assert.equal(runtime.tick({ budgetMs: 1000 }).errors.some((error) => error.ownerID === 90103), true);
  assert.equal(runtime.snapshot(90103).crew.job, null);
  assert.equal(runtime.snapshot(90103).crew.confirmationPending, true);
  assert.equal(qty(90103, 60000003), 1000);
  rejectAck = false;
  assert.equal(runtime.tick({ budgetMs: 1000 }).errors.length, 0);
  assert.equal(runtime.snapshot(90103).crew.job.type, "travel");
  assert.equal(runtime.snapshot(90103).crew.confirmationPending, false);
  assert.equal(runtime.snapshot(90103).crew.standingOrder.completedDeliveries, 1);
  assert.equal(qty(90103, 60000003), 1000);
});
test("stop is durable even while inventory acknowledgement is unavailable", () => {
  clock = 450000; establish(90104);
  const runtime = create({ inventory: { ...inventory, acknowledge() { throw new Error("Inventory unavailable"); } } });
  runtime.submit(90104, command(90104, "automate", plan));
  clock = 460000; runtime.tick({ budgetMs: 1000 });
  const stop = command(90104, "stop");
  assert.throws(() => runtime.submit(90104, stop), /Inventory unavailable/);
  assert.equal(database.read("crewRuntime", "/90104").data.standingOrder.enabled, false);
  const recovered = create(); tick(470000, recovered);
  assert.equal(recovered.snapshot(90104).crew.job, null);
  assert.equal(recovered.submit(90104, stop).replayed, true);
  assert.equal(qty(90104, 60000003), 1000);
});
test("automation always leaves a command-journal slot for stop", () => {
  clock = 500000; establish(90105);
  service.submit(90105, command(90105, "automate", { ...plan, sourceReserve: 99999 }));
  const row = JSON.parse(JSON.stringify(database.read("crewRuntime", "/90105").data));
  for (let count = Object.keys(row.receipts).length; count < 1023; count++) row.receipts[`fixture-${count}`] = { fingerprint: "fixture", type: "create" };
  database.write("crewRuntime", "/90105", row); database.flushTableSync("crewRuntime");
  assert.throws(() => service.submit(90105, command(90105, "pause")), { code: "CREW_RECEIPT_CAPACITY" });
  service.submit(90105, command(90105, "stop"));
  assert.equal(service.snapshot(90105).crew.standingOrder.enabled, false);
  assert.equal(service.snapshot(90105).commandCapacityRemaining, 0);
});
test("the universe directory keeps the same people across travel/restart and scopes observation", () => {
  const directory = createActorDirectory(); directory.register("crews", (query) => service.universeFacts(query));
  const before = directory.snapshot({ ownerID: 90100 });
  assert.equal(before.actors.length, 2);
  assert.ok(before.actors.every((actor) => actor.ownerID === 90100 && actor.representation === "virtual"));
  const ids = before.actors.map((actor) => actor.actorID);
  const restored = create(); const second = createActorDirectory(); second.register("crews", (query) => restored.universeFacts(query));
  assert.deepEqual(second.snapshot({ ownerID: 90100 }).actors.map((actor) => actor.actorID), ids);
  const events = before.recentEvents.filter((event) => event.type === "cargo_delivered");
  assert.equal(new Set(events.map((event) => event.eventID)).size, events.length);
  assert.ok(events.some((event) => event.automatic));
  before.actors[0].name = "Changed projection";
  assert.notEqual(second.snapshot({ ownerID: 90100 }).actors[0].name, "Changed projection");
  assert.throws(() => directory.register("crews", () => ({})), /duplicate/);
  const persisted = JSON.parse(JSON.stringify(database.read("crewRuntime", "/90100").data));
  const duplicate = JSON.parse(JSON.stringify(persisted)); duplicate.roster[1].actorID = duplicate.roster[0].actorID;
  database.write("crewRuntime", "/90100", duplicate);
  assert.throws(() => service.snapshot(90100), { code: "CREW_STATE_INVALID" });
  database.write("crewRuntime", "/90100", persisted); database.flushTableSync("crewRuntime");
});
test("separate processes resume a saved supply route after an uncertain reservation", () => {
  for(const mode of ["whole","partial"]){
  const temporary = createIsolatedGameStore({ activate: false }); seedStatic(temporary);
  try {
    for (const phase of ["reserve", "recover", "deliver", "restock"]) {
      const child = spawnSync(process.execPath, [path.join(__dirname, "fixtures/crewAutomationRestart.cjs"), phase, mode], {
        env: { ...process.env, ...temporary.env }, encoding: "utf8", timeout: 30000, windowsHide: true,
      });
      assert.equal(child.status, 0, child.stdout + child.stderr);
    }
  } finally { temporary.cleanup(); }
  }
});
test("100 automated deliveries keep history and receipt storage bounded", () => {
  clock = 600000; establish(90106);
  service.submit(90106, command(90106, "automate", plan));
  for (let cycle = 0; cycle < 100; cycle++) {
    tick(clock + 4000);
    assert.equal(qty(90106, 60000003), (cycle + 1) * 1000);
    tick(clock + 4000);
    if (cycle < 99) { assert.equal(grant(90106, 1000).success, true); tick(clock + 6000); }
  }
  const state = service.snapshot(90106);
  assert.equal(state.crew.standingOrder.completedDeliveries, 100);
  assert.equal(state.history.length, 20);
  assert.equal(state.commandCapacityRemaining, 1022);
  const receipts = Object.values(database.read("items", "/__evejsInventoryGrantReceipts").data || {});
  assert.equal(receipts.filter((receipt) => receipt.receiptKey?.startsWith("crew:") && receipt.fingerprint?.ownerID === 90106).length, 0);
});

test("mixed supply rotates available types, skips empty types and rejects malformed groups", () => {
  clock = 3000000; establish(90107);
  for (const typeIDs of [[], [35, 34], [34, 34], [34, -1]]) assert.throws(() => service.submit(90107, command(90107, "automate", { ...plan, typeIDs })), { code: "CREW_COMMAND_INVALID" });
  assert.equal(items.grantItemToOwnerLocation(90107, 60000001, 4, 35, 200).success, true);
  service.submit(90107, command(90107, "automate", { ...plan, typeIDs: [34, 35, 36] }));
  grant(90107, 500);
  tick(clock + 4000); tick(clock + 4000);
  assert.equal(service.snapshot(90107).crew.job.cargo.typeID, 35, "Pyerite must not starve while Tritanium remains");
  tick(clock + 4000); tick(clock + 4000);
  assert.equal(service.snapshot(90107).crew.job.cargo.typeID, 34, "An empty group member must not block the route");
});

test("standing routes split a large stack, preserve reserves and recover an uncertain partial reservation", () => {
  clock=4000000;const id=90108;establish(id);grant(id,200000);
  let fault=true;
  const runtime=create({inventory:{...inventory,move(...args){const result=inventory.move(...args);if(fault){fault=false;throw Error("After partial reservation");}return result;}}});
  const c={commandID:"partial-load",expectedRevision:runtime.snapshot(id).revision,type:"automate",payload:{...plan,sourceReserve:101000}};
  assert.throws(()=>runtime.submit(id,c),/After partial reservation/);
  assert.equal(qty(id,60000001),101000);
  clock+=1000;tick(clock,runtime);
  assert.equal(runtime.snapshot(id).crew.job.cargo.quantity,100000);
  clock+=4000;tick(clock,runtime);
  assert.equal(qty(id,60000003),100000);
  clock+=5000;tick(clock,runtime);
  assert.equal(runtime.snapshot(id).crew.standingOrder.status,"waiting_for_stock");
  assert.equal(qty(id,60000001),101000);
  assert.equal(runtime.snapshot(id).crew.standingOrder.completedDeliveries,1);
});
