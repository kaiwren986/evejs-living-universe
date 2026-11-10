"use strict";
const { createIsolatedGameStore } = require("./helpers/isolatedGameStore"), store = createIsolatedGameStore();
const { seedSellingStatic, createCrewMarketFixture } = require("./helpers/crewMarketFixture"); seedSellingStatic(store);
const test = require("node:test"), assert = require("node:assert/strict"), path = require("node:path");
const database = require("../src/gameStore"), items = require("../src/services/inventory/itemStore"), worldData = require("../src/space/worldData");
const { createTableRepository } = require("../src/gameStore/tableRepository");
const wallet = require("../src/services/account/walletState"), native = require("../src/services/industry/industryRuntimeState");
const marketNative = require("../src/services/market/marketProxyService"), { marketDaemonClient } = require("../src/services/market/marketDaemonClient");
let clock = 0, serial = 0, nextID = 90800, demand, factory, sellers, buyers, market;
const courier = require("../src/services/crew/crewService").createCrewService({ repo: createTableRepository("service:crew"),
  inventory: require("../src/services/crew/crewInventory").createCrewInventory({ items }), world: require("../src/services/crew/crewRuntime").createCrewWorld(worldData),
  character: id => database.read("characters", `/${id}`).data, now: () => clock });
const profit = require("../src/services/crew/crewProfitability").createCrewProfitability({ worldData, selling: id => sellers?.snapshot(id), now: () => clock });
const industry = require("../src/services/crew/manufacturingCrewIndustry").createManufacturingCrewIndustry({ items, worldData, profitability: profit });
function restore() {
  factory = require("../src/services/crew/manufacturingCrewService").createManufacturingCrewService({ repo: createTableRepository("service:crew-manufacturing"), industry, crew: id => courier.snapshot(id), now: () => clock });
  sellers = require("../src/services/crew/sellingCrewService").createSellingCrewService({ repo: createTableRepository("service:crew-selling"),
    market: require("../src/services/crew/sellingCrewMarket").createSellingCrewMarket({ items, worldData, productionTypes: () => [215, 21857] }), crew: id => courier.snapshot(id), now: () => clock });
  market = require("../src/services/crew/buyingCrewMarket").createBuyingCrewMarket({ items, worldData, profitability: profit, manufacturing: id => factory.snapshot(id), selling: id => sellers.snapshot(id) });
  buyers = makeBuyer();
}
const makeBuyer = (adapter = market) => require("../src/services/crew/buyingCrewService").createBuyingCrewService({ repo: createTableRepository("service:crew-buying"), market: adapter, crew: id => courier.snapshot(id), now: () => clock });
restore();
const command = (service, id, type, payload = {}) => service.submit(id, { commandID: `profit:${++serial}`, expectedRevision: service.snapshot(id).revision, type, payload });
const qty = (id, typeID) => items.listContainerItems(id, 60000001, 4).filter(i => i.typeID === typeID).reduce((n, i) => n + i.quantity, 0);
async function establish({ income = false, tritanium = true, pyerite = true, sales = true, reserve = 0 } = {}) {
  clock += 100000; const id = nextID++;
  require("./helpers/manufacturingCrewFixture").fundManufacturingPilot(database, items, id, 100000);
  if (!tritanium) for (const i of items.listContainerItems(id, 60000001, 4).filter(i => i.typeID === 34)) items.consumeInventoryItemQuantity(i.itemID, i.quantity);
  if (pyerite) items.grantItemToOwnerLocation(id, 60000001, 4, 35, 21);
  await command(courier, id, "create", { name: "Profit controlled factory" });
  await command(factory, id, "starter", { stationID: 60000001 });
  if (income) items.grantItemToOwnerLocation(id, 60000001, 4, 21857, 1);
  if (sales) await command(sellers, id, "start", { stationID: 60000001, orders: [{ typeID: 215, reserve, batchSize: 100, minimumPrice: 0.01 }, { typeID: 21857, reserve: 0, batchSize: 1, minimumPrice: 0.01 }] });
  const catalog = factory.catalog(id, 60000001);
  return { id, ammo: catalog.find(b => b.productTypeID === 215), module: catalog.find(b => b.productTypeID === 21857) };
}
const startFactory = (id, recipes) => command(factory, id, "start", { stationID: 60000001, orders: recipes.map(r => ({ blueprintID: r.blueprintID, runs: 1, targetStock: r.productTypeID === 215 ? 100 : 1 })) });
const startBuyer = (id, typeID = 35, runtime = buyers, extra = {}) => command(runtime, id, "start", { stationID: 60000001, walletReserve: 99000, budgetISK: 1000,
  orders: [{ typeID, targetStock: typeID === 35 ? 21 : 94, batchSize: 100, maximumPrice: 100 }], ...extra });
async function advance(service, predicate) {
  for (let pass = 0; pass < 8 && !predicate(); pass++) { clock += 10000; assert.deepEqual((await service.tick({ budgetMs: 1000 })).errors, []); }
  assert.ok(predicate(), "Standing order must reach the expected state");
}
test.before(async () => { demand = await createCrewMarketFixture(path.join(store.storeRoot, "market.json")); marketDaemonClient.port = demand.port; });
test.beforeEach(() => {
  demand.resetOrders();
  demand.add({ id: 1, typeID: 215, price: 2 }); demand.add({ id: 2, typeID: 21857, price: 100 });
  demand.add({ id: 3, typeID: 34, price: 1, bid: false }); demand.add({ id: 4, typeID: 35, price: 2, bid: false });
});
test.after(async () => {
  await Promise.all([factory.drain(), sellers.drain(), buyers.drain()]); await demand.close();
  marketNative.__testHooks.stopMarketExpiryPollerForTests(); await marketNative.__testHooks.waitForMarketExpiryPollerIdleForTests();
  clearInterval(require.cache[require.resolve("../src/space/runtime")]?.exports?._tickHandle);
  await new Promise(r => setImmediate(r)); await database.shutdown("crew-profit-tests"); require("../src/gameStore/sqliteStore").close();
  await require("../src/utils/rotatingLog").closeAll(); store.cleanup();
});

test("full recipe replacement costs, native tax and installation fee determine profit", async () => {
  const { id, ammo } = await establish();
  const quote = await profit.evaluate(id, 60000001, ammo, ammo.cost, { targetStock: 100 });
  assert.equal(quote.allowed, true); assert.equal(quote.materialCost, 69); assert.equal(quote.factoryFee, 18);
  assert.equal(quote.grossRevenue, 200); assert.equal(quote.salesTax, 16); assert.equal(quote.netRevenue, 184); assert.equal(quote.expectedProfit, 97);
  const accepted = await startFactory(id, [ammo]); assert.equal(accepted.manufacturing.job.phase, "building");
  assert.equal(accepted.manufacturing.job.summary.profit.expectedProfit, 97);
});

test("owned minerals do not make a loss profitable and neither automation spends", async () => {
  const { id, ammo } = await establish({ income: true }); demand.setPrice(1, 0.5);
  const balance = wallet.getCharacterWallet(id).balance;
  const f = await startFactory(id, [ammo]); assert.equal(f.manufacturing.status, "unprofitable"); assert.equal(f.manufacturing.job, null);
  const b = await startBuyer(id, 35, buyers, { orders: [{ typeID: 35, targetStock: 105, batchSize: 105, maximumPrice: 2 }] });
  assert.equal(b.buying.status, "unprofitable"); assert.equal(b.buying.totalSpent, 0);
  assert.equal(qty(id, 34), 1000); assert.equal(qty(id, 35), 21); assert.equal(wallet.getCharacterWallet(id).balance, balance);
});

test("native tax rounding rejects break-even and admits a one-cent positive margin", async () => {
  const { id, module } = await establish(); demand.setPrice(2, 83.70);
  const equal = await profit.evaluate(id, 60000001, module, module.cost, { targetStock: 1 });
  assert.equal(equal.expectedProfit, 0); assert.equal(equal.allowed, false);
  demand.setPrice(2, 83.71);
  const positive = await profit.evaluate(id, 60000001, module, module.cost, { targetStock: 1 });
  assert.equal(positive.expectedProfit, 0.01); assert.equal(positive.allowed, true);
  const f = await startFactory(id, [module]); assert.equal(f.manufacturing.job.phase, "building");
});

test("all mineral price levels count, including expensive units behind a cheap ask", async () => {
  const { id, ammo } = await establish();
  demand.add({ id: 3, typeID: 34, price: 1, quantity: 26, bid: false });
  demand.add({ id: 5, typeID: 34, price: 100, quantity: 1000, bid: false });
  const f = await startFactory(id, [ammo]); assert.equal(f.manufacturing.status, "unprofitable");
  assert.equal(f.manufacturing.availability[0].profit.materialCost, 168);
});

test("full-batch local demand, selling floors, reserves and mineral quotes are required", async () => {
  const { id, ammo } = await establish({ reserve: 100 });
  assert.equal((await profit.evaluate(id, 60000001, ammo, ammo.cost, { targetStock: 100 })).status, "selling_reserve_blocks_production");
  demand.add({ id: 1, typeID: 215, price: 2, quantity: 99 });
  assert.equal((await profit.evaluate(id, 60000001, ammo, ammo.cost, { targetStock: 200 })).status, "waiting_for_profitable_demand");
  demand.add({ id: 5, typeID: 215, price: 1, quantity: 1 });
  assert.equal((await profit.evaluate(id, 60000001, ammo, ammo.cost, { targetStock: 200 })).allowed, true);
  demand.add({ id: 4, typeID: 35, price: 2, quantity: 20, bid: false });
  assert.equal((await profit.evaluate(id, 60000001, ammo, ammo.cost, { targetStock: 200 })).status, "waiting_for_market_prices");
  await command(sellers, id, "pause");
  assert.equal((await profit.evaluate(id, 60000001, ammo, ammo.cost, { targetStock: 200 })).status, "waiting_for_sales_policy");
});

test("procurement checks the actual selected ask when minimum lots skip the cheaper seller", async () => {
  const { id, ammo } = await establish({ income: true, tritanium: false });
  demand.add({ id: 3, typeID: 34, price: 1, quantity: 27, minVolume: 27, bid: false });
  demand.add({ id: 5, typeID: 34, price: 10, quantity: 1000, bid: false });
  await startFactory(id, [ammo]); const balance = wallet.getCharacterWallet(id).balance;
  const b = await startBuyer(id, 34, buyers, { orders: [{ typeID: 34, targetStock: 27, batchSize: 5, maximumPrice: 10 }] });
  assert.equal(b.buying.status, "unprofitable"); assert.equal(b.buying.totalSpent, 0); assert.equal(qty(id, 34), 0);
  assert.equal(wallet.getCharacterWallet(id).balance, balance); assert.equal(demand.remaining(5), 1000);
});

test("a price drop before purchase debit defers the intent and recovers automatically", async () => {
  const { id, ammo } = await establish({ income: true, pyerite: false }); await startFactory(id, [ammo]);
  let change = true;
  const runtime = makeBuyer({ ...market, async prepare(...args) { const result = await market.prepare(...args); if (result.ready && change) { change = false; demand.setPrice(1, 0.5); } return result; } });
  const balance = wallet.getCharacterWallet(id).balance; const b = await startBuyer(id, 35, runtime);
  assert.equal(b.buying.status, "unprofitable"); assert.equal(b.buying.job, null); assert.equal(b.buying.totalSpent, 0);
  assert.equal(wallet.getCharacterWallet(id).balance, balance);
  demand.setPrice(1, 2); await advance(runtime, () => runtime.snapshot(id).buying.completedPurchases === 1);
  assert.equal(qty(id, 35), 21); assert.equal(wallet.getCharacterWallet(id).balance, balance - 42);
});

test("a price drop before installation spends no fee and the queue resumes after reconstruction", async () => {
  const { id, ammo } = await establish(); let change = true;
  const adapter = { ...industry, async install(job) { if (change) { change = false; demand.setPrice(1, 0.5); } return industry.install(job); } };
  const runtime = require("../src/services/crew/manufacturingCrewService").createManufacturingCrewService({ repo: createTableRepository("service:crew-manufacturing"), industry: adapter, crew: id => courier.snapshot(id), now: () => clock });
  const before = wallet.getCharacterWallet(id).balance;
  await command(runtime, id, "start", { stationID: 60000001, orders: [{ blueprintID: ammo.blueprintID, runs: 1, targetStock: 100 }] });
  assert.equal(runtime.snapshot(id).manufacturing.status, "unprofitable"); assert.equal(runtime.snapshot(id).manufacturing.job, null);
  assert.equal(qty(id, 34), 1000); assert.equal(wallet.getCharacterWallet(id).balance, before);
  demand.setPrice(1, 2); restore(); await advance(factory, () => factory.snapshot(id).manufacturing.job?.phase === "building");
});

test("an already-debited purchase confirms exactly once after prices turn unprofitable", async () => {
  const { id, ammo } = await establish({ income: true, pyerite: false }); await startFactory(id, [ammo]);
  const balance = wallet.getCharacterWallet(id).balance; demand.dropNextFill(); const b = await startBuyer(id);
  assert.equal(b.buying.job.phase, "buying"); assert.equal(wallet.getCharacterWallet(id).balance, balance - 42);
  demand.setPrice(1, 0.5); restore(); await advance(buyers, () => buyers.snapshot(id).buying.completedPurchases === 1);
  assert.equal(qty(id, 35), 21); assert.equal(wallet.getCharacterWallet(id).balance, balance - 42);
  await advance(factory, () => factory.snapshot(id).manufacturing.status === "unprofitable");
  assert.equal(factory.snapshot(id).manufacturing.job, null);
});

test("a mixed queue buys only the profitable recipe's shortage", async () => {
  const { id, ammo, module } = await establish({ income: true, tritanium: false }); demand.setPrice(2, 50);
  await startFactory(id, [module, ammo]); const b = await startBuyer(id, 34);
  assert.equal(b.buying.purchased[34], 27); assert.equal(b.buying.totalSpent, 27);
  await advance(factory, () => factory.snapshot(id).manufacturing.job?.phase === "building");
  assert.equal(factory.snapshot(id).manufacturing.job.summary.productTypeID, 215);
});

test("already-installed jobs recover and deliver once after a price drop", async () => {
  const { id, module } = await establish(); let fault = true;
  const runtime = require("../src/services/crew/manufacturingCrewService").createManufacturingCrewService({ repo: createTableRepository("service:crew-manufacturing"),
    industry: { ...industry, async install(job) { const result = await industry.install(job); if (fault) { fault = false; throw Error("Lost install confirmation"); } return result; } },
    crew: id => courier.snapshot(id), now: () => clock });
  const before = wallet.getCharacterWallet(id).balance;
  await assert.rejects(command(runtime, id, "start", { stationID: 60000001, orders: [{ blueprintID: module.blueprintID, runs: 1, targetStock: 1 }] }));
  assert.equal(wallet.getCharacterWallet(id).balance, before - 10);
  demand.setPrice(2, 1); restore(); await advance(factory, () => factory.snapshot(id).manufacturing.job?.phase === "building");
  const job = factory.snapshot(id).manufacturing.job; native.markIndustryJobReady(job.nativeJobID);
  await advance(factory, () => factory.snapshot(id).manufacturing.completedBatches === 1);
  assert.equal(qty(id, 21857), 1); assert.equal(wallet.getCharacterWallet(id).balance, before - 10);
  assert.equal(factory.snapshot(id).manufacturing.totalFeesPaid, 10);
});

test("selling minimum lots cannot strand production behind a small surplus target", async () => {
  const { id, ammo } = await establish({ reserve: 50 });
  demand.add({ id: 1, typeID: 215, price: 2, minVolume: 80 });
  const q = await profit.evaluate(id, 60000001, ammo, ammo.cost, { targetStock: 100 });
  assert.equal(q.allowed, false); assert.equal(q.status, "waiting_for_profitable_demand");
});

test("a satisfied recipe does not make stocked profitable minerals look blocked", async () => {
  const { id, ammo, module } = await establish({ income: true, pyerite: false });
  items.grantItemToOwnerLocation(id, 60000001, 4, 215, 100);
  await startFactory(id, [ammo, module]);
  const b = await startBuyer(id, 34, buyers, { orders: [{ typeID: 34, targetStock: 94, batchSize: 94, maximumPrice: 1 }, { typeID: 35, targetStock: 21, batchSize: 21, maximumPrice: 2 }] });
  assert.equal(b.buying.status, "production_targets_covered"); assert.equal(b.buying.totalSpent, 0);
});

test("unknown market outcomes fail closed before native effects", async () => {
  const { id, ammo } = await establish({ income: true, pyerite: false });
  const call = marketDaemonClient.call; marketDaemonClient.call = async () => { throw Error("Isolated market outage"); };
  const before = wallet.getCharacterWallet(id).balance;
  try {
    const f = await startFactory(id, [ammo]); assert.equal(f.manufacturing.status, "market_unavailable"); assert.equal(f.manufacturing.job, null);
    const b = await startBuyer(id); assert.equal(b.buying.status, "market_unavailable"); assert.equal(b.buying.totalSpent, 0);
    assert.equal(wallet.getCharacterWallet(id).balance, before);
  } finally { marketDaemonClient.call = call; }
});
