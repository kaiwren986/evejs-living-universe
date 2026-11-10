"use strict";
const { createIsolatedGameStore } = require("./helpers/isolatedGameStore"), store = createIsolatedGameStore();
require("./helpers/crewMarketFixture").seedSellingStatic(store);
process.env.EVEJS_WEB_GATEWAY_TOKEN = "equipment-test-token";
const test = require("node:test"), assert = require("node:assert/strict");
const database = require("../src/gameStore"), items = require("../src/services/inventory/itemStore"), wallet = require("../src/services/account/walletState");
const { createTableRepository } = require("../src/gameStore/tableRepository");
const { createCrewEquipmentService } = require("../src/services/crew/crewEquipmentService");
const { createCrewEquipmentPayment, createCrewEquipmentEconomy } = require("../src/services/crew/crewEquipmentEconomy");
const gear = require("../src/services/crew/crewEquipmentState");
let clock = 0, nextID = 94000, serial = 0;
const policy = { budgetISK: 200000, walletReserve: 100000, workingCapitalISK: 1000, reinvestPercent: 25, maxPaybackHours: 24 };
function scenario(options = {}) {
  const id = nextID++; require("./helpers/manufacturingCrewFixture").fundManufacturingPilot(database, items, id, options.balance || 500000);
  const funds = { netSales: 1000000, mineralSpent: 100000, refiningTax: 1000, factoryFees: 1000, walletReserve: 100000, pending: false, ...options.funds };
  const assessment = { candidates: [{ role: "mining", incrementalProfitPerHour: 1000 }], workingCapitalISK: 2000, ...options.assessment };
  const economy = { funds: () => ({ ...funds, walletBalance: wallet.getCharacterWallet(id).balance }), assess: async () => assessment };
  const payment = createCrewEquipmentPayment(), repo = createTableRepository("service:crew-equipment");
  const make = extra => createCrewEquipmentService({ repo, economy, payment, now: () => clock, ...extra });
  const w = { id, funds, assessment, economy, payment, repo, make, service: make() };
  w.command = (type, payload = {}) => ({ commandID: `equipment:${++serial}`, expectedRevision: w.service.snapshot(id).revision, type, payload });
  w.start = payload => w.service.submit(id, w.command("start", { ...policy, ...payload }));
  w.state = () => w.service.snapshot(id).equipment;
  return w;
}
test.after(async () => { clearInterval(require.cache[require.resolve("../src/space/runtime")]?.exports?._tickHandle); await database.shutdown("equipment-tests"); require("../src/gameStore/sqliteStore").close(); await require("../src/utils/rotatingLog").closeAll(); store.cleanup(); });
test.afterEach(() => {
  const repo = createTableRepository("service:crew-equipment"), root = repo.read(gear.TABLE, "/");
  for (const [id, state] of Object.entries(root.data || {})) { state.plan.enabled = false; repo.write(gear.TABLE, `/${id}`, state); }
  repo.flushTableSync(gear.TABLE);
});

test("equipment uses realized operating profits, native debits and bounded independent bonuses", async () => {
  const w = scenario(); await w.start(); const s = w.state();
  assert.equal(s.totalSpent, 1000); assert.equal(wallet.getCharacterWallet(w.id).balance, 499000); assert.equal(s.tiers.mining, 1);
  assert.equal(s.funding.operatingProfit, 898000); assert.equal(s.funding.profitAllowance, 223500);
  assert.equal(gear.forOwner(w.id, "mining").durationBasisPoints, 9500); assert.equal(gear.forOwner(w.id, "hauling").capacityMultiplier, 1);
  assert.equal(s.history.length, 1); assert.equal(gear.committed(w.id), 1000);
});
for (const [name, options, payload, status] of [
  ["no sales", { funds: { netSales: 0 } }, {}, "saving_for_upgrade"],
  ["expenses exhaust profits", { funds: { netSales: 100000, mineralSpent: 99000, refiningTax: 1000 } }, {}, "saving_for_upgrade"],
  ["profit share below equipment price", { funds: { netSales: 105999 } }, {}, "saving_for_upgrade"],
  ["policy budget", {}, { budgetISK: 999 }, "saving_for_upgrade"],
  ["wallet reserve", { balance: 102999 }, { workingCapitalISK: 3000 }, "saving_for_upgrade"],
  ["three replacement batches", { balance: 102999 }, {}, "saving_for_upgrade"],
  ["pending native settlement", { funds: { pending: true } }, {}, "settlement_pending"],
  ["no useful work", { assessment: { candidates: [], status: "waiting_for_useful_work" } }, {}, "waiting_for_useful_work"],
  ["slow payback", { assessment: { candidates: [{ role: "mining", incrementalProfitPerHour: 1 }] } }, {}, "payback_too_long"],
]) test(`equipment waits without spending for ${name}`, async () => {
  const w = scenario(options), balance = wallet.getCharacterWallet(w.id).balance; await w.start(payload);
  assert.equal(w.state().status, status); assert.equal(w.state().totalSpent, 0); assert.equal(wallet.getCharacterWallet(w.id).balance, balance);
  clock += 11000; assert.deepEqual((await w.service.tick()).errors, []); assert.equal(wallet.getCharacterWallet(w.id).balance, balance);
});

test("equipment ranks useful affordable upgrades and stops permanently at three tiers", async () => {
  const w = scenario({ assessment: { candidates: gear.ROLES.map(role => ({ role, incrementalProfitPerHour: role === "manufacturing" ? 10000 : 1000 })) } });
  await w.start({ maxPaybackHours: 168 }); assert.equal(w.state().tiers.manufacturing, 1);
  for (let step = 0; step < 20; step++) { clock += 61000; assert.deepEqual((await w.service.tick()).errors, []); }
  assert.deepEqual(w.state().tiers, { mining: 3, hauling: 3, manufacturing: 3 }); assert.equal(w.state().totalSpent, 117000);
  assert.equal(w.state().history.length, 9); assert.equal(wallet.getCharacterWallet(w.id).balance, 383000);
  assert.equal(gear.forOwner(w.id, "hauling").capacityMultiplier, 1.75); assert.equal(gear.forOwner(w.id, "manufacturing").timeReductionPercent, 15);
  const record = database.read("characters", `/${w.id}`).data; assert.equal(Object.keys(record.crewEquipmentWalletReceipts).length, 9);
});

test("lost supplier debit reply reserves profits and reconstructs once even after ordinary wallet receipts expire", async () => {
  const w = scenario(), debit = w.payment.debit; let lost = true;
  w.payment.debit = async (...args) => { const result = await debit(...args); if (lost) { lost = false; throw Error("equipment debit reply lost"); } return result; };
  await assert.rejects(w.start(), /reply lost/); assert.equal(w.state().tiers.mining, 0); assert.equal(gear.committed(w.id), 1000); assert.ok(w.state().job);
  for (let i = 0; i < 1100; i++) assert.equal(wallet.adjustCharacterBalance(w.id, 0, { idempotencyKey: `equipment-noise:${i}` }).success, true);
  assert.ok(!database.read("characters", `/${w.id}`).data.walletOperationReceipts.some(row => row.idempotencyKey === "crew-equipment:mining:1"));
  w.service = w.make(); w.assessment.candidates = []; assert.deepEqual((await w.service.tick()).errors, []);
  assert.equal(wallet.getCharacterWallet(w.id).balance, 499000); assert.equal(w.state().totalSpent, 1000); assert.equal(w.state().tiers.mining, 1); assert.equal(w.state().history.length, 1);
  clock += 61000; await w.service.tick(); assert.equal(wallet.getCharacterWallet(w.id).balance, 499000);
});

test("an uncertain intent flush cannot debit; stop still finishes an accepted paid upgrade", async () => {
  const w = scenario(); const flush = w.repo.flushTableSync.bind(w.repo); let fail = false;
  const repo = { ...w.repo, flushTableSync(table) { if (fail) { fail = false; return { success: false }; } return flush(table); } };
  const economy = { ...w.economy, assess: async () => { fail = true; return w.assessment; } }; w.service = w.make({ repo, economy });
  await assert.rejects(w.start(), { code: "CREW_STORE_UNAVAILABLE" }); assert.equal(wallet.getCharacterWallet(w.id).balance, 500000);
  w.service = w.make(); await w.service.submit(w.id, w.command("stop"));
  assert.equal(w.state().tiers.mining, 1); assert.equal(w.state().plan.enabled, false); assert.equal(w.state().status, "stopped"); assert.equal(wallet.getCharacterWallet(w.id).balance, 499000);
});

test("equipment policy replay, strict payloads and reserves cannot forge tiers or reset lifetime spending", async () => {
  const w = scenario(), command = w.command("start", policy); const accepted = await w.service.submit(w.id, command);
  assert.equal((await w.service.submit(w.id, command)).replayed, true); assert.equal(w.state().totalSpent, accepted.equipment.totalSpent);
  await assert.rejects(w.service.submit(w.id, { ...command, payload: { ...policy, budgetISK: 5 } }), { code: "CREW_COMMAND_REUSED" });
  await assert.rejects(w.service.submit(w.id, w.command("start", { ...policy, tiers: { mining: 3 } })), { code: "CREW_COMMAND_INVALID" });
  await assert.rejects(w.service.submit(w.id, w.command("start", { ...policy, reinvestPercent: 100 })), { code: "CREW_COMMAND_INVALID" });
  await w.service.submit(w.id, w.command("stop")); clock += 100000; await w.service.tick(); assert.equal(w.state().totalSpent, 1000);
  await w.start({ budgetISK: 1000 }); assert.equal(w.state().totalSpent, 1000); assert.equal(w.state().history.length, 1);
});

test("paid hauling equipment carries a larger native stack and freezes accepted travel timing", async () => {
  const w = scenario({ assessment: { candidates: [{ role: "hauling", incrementalProfitPerHour: 1000 }] } });
  const worldData = require("../src/space/worldData");
  const courier = require("../src/services/crew/crewService").createCrewService({ repo: createTableRepository("service:crew"), inventory: require("../src/services/crew/crewInventory").createCrewInventory({ items }), world: require("../src/services/crew/crewRuntime").createCrewWorld(worldData), character: id => database.read("characters", `/${id}`).data, now: () => clock });
  const order = (type, payload) => ({ commandID: `haul-equipment:${++serial}`, expectedRevision: courier.snapshot(w.id).revision, type, payload });
  courier.submit(w.id, order("create", { name: "Equipment cargo" }));
  items.grantItemToOwnerLocation(w.id, 60000001, 4, 34, 120000);
  const stack = items.listContainerItems(w.id, 60000001, 4).find(item => item.typeID === 34);
  const payload = { destinationStationID: 60000002, itemID: stack.itemID };
  assert.throws(() => courier.submit(w.id, order("deliver", payload)), { code: "CREW_CARGO_CAPACITY" });
  await w.start(); const started = courier.submit(w.id, order("deliver", payload)).crew;
  assert.equal(started.capacityM3, 1250); assert.ok(started.job.cargo.volumeM3 > 1000); assert.equal(started.job.legMs, 28500);
  clock += 61000; await w.service.tick(); assert.equal(w.state().tiers.hauling, 2);
  assert.equal(courier.snapshot(w.id).crew.job.legMs, 28500); assert.equal(courier.snapshot(w.id).crew.capacityM3, 1500);
  clock += 100000; assert.deepEqual(courier.tick().errors, []); assert.equal(courier.snapshot(w.id).crew.history.filter(row => row.cargo).length, 1);
});

test("malformed persisted equipment holds work instead of granting a bonus or spending", async () => {
  const w = scenario(); await w.start(); const saved = w.repo.read(gear.TABLE, `/${w.id}`).data; saved.tiers.mining = 4;
  w.repo.write(gear.TABLE, `/${w.id}`, saved); w.repo.flushTableSync(gear.TABLE); const balance = wallet.getCharacterWallet(w.id).balance;
  assert.throws(() => gear.forOwner(w.id, "mining"), { code: "CREW_STATE_INVALID" }); assert.throws(() => w.make().snapshot(w.id), { code: "CREW_STATE_INVALID" });
  assert.equal(wallet.getCharacterWallet(w.id).balance, balance);
  saved.tiers.mining = 1; w.repo.write(gear.TABLE, `/${w.id}`, saved); w.repo.flushTableSync(gear.TABLE);
});

test("equipment assessment refreshes native profitability and requires demonstrated useful work", async () => {
  const m = { plan: { enabled: true, followProduction: true }, completedDeliveries: 10, job: {} }, r = { plan: { enabled: true, followProduction: true } };
  const c = { standingOrder: { enabled: true, followProduction: true, completedDeliveries: 10 }, job: { cargo: {} } };
  const f = { stationID: 60000001, plan: { enabled: true, orders: [{ recipe: { productTypeID: 215 } }] }, completedBatches: 10, job: { phase: "building", summary: { productTypeID: 215, quantity: 100 } } };
  const s = { plan: { enabled: true }, stationID: 60000001, netRevenue: 5000 }; let profitable = true, calls = 0;
  const economy = createCrewEquipmentEconomy({ mining: () => ({ mining: m }), refining: () => ({ refining: r }), hauling: () => ({ crew: c }), manufacturing: () => ({ manufacturing: f }), selling: () => ({ selling: s }), buying: () => ({}), wallet,
    industry: { async assess(id, station, order, options) { calls++; assert.equal(options.incomingQuantity, f.job ? 100 : 0); return { profit: { allowed: profitable, expectedProfit: 100, totalCost: 80 }, summary: { timeSeconds: 100 } }; } } });
  const tiers = { mining: 0, hauling: 0, manufacturing: 0 };
  assert.equal((await economy.assess(94000, tiers)).candidates.length, 3); profitable = false; assert.equal((await economy.assess(94000, tiers)).candidates.length, 0); assert.equal(calls, 2);
  profitable = true; m.job = null; c.job = null; f.job = null; assert.equal((await economy.assess(94000, tiers)).candidates.length, 0);
});

for (const change of ["factory pauses", "batch size increases"]) test(`equipment discards delayed quotes when ${change}`, async () => {
  const f = { stationID: 60000001, plan: { enabled: true, orders: [{ runs: 1, recipe: { productTypeID: 215 } }] }, completedBatches: 10, job: { jobID: "current-build", phase: "building", summary: { productTypeID: 215, quantity: 100 } } };
  const s = { plan: { enabled: true, orders: [] }, stationID: 60000001 };
  let release, entered, slow = true; const started = new Promise(resolve => { entered = resolve; });
  const economy = createCrewEquipmentEconomy({ mining: () => ({}), refining: () => ({}), hauling: () => ({}), manufacturing: () => ({ manufacturing: structuredClone(f) }), selling: () => ({ selling: structuredClone(s) }), buying: () => ({}), wallet,
    industry: { async assess(id, station, order) { if (slow) { entered(); await new Promise(resolve => { release = resolve; }); } return { profit: { allowed: true, expectedProfit: 100 * order.runs, totalCost: 80 * order.runs }, summary: { timeSeconds: 100 } }; } } });
  const tiers = { mining: 0, hauling: 0, manufacturing: 0 }, pending = economy.assess(94000, tiers); await started;
  if (change === "factory pauses") f.paused = true; else f.plan.orders[0].runs = 100;
  release(); const stale = await pending; assert.deepEqual(stale.candidates, [], "An outdated factory quote approved equipment spending");
  slow = false; const fresh = await economy.assess(94000, tiers);
  if (change === "factory pauses") assert.deepEqual(fresh.candidates, []);
  else { assert.equal(fresh.candidates.length, 1); assert.equal(fresh.workingCapitalISK, 24000); }
});

test("separate server processes recover a durable equipment debit without a second payment", () => {
  const isolated = createIsolatedGameStore({ activate: false }); require("./helpers/crewMarketFixture").seedSellingStatic(isolated);
  try {
    const run = mode => {
      const output = require("node:child_process").execFileSync(process.execPath, [require.resolve("./helpers/crewEquipmentRecovery.cjs"), mode], { env: { ...process.env, ...isolated.env }, windowsHide: true, encoding: "utf8", timeout: 30000 });
      return JSON.parse(output.trim().split(/\r?\n/).at(-1));
    };
    assert.deepEqual(run("interrupt"), { balance: 9000, tier: 0, spent: 0, pending: true, purchases: 0 });
    assert.deepEqual(run("recover"), { balance: 9000, tier: 1, spent: 1000, pending: false, purchases: 1 });
    assert.deepEqual(run("recover"), { balance: 9000, tier: 1, spent: 1000, pending: false, purchases: 1 });
  } finally { isolated.cleanup(); }
});

test("permanent supplier receipts migrate into the actual wallet worker and replay without a debit", () => {
  const isolated = createIsolatedGameStore({ activate: false }); require("./helpers/crewMarketFixture").seedSellingStatic(isolated);
  try {
    const run = mode => {
      const output = require("node:child_process").execFileSync(process.execPath, [require.resolve("./helpers/crewEquipmentRecovery.cjs"), mode], { env: { ...process.env, ...isolated.env }, windowsHide: true, encoding: "utf8", timeout: 30000 });
      return JSON.parse(output.trim().split(/\r?\n/).at(-1));
    };
    assert.deepEqual(run("interrupt"), { balance: 9000, tier: 0, spent: 0, pending: true, purchases: 0 });
    assert.deepEqual(run("wallet-recover"), { balance: 9000, tier: 1, spent: 1000, pending: false, purchases: 1 });
    assert.deepEqual(run("wallet-recover"), { balance: 9000, tier: 1, spent: 1000, pending: false, purchases: 1 });
  } finally { isolated.cleanup(); }
});

test("wallet authority result receipts exclude nested equipment receipt maps", async () => {
  const w = scenario(); await w.start();
  const receiptState = require("../src/services/account/walletAuthorityReceiptState"), owner = require("../src/services/account/walletAuthorityOwnerState");
  const key = "equipment-sanitizer", payload = { charId: w.id, amount: 0 };
  receiptState.executeIdempotently("character.adjust-isk", payload, { commandID: key }, () => ({ success: true, data: { value: 12, crewEquipmentWalletReceipts: { recursive: { crewEquipmentWalletReceipts: {} } } } }));
  const record = owner.getCharacterRecord(w.id), receipt = record.walletAuthorityReceipts.find(row => row.commandID === key);
  assert.ok(record.crewEquipmentWalletReceipts["crew-equipment:mining:1"]); assert.equal(receipt.result.data.value, 12); assert.equal(receipt.result.data.crewEquipmentWalletReceipts, undefined);
});

test("equipment policy crosses owner IPC with token, ownership, origin and revision protections", async () => {
  const service = createCrewEquipmentService({ repo: createTableRepository("service:crew-equipment"), payment: createCrewEquipmentPayment(),
    economy: { funds: () => ({ netSales: 0, mineralSpent: 0, refiningTax: 0, factoryFees: 0, walletBalance: 0, walletReserve: 0 }), assess: async () => ({ candidates: [] }) } });
  const harness = require("./helpers/crewGatewayHarness").createCrewGatewayHarness({ universeFacts: () => ({ actors: [], recentEvents: [] }) }, null, null, null, null, null, service);
  const server = harness.app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`, uri = base + "/_evejs-web/v1/crew/equipment", headers = { "x-evejs-web-token": "equipment-test-token" };
  const command = { commandID: "equipment-gateway", expectedRevision: 0, type: "start", payload: policy };
  const post = (value, extra = {}) => fetch(uri + "/orders", { method: "POST", headers: { ...headers, "content-type": "application/json", ...extra }, body: JSON.stringify({ accountID: 1, characterID: 90001, command: value }) });
  try {
    assert.equal((await fetch(uri + "?accountID=1&characterID=90001")).status, 401);
    assert.equal((await fetch(uri + "?accountID=2&characterID=90001", { headers })).status, 403);
    assert.equal((await post(command, { origin: "https://foreign.invalid" })).status, 403);
    assert.equal((await post(command, { "content-type": "text/plain" })).status, 403);
    assert.equal((await post({ ...command, payload: { ...policy, tiers: { mining: 3 } } })).status, 400);
    const accepted = await post(command, { origin: base }); assert.equal(accepted.status, 200); assert.equal((await accepted.json()).equipment.totalSpent, 0);
    assert.equal((await (await post(command)).json()).replayed, true);
    assert.equal((await post({ ...command, commandID: "stale" })).status, 409);
    const view = await (await fetch(uri + "?accountID=1&characterID=90001", { headers })).json(); assert.equal(view.equipment.upgrades.length, 3); assert.equal(view.equipment.receipts, undefined);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await harness.close(); await service.drain(); }
});
