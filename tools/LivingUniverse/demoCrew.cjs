"use strict";
// A disposable local practice world, never the player's database or EVE client.
const path = require("node:path");
const root = path.resolve(__dirname, "../..");
const { createIsolatedGameStore } = require(path.join(root, "server/tests/helpers/isolatedGameStore"));
const { fundManufacturingPilot } = require(path.join(root, "server/tests/helpers/manufacturingCrewFixture"));
const { seedSellingStatic, createCrewMarketFixture } = require(path.join(root, "server/tests/helpers/crewMarketFixture"));
const { createFiniteScenes } = require(path.join(root, "server/tests/helpers/miningCrewFixture"));
const store = createIsolatedGameStore();
seedSellingStatic(store);
store.writeStatic("asteroidBelts", { belts: [{ itemID: 40001, itemName: "Aster I — Scordite field", solarSystemID: 1, typeID: 15, kind: "asteroidBelt" }] });
const names = ["Aster", "Bracken", "Cinder", "Farpoint"];
store.writeStatic("solarSystems", { solarSystems: [1, 2, 3, 99].map((id, index) => ({ solarSystemID: id, solarSystemName: names[index], security: 0.9 })) });
store.writeStatic("stations", { stations: [1, 2, 3, 99].map((id, index) => ({ stationID: 60000000 + id,
  stationName: ["Aster Foundry", "Bracken Anchorage", "Cinder Exchange", "Farpoint Observatory"][index], solarSystemID: id, regionID: 1,
  reprocessingEfficiency: 0.5, reprocessingStationsTake: 0.05, corporationID: 0 })) });
process.env.EVEJS_WEB_GATEWAY_TOKEN = "";
const database = require(path.join(root, "server/src/gameStore"));
const items = require(path.join(root, "server/src/services/inventory/itemStore"));
fundManufacturingPilot(database, items);
const { createTableRepository } = require(path.join(root, "server/src/gameStore/tableRepository"));
const { createCrewService } = require(path.join(root, "server/src/services/crew/crewService"));
const { createCrewInventory } = require(path.join(root, "server/src/services/crew/crewInventory"));
const { createCrewWorld } = require(path.join(root, "server/src/services/crew/crewRuntime"));
const { createCrewGatewayHarness } = require(path.join(root, "server/tests/helpers/crewGatewayHarness"));
const { createMiningCrewService } = require(path.join(root, "server/src/services/crew/miningCrewService"));
const { createMiningCrewResources } = require(path.join(root, "server/src/services/crew/miningCrewResources"));
const { createRefiningCrewService } = require(path.join(root, "server/src/services/crew/refiningCrewService"));
const { createRefiningCrewInventory } = require(path.join(root, "server/src/services/crew/refiningCrewInventory"));
let resourcePlanner,miningTick,courierTick;
const service = createCrewService({ repo: createTableRepository("service:crew"), inventory: createCrewInventory({ items }),
  planning:{courier:(...args)=>resourcePlanner.courier(...args),recheckCourier:(...args)=>resourcePlanner.recheckCourier(...args)},
  world: createCrewWorld(require(path.join(root, "server/src/space/worldData"))),
  character: (id) => database.read("characters", `/${id}`).data, legMs: 6000 });
const scenes = createFiniteScenes(); scenes.add(40001, 6000, 1228);
const planning={mining:(...args)=>resourcePlanner.mining(...args),refining:(...args)=>resourcePlanner.refining(...args)};
const miners = createMiningCrewService({ repo: createTableRepository("service:crew-mining"),
  resources: createMiningCrewResources({ worldData: require(path.join(root, "server/src/space/worldData")), items, sceneForSystem: scenes.sceneForSystem }),
  crew: id => service.snapshot(id), planning, travelMs: 3000, cycleMs: 5000 });
const refiners = createRefiningCrewService({ repo: createTableRepository("service:crew-refining"),
  inventory: createRefiningCrewInventory({ worldData: require(path.join(root, "server/src/space/worldData")), items }),
  crew: id => service.snapshot(id), planning, cycleMs: 3000 });
let sellers;
const manufacturers = require(path.join(root, "server/src/services/crew/manufacturingCrewService")).createManufacturingCrewService({
  repo: createTableRepository("service:crew-manufacturing"),
  industry: require(path.join(root, "server/src/services/crew/manufacturingCrewIndustry")).createManufacturingCrewIndustry({ items, worldData: require(path.join(root, "server/src/space/worldData")), selling: id => sellers?.snapshot(id) }),
  crew: id => service.snapshot(id) });
void start();
async function start() {
const demand = await createCrewMarketFixture(path.join(store.storeRoot, "market-demand.json"));
require(path.join(root, "server/src/services/market/marketDaemonClient")).marketDaemonClient.port = demand.port;
for (const stationID of [60000001, 60000003]) for (const typeID of [215,21857]) demand.add({id:`${stationID}${typeID}`,stationID,typeID,price:typeID===215?2:100});
for (const stationID of [60000001,60000003]) for(const typeID of [34,35]) demand.add({id:`${stationID}${typeID}`,stationID,typeID,price:typeID===34?4:2,bid:false});
sellers = require(path.join(root, "server/src/services/crew/sellingCrewService")).createSellingCrewService({repo:createTableRepository("service:crew-selling"),
  market:require(path.join(root,"server/src/services/crew/sellingCrewMarket")).createSellingCrewMarket({items,worldData:require(path.join(root,"server/src/space/worldData")),productionTypes:id=>manufacturers.snapshot(id).manufacturing?.plan?.orders.map(o=>o.recipe.productTypeID)||[]}),crew:id=>service.snapshot(id)});
const buyers=require(path.join(root,"server/src/services/crew/buyingCrewService")).createBuyingCrewService({repo:createTableRepository("service:crew-buying"),
  market:require(path.join(root,"server/src/services/crew/buyingCrewMarket")).createBuyingCrewMarket({items,worldData:require(path.join(root,"server/src/space/worldData")),manufacturing:id=>manufacturers.snapshot(id),selling:id=>sellers.snapshot(id),projectedSupply:(...args)=>resourcePlanner.forecast(...args)}),crew:id=>service.snapshot(id)});
const worldData=require(path.join(root,"server/src/space/worldData"));
resourcePlanner=require(path.join(root,"server/src/services/crew/crewResourcePlanning")).createCrewResourcePlanning({items,worldData,
  inventory:createRefiningCrewInventory({items,worldData}),resources:createMiningCrewResources({items,worldData,sceneForSystem:scenes.sceneForSystem}),
  crew:id=>service.snapshot(id),manufacturing:id=>manufacturers.snapshot(id),selling:id=>sellers.snapshot(id),mining:id=>miners.snapshot(id),refining:id=>refiners.snapshot(id),buying:id=>buyers.snapshot(id)});
const harness = createCrewGatewayHarness(service, miners, refiners, manufacturers, sellers, buyers);
const timer = setInterval(() => { try {
  if(!miningTick){const pending=miners.plan().then(()=>miners.tick());miningTick=pending;void pending.catch(console.error).finally(()=>{if(miningTick===pending)miningTick=null;});}
  if(!courierTick){const pending=service.plan().then(()=>service.tick());courierTick=pending;void pending.catch(console.error).finally(()=>{if(courierTick===pending)courierTick=null;});}
  void refiners.tick().catch(console.error); void manufacturers.tick().catch(console.error); void sellers.tick().catch(console.error); void buyers.tick().catch(console.error);
} catch (error) { console.error(error); } }, 1000);
const port = Number(process.argv[2] || 40120);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Choose a demo port between 1024 and 65535");
const server = harness.app.listen(port, "127.0.0.1", () => console.log(`X-Command isolated practice world: http://127.0.0.1:${port}/x-command`));
let closing = false;
async function close() {
  if (closing) return; closing = true; clearInterval(timer);
  server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await harness.close();if(miningTick)await miningTick;if(courierTick)await courierTick;await Promise.all([service.drain(),miners.drain(),refiners.drain(), manufacturers.drain(), sellers.drain(), buyers.drain()]); await demand.close();
  clearInterval(require.cache[require.resolve(path.join(root, "server/src/space/runtime"))]?.exports?._tickHandle);
  await new Promise(resolve => setImmediate(resolve));
  await database.shutdown("crew-demo"); require(path.join(root, "server/src/gameStore/sqliteStore")).close();
  await require(path.join(root, "server/src/utils/rotatingLog")).closeAll(); store.cleanup();
}
server.on("error", (error) => { console.error(error); void close().then(() => { process.exitCode = 1; }); });
process.on("SIGINT", () => void close()); process.on("SIGTERM", () => void close());
}
