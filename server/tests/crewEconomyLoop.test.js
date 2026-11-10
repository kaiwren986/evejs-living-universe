"use strict";
const { createIsolatedGameStore } = require("./helpers/isolatedGameStore");
const store = createIsolatedGameStore();
const { seedSellingStatic, createCrewMarketFixture } = require("./helpers/crewMarketFixture");
seedSellingStatic(store);
const test = require("node:test"), assert = require("node:assert/strict"), path = require("node:path");
const database = require("../src/gameStore"), items = require("../src/services/inventory/itemStore");
const { createTableRepository } = require("../src/gameStore/tableRepository");
const worldData = require("../src/space/worldData");
const wallet = require("../src/services/account/walletState");
const industry = require("../src/services/industry/industryRuntimeState");
const nativeMarket = require("../src/services/market/marketProxyService");
const scenes = require("./helpers/miningCrewFixture").createFiniteScenes();
let clock = 0, serial = 0, demand, courier, miners, refiners, factory, sellers, buyers;
const now = () => clock;
function restore() {
  courier = require("../src/services/crew/crewService").createCrewService({ repo: createTableRepository("service:crew"),
    inventory: require("../src/services/crew/crewInventory").createCrewInventory({ items }),
    world: require("../src/services/crew/crewRuntime").createCrewWorld(worldData),
    character: id => database.read("characters", `/${id}`).data, now, legMs: 1000 });
  const crew = id => courier.snapshot(id);
  miners = require("../src/services/crew/miningCrewService").createMiningCrewService({ repo: createTableRepository("service:crew-mining"),
    resources: require("../src/services/crew/miningCrewResources").createMiningCrewResources({ items, worldData, sceneForSystem: scenes.sceneForSystem }),
    crew, now, cycleMs: 1000, travelMs: 1000 });
  refiners = require("../src/services/crew/refiningCrewService").createRefiningCrewService({ repo: createTableRepository("service:crew-refining"),
    inventory: require("../src/services/crew/refiningCrewInventory").createRefiningCrewInventory({ items, worldData }), crew, now, cycleMs: 1000 });
  factory = require("../src/services/crew/manufacturingCrewService").createManufacturingCrewService({ repo: createTableRepository("service:crew-manufacturing"),
    industry: require("../src/services/crew/manufacturingCrewIndustry").createManufacturingCrewIndustry({ items, worldData, selling: id => sellers?.snapshot(id) }), crew, now });
  sellers = require("../src/services/crew/sellingCrewService").createSellingCrewService({ repo: createTableRepository("service:crew-selling"),
    market: require("../src/services/crew/sellingCrewMarket").createSellingCrewMarket({ items, worldData, productionTypes: () => [215, 21857] }), crew, now });
  buyers = require("../src/services/crew/buyingCrewService").createBuyingCrewService({ repo: createTableRepository("service:crew-buying"),
    market: require("../src/services/crew/buyingCrewMarket").createBuyingCrewMarket({ items, worldData, manufacturing: id => factory.snapshot(id), selling: id => sellers.snapshot(id) }), crew, now });
}
restore();
const command = (service, id, type, payload = {}) => service.submit(id, { commandID: `economy:${++serial}`, expectedRevision: service.snapshot(id).revision, type, payload });
const qty = (id, typeID, stationID, flag = 4) => items.listContainerItems(id, stationID, flag).filter(i => i.typeID === typeID).reduce((n, i) => n + i.quantity, 0);
const stock = (id, typeID) => [60000001, 60000003].reduce((n, s) => n + qty(id, typeID, s), 0)
  + qty(id, typeID, database.read("crewRuntime", `/${id}`).data.escrowLocationID, 5)
  + qty(id, typeID, refiners.snapshot(id).refining.escrowLocationID, 5)
  + qty(id, typeID, miners.snapshot(id).mining.escrowLocationID, 5);
async function tick(id, spentMaterials) {
  clock += 1000;
  const current = factory.snapshot(id).manufacturing.job;
  if (current?.phase === "building") industry.markIndustryJobReady(current.nativeJobID);
  // Rotate dispatch order: the real runtime dispatches the asynchronous services together.
  const stages = clock % 2000 ? [buyers, sellers, factory, refiners, miners, courier] : [miners, refiners, courier, factory, sellers, buyers];
  for (const stage of stages) assert.deepEqual((await stage.tick({ budgetMs: 1000 })).errors, []);
  const f = factory.snapshot(id).manufacturing, s = sellers.snapshot(id).selling, b = buyers.snapshot(id).buying, r = refiners.snapshot(id).refining;
  const installed = f.job;
  if (installed && !installed.rejected && installed.phase !== "installing" && !spentMaterials.has(installed.jobID)) spentMaterials.set(installed.jobID, installed.summary.materials);
  // Native factory jobs consume inputs on install, including unfinished jobs.
  for (const typeID of [34, 35]) {
    const consumed = [...spentMaterials.values()].flat().filter(m => m.typeID === typeID).reduce((n, m) => n + m.quantity, 0);
    assert.equal(stock(id, typeID) + consumed, (r.mineralsProduced[typeID] || 0) + (b.purchased[typeID] || 0), `Mineral ${typeID} at ${clock}`);
  }
  assert.equal(wallet.getCharacterWallet(id).balance, Math.round((100000 + s.netRevenue - b.totalSpent - f.totalFeesPaid - r.totalTaxPaid) * 100) / 100, `Wallet at ${clock}`);
  return { f, s, b, r, m: miners.snapshot(id).mining, c: courier.snapshot(id).crew };
}
test.before(async () => {
  demand = await createCrewMarketFixture(path.join(store.storeRoot, "market.json"));
  require("../src/services/market/marketDaemonClient").marketDaemonClient.port = demand.port;
  demand.add({ id: 1, stationID: 60000003, typeID: 215, price: 2 });
  demand.add({ id: 2, stationID: 60000003, typeID: 21857, price: 100 });
  demand.add({ id: 3, stationID: 60000003, typeID: 34, price: 1, bid: false });
  demand.add({ id: 4, stationID: 60000003, typeID: 35, price: 2, bid: false });
});
test.after(async () => {
  await Promise.all([refiners.drain(), factory.drain(), sellers.drain(), buyers.drain()]); await demand.close();
  nativeMarket.__testHooks.stopMarketExpiryPollerForTests(); await nativeMarket.__testHooks.waitForMarketExpiryPollerIdleForTests();
  clearInterval(require.cache[require.resolve("../src/space/runtime")]?.exports?._tickHandle);
  await new Promise(r => setImmediate(r)); await database.shutdown("crew-economy-loop");
  require("../src/gameStore/sqliteStore").close(); await require("../src/utils/rotatingLog").closeAll(); store.cleanup();
});

test("finite mining → refining → mixed hauling → ammo/modules → sales → mineral buying conserves the whole economy", async () => {
  const id = 90700;
  require("./helpers/manufacturingCrewFixture").fundManufacturingPilot(database, items, id, 100000);
  for (const item of items.listContainerItems(id, 60000001, 4)) assert.equal(items.consumeInventoryItemQuantity(item.itemID, item.quantity).success, true);
  await command(courier, id, "create", { name: "Full industrial chain" });
  const rockID = scenes.add(40001, 1200, 1228);
  await command(miners, id, "start", { homeStationID: 60000001, beltID: 40001, typeID: 1228 });
  await command(refiners, id, "start", { stationID: 60000001, typeID: 1228, oreReserve: 0 });
  await command(courier, id, "automate", { sourceStationID: 60000001, destinationStationID: 60000003, typeID: 34, typeIDs: [34,35], sourceReserve: 0 });
  await command(factory, id, "starter", { stationID: 60000003 });
  await command(factory, id, "start", { stationID: 60000003, orders: factory.catalog(id, 60000003).map(b => ({ blueprintID: b.blueprintID, runs: 1, targetStock: b.productTypeID === 215 ? 200 : 2 })) });
  await command(sellers, id, "start", { stationID: 60000003, orders: [{ typeID: 215, reserve: 100, batchSize: 100, minimumPrice: 2 }, { typeID: 21857, reserve: 1, batchSize: 1, minimumPrice: 100 }] });
  await command(buyers, id, "start", { stationID: 60000003, walletReserve: 99000, budgetISK: 10000,
    orders: [{ typeID: 34, targetStock: 94, batchSize: 94, maximumPrice: 1 }, { typeID: 35, targetStock: 21, batchSize: 21, maximumPrice: 2 }] });
  const spentMaterials = new Map(); let state, outagePurchases, outageProduction;
  for (let i = 0; i < 240; i++) {
    if(i===80){demand.setPrice(1,0.01);demand.setPrice(2,0.01);demand.setPrice(3,1000);demand.setPrice(4,1000);outagePurchases=buyers.snapshot(id).buying.totalSpent;}
    if(i===115){
      assert.equal(buyers.snapshot(id).buying.totalSpent,outagePurchases,"An expensive market must not spend the wallet");
      outageProduction=factory.snapshot(id).manufacturing.completedBatches;
      demand.setPrice(1,2);demand.setPrice(2,100);demand.setPrice(3,1);demand.setPrice(4,2);
    }
    state = await tick(id, spentMaterials);
    if (i === 65 || i === 130) { await Promise.all([refiners.drain(), factory.drain(), sellers.drain(), buyers.drain()]); restore(); }
  }
  assert.equal(state.m.totalMined, 1200); assert.equal(state.m.totalDelivered, 1200);
  assert.equal(require("../src/services/mining/miningRuntimeState").getMineableState(scenes.scene, rockID).remainingQuantity, 0);
  assert.equal(state.r.totalOreProcessed, 1200, "No full refining portion may be stranded across unloads");
  assert.ok(state.c.standingOrder.completedDeliveries >= 2);
  assert.ok(state.f.produced[215] >= 300 && state.f.produced[21857] >= 3);
  assert.ok(state.s.sold[215] >= 100 && state.s.sold[21857] >= 1);
  assert.ok(state.b.purchased[34] > 0, "Depleted mining must be supplemented with sale income");
  assert.ok(state.f.completedBatches>outageProduction,"Production must restart after market prices recover");
  assert.ok(state.b.totalSpent <= state.s.netRevenue && state.b.totalSpent <= state.b.plan.budgetISK);
  assert.equal(state.b.purchased[34], 1000000 - demand.remaining(3));
  assert.equal(state.b.purchased[35] || 0, 1000000 - demand.remaining(4));
  assert.ok(wallet.getCharacterWallet(id).balance > 100000, "The configured profitable chain must grow its wallet after taxes and purchases");
  const evidence = { simulatedSeconds: clock / 1000, oreMined: state.m.totalMined, oreRefined: state.r.totalOreProcessed,
    mineralsRefined: state.r.mineralsProduced, produced: state.f.produced, sold: state.s.sold, netSales: state.s.netRevenue,
    mineralsBought: state.b.purchased, purchaseCost: state.b.totalSpent, refiningTax: state.r.totalTaxPaid, factoryFees: state.f.totalFeesPaid,
    wallet: wallet.getCharacterWallet(id).balance, servicesRestored: 2, marketOutageSeconds:35, noPurchasesAboveCeilings:true, conservationCheckedEveryTick: true, eveLaunched: false };
  if (process.env.EVEJS_ECONOMY_EVIDENCE) require("node:fs").writeFileSync(process.env.EVEJS_ECONOMY_EVIDENCE, JSON.stringify(evidence, null, 2) + "\n");
  console.log("ECONOMY_ACCEPTANCE " + JSON.stringify(evidence));
});
