"use strict";
const {createIsolatedGameStore}=require("./helpers/isolatedGameStore"),store=createIsolatedGameStore();
const {seedSellingStatic,createCrewMarketFixture}=require("./helpers/crewMarketFixture");seedSellingStatic(store);
store.writeStatic("asteroidBelts",{belts:Array.from({length:256},(_,i)=>({itemID:40001+i,itemName:`Production field ${i+1}`,solarSystemID:1,typeID:15,kind:"asteroidBelt"}))});
const test=require("node:test"),assert=require("node:assert/strict"),path=require("node:path"),fs=require("node:fs");
const database=require("../src/gameStore"),items=require("../src/services/inventory/itemStore"),worldData=require("../src/space/worldData");
const {createTableRepository}=require("../src/gameStore/tableRepository"),wallet=require("../src/services/account/walletState");
const nativeMarket=require("../src/services/market/marketProxyService"),{marketDaemonClient}=require("../src/services/market/marketDaemonClient");
let clock=0,serial=0,nextID=91000,field=40001,demand,current;const evidence=[];
const now=()=>clock;
const command=(service,id,type,payload={})=>service.submit(id,{commandID:`resources:${++serial}`,expectedRevision:service.snapshot(id).revision,type,payload});
const qty=(id,type,station=60000001,flag=4)=>items.listContainerItems(id,station,flag).filter(i=>i.typeID===type).reduce((n,i)=>n+i.quantity,0);
async function establish({targetT=67,targetP=21,veld=2000,scordite=2000,sourceReserve=0,followCourier=false,budgetISK=1000}={}){
  clock+=100000;const id=nextID++,veldBelt=field++,scordBelt=field++,scenes=require("./helpers/miningCrewFixture").createFiniteScenes();
  if(veld)scenes.add(veldBelt,veld,1230);if(scordite)scenes.add(scordBelt,scordite,1228);
  require("./helpers/manufacturingCrewFixture").fundManufacturingPilot(database,items,id,100000);
  for(const item of items.listContainerItems(id,60000001,4).filter(i=>i.typeID===34))items.consumeInventoryItemQuantity(item.itemID,item.quantity);
  const w={id,veldBelt,scordBelt,scenes,belts:new Set([veldBelt,scordBelt])};
  const addField=scenes.add;scenes.add=(beltID,...args)=>{w.belts.add(beltID);return addField(beltID,...args);};
  w.inventory=require("../src/services/crew/refiningCrewInventory").createRefiningCrewInventory({items,worldData});
  // Cases share static lookup tables, but their finite scene/catalog is private.
  // Earlier empty fixture belts must not consume the native 128-site scan bound.
  const resourceWorld={...worldData,getAsteroidBeltsForSystem:systemID=>worldData.getAsteroidBeltsForSystem(systemID).filter(site=>w.belts.has(site.itemID))};
  w.resources=require("../src/services/crew/miningCrewResources").createMiningCrewResources({items,worldData:resourceWorld,sceneForSystem:scenes.sceneForSystem});
  w.courierInventory=require("../src/services/crew/crewInventory").createCrewInventory({items});
  w.courierPlanning={courier:(...args)=>w.planner.courier(...args),recheckCourier:(...args)=>w.planner.recheckCourier(...args)};
  w.restore=()=>{
    w.courier=require("../src/services/crew/crewService").createCrewService({repo:createTableRepository("service:crew"),
      inventory:w.courierInventory,planning:w.courierPlanning,world:require("../src/services/crew/crewRuntime").createCrewWorld(worldData),character:id=>database.read("characters",`/${id}`).data,now,legMs:1000});
    const crew=id=>w.courier.snapshot(id),planning={mining:(...args)=>w.planner.mining(...args),refining:(...args)=>w.planner.refining(...args)};
    w.miners=require("../src/services/crew/miningCrewService").createMiningCrewService({repo:createTableRepository("service:crew-mining"),resources:w.resources,crew,planning,now,cycleMs:1000,travelMs:1000});
    w.refiners=require("../src/services/crew/refiningCrewService").createRefiningCrewService({repo:createTableRepository("service:crew-refining"),inventory:w.inventory,crew,planning,now,cycleMs:1000});
    w.industry=require("../src/services/crew/manufacturingCrewIndustry").createManufacturingCrewIndustry({items,worldData,selling:id=>w.sellers?.snapshot(id)});
    w.factory=require("../src/services/crew/manufacturingCrewService").createManufacturingCrewService({repo:createTableRepository("service:crew-manufacturing"),industry:w.industry,crew,now});
    w.sellers=require("../src/services/crew/sellingCrewService").createSellingCrewService({repo:createTableRepository("service:crew-selling"),
      market:require("../src/services/crew/sellingCrewMarket").createSellingCrewMarket({items,worldData,productionTypes:()=>[215,21857]}),crew,now});
    w.buyers=require("../src/services/crew/buyingCrewService").createBuyingCrewService({repo:createTableRepository("service:crew-buying"),
      market:require("../src/services/crew/buyingCrewMarket").createBuyingCrewMarket({items,worldData,manufacturing:id=>w.factory.snapshot(id),selling:id=>w.sellers.snapshot(id),projectedSupply:(...args)=>w.planner.forecast(...args)}),crew,now});
    w.planner=require("../src/services/crew/crewResourcePlanning").createCrewResourcePlanning({items,worldData,inventory:w.inventory,resources:w.resources,industry:w.industry,crew,
      manufacturing:id=>w.factory.snapshot(id),selling:id=>w.sellers.snapshot(id),mining:id=>w.miners.snapshot(id),refining:id=>w.refiners.snapshot(id),buying:id=>w.buyers.snapshot(id),now});
  };
  w.restore();current=w;
  await command(w.courier,id,"create",{name:"Ore follows production"});
  await command(w.courier,id,"automate",{sourceStationID:60000001,destinationStationID:60000003,typeID:34,typeIDs:[34,35],sourceReserve,...(followCourier?{followProduction:true}:{})});
  await command(w.factory,id,"starter",{stationID:60000003});const catalog=w.factory.catalog(id,60000003);
  await command(w.sellers,id,"start",{stationID:60000003,orders:[{typeID:215,reserve:0,batchSize:100,minimumPrice:0.01},{typeID:21857,reserve:0,batchSize:1,minimumPrice:0.01}]});
  await command(w.factory,id,"start",{stationID:60000003,orders:catalog.map(b=>({blueprintID:b.blueprintID,runs:1,targetStock:b.productTypeID===215?200:2}))});
  await command(w.buyers,id,"start",{stationID:60000003,walletReserve:100000,budgetISK,orders:[{typeID:34,targetStock:targetT,batchSize:1000,maximumPrice:1},{typeID:35,targetStock:targetP,batchSize:1000,maximumPrice:2}]});
  await command(w.refiners,id,"start",{stationID:60000001,typeID:1228,oreReserve:0,followProduction:true});
  return w;
}
async function startMiners(w){return command(w.miners,w.id,"start",{homeStationID:60000001,beltID:w.scordBelt,typeID:1228,followProduction:true});}
async function mineStep(w,seconds=1){clock+=seconds*1000;assert.deepEqual((await w.miners.plan({budgetMs:1000})).errors,[]);assert.deepEqual(w.miners.tick({budgetMs:1000}).errors,[]);}
async function refineStep(w,seconds=1,errors=0){clock+=seconds*1000;assert.equal((await w.refiners.tick({budgetMs:1000})).errors.length,errors);}
async function courierStep(w,seconds=1,errors=0){clock+=seconds*1000;assert.deepEqual((await w.courier.plan({budgetMs:1000})).errors,[]);assert.equal(w.courier.tick({budgetMs:1000}).errors.length,errors);}
test.before(async()=>{demand=await createCrewMarketFixture(path.join(store.storeRoot,"market.json"));marketDaemonClient.port=demand.port;});
test.beforeEach(()=>{demand.resetOrders();demand.add({id:1,stationID:60000003,typeID:215,price:2});demand.add({id:2,stationID:60000003,typeID:21857,price:200});
  demand.add({id:3,stationID:60000003,typeID:34,price:1,bid:false});demand.add({id:4,stationID:60000003,typeID:35,price:2,bid:false});});
test.afterEach(async()=>{
  const w=current;if(!w)return;
  if(w.equipment?.snapshot(w.id).equipment?.plan.enabled)await command(w.equipment,w.id,"stop");
  for(const[service,key]of [[w.miners,"mining"],[w.refiners,"refining"],[w.factory,"manufacturing"],[w.sellers,"selling"],[w.buyers,"buying"]]){
    const state=service.snapshot(w.id)[key];if(state?.plan?.enabled)await command(service,w.id,"stop");
  }
  if(w.courier.snapshot(w.id).crew.standingOrder?.enabled)await command(w.courier,w.id,"stop");
  for(let i=0;i<12;i++){
    clock+=10000;w.miners.tick({budgetMs:1000});await w.refiners.tick({budgetMs:1000});
    const job=w.factory.snapshot(w.id).manufacturing.job;if(job?.phase==="building")require("../src/services/industry/industryRuntimeState").markIndustryJobReady(job.nativeJobID);
    await w.factory.tick({budgetMs:1000});await w.sellers.tick({budgetMs:1000});await w.buyers.tick({budgetMs:1000});w.courier.tick({budgetMs:1000});
    if(!w.miners.snapshot(w.id).mining?.job&&!w.refiners.snapshot(w.id).refining?.job&&!w.factory.snapshot(w.id).manufacturing?.job&&!w.courier.snapshot(w.id).crew.job)break;
  }
  await Promise.all([w.courier.drain(),w.miners.drain(),w.refiners.drain(),w.factory.drain(),w.sellers.drain(),w.buyers.drain()]);current=null;
});
test.after(async()=>{
  if(process.env.EVEJS_RESOURCE_EVIDENCE)fs.writeFileSync(process.env.EVEJS_RESOURCE_EVIDENCE,JSON.stringify({decisions:evidence,eveLaunched:false},null,2)+"\n");
  await demand.close();nativeMarket.__testHooks.stopMarketExpiryPollerForTests();await nativeMarket.__testHooks.waitForMarketExpiryPollerIdleForTests();
  clearInterval(require.cache[require.resolve("../src/space/runtime")]?.exports?._tickHandle);await new Promise(r=>setImmediate(r));await database.shutdown("crew-resources-tests");
  require("../src/gameStore/sqliteStore").close();await require("../src/utils/rotatingLog").closeAll();store.cleanup();
});

test("miners choose Tritanium-rich ore for the best module recipe",async()=>{
  const w=await establish();await startMiners(w);await mineStep(w);
  const state=w.miners.snapshot(w.id).mining;assert.equal(state.plan.typeID,1230);assert.equal(state.plan.beltID,w.veldBelt);assert.equal(state.job.quantityLimit,100);
  assert.equal(state.priority.productTypeID,21857);assert.equal(wallet.getCharacterWallet(w.id).balance,100000);
  evidence.push({case:"module_needs_tritanium",priority:state.priority});
});

test("a price change and Pyerite shortage select Scordite instead of Veldspar",async()=>{
  demand.setPrice(2,50);const w=await establish();items.grantItemToOwnerLocation(w.id,60000001,4,34,67);
  await startMiners(w);await mineStep(w);const state=w.miners.snapshot(w.id).mining;
  assert.equal(state.plan.typeID,1228);assert.equal(state.priority.productTypeID,215);
  assert.equal(state.priority.deficits.find(m=>m.typeID===35).missing,21);
  evidence.push({case:"ammo_needs_pyerite",priority:state.priority});
});

test("refiners choose the needed ore and limit tax to useful complete portions",async()=>{
  const w=await establish();items.grantItemToOwnerLocation(w.id,60000001,4,1230,1000);items.grantItemToOwnerLocation(w.id,60000001,4,1228,1000);
  await refineStep(w,10);let state=w.refiners.snapshot(w.id).refining;
  assert.equal(state.plan.typeID,1230);assert.equal(state.job.quote.quantityToProcess,100);assert.equal(qty(w.id,1230),900);assert.equal(qty(w.id,1228),1000);
  await refineStep(w);state=w.refiners.snapshot(w.id).refining;assert.equal(state.totalOreProcessed,100);assert.equal(state.mineralsProduced[34],200);
  assert.equal(state.totalTaxPaid,20);assert.equal(wallet.getCharacterWallet(w.id).balance,99980);
});

test("queued ore and minerals in transit prevent redundant mining",async()=>{
  const w=await establish();items.grantItemToOwnerLocation(w.id,60000001,4,1230,100);items.grantItemToOwnerLocation(w.id,60000001,4,1228,100);
  await startMiners(w);await mineStep(w);assert.equal(w.miners.snapshot(w.id).mining.status,"stock_target_met");assert.equal(w.miners.snapshot(w.id).mining.job,null);
  assert.equal(w.miners.snapshot(w.id).mining.totalMined,0);
});

test("stocked working buffers hold both crews without extraction or refining tax",async()=>{
  const w=await establish();items.grantItemToOwnerLocation(w.id,60000003,4,34,200);items.grantItemToOwnerLocation(w.id,60000003,4,35,45);
  items.grantItemToOwnerLocation(w.id,60000001,4,1230,1000);await startMiners(w);await mineStep(w);await refineStep(w,10);
  assert.equal(w.miners.snapshot(w.id).mining.status,"stock_target_met");assert.equal(w.refiners.snapshot(w.id).refining.status,"stock_target_met");
  assert.equal(wallet.getCharacterWallet(w.id).balance,100000);assert.equal(qty(w.id,1230),1000);
});

test("a paused mineral route blocks new source work and resuming it restores planning",async()=>{
  const w=await establish();await command(w.courier,w.id,"pause");items.grantItemToOwnerLocation(w.id,60000001,4,1230,100);
  await startMiners(w);await mineStep(w);await refineStep(w,10);
  assert.equal(w.miners.snapshot(w.id).mining.status,"waiting_for_supply_route");assert.equal(w.refiners.snapshot(w.id).refining.status,"waiting_for_supply_route");
  await command(w.courier,w.id,"resume");await refineStep(w,10);assert.equal(w.refiners.snapshot(w.id).refining.job.quote.typeID,1230);
});

test("finite depletion changes the next ore without replenishing the exhausted rock",async()=>{
  const w=await establish({veld:50});await startMiners(w);
  for(let i=0;i<4;i++)await mineStep(w);
  assert.equal(w.miners.snapshot(w.id).mining.totalDelivered,50);await mineStep(w);
  const state=w.miners.snapshot(w.id).mining;assert.equal(state.plan.typeID,1228);assert.equal(state.plan.enabled,true);
  assert.equal(require("../src/services/mining/miningRuntimeState").getMineableState(w.scenes.scene,w.veldBelt+100000).remainingQuantity,0);
});

test("an accepted trip survives a price change and reconstruction before switching ore",async()=>{
  const w=await establish();await startMiners(w);await mineStep(w);const job=w.miners.snapshot(w.id).mining.job.jobID;
  demand.setPrice(2,50);w.restore();assert.equal(w.miners.snapshot(w.id).mining.job.jobID,job);assert.equal(w.miners.snapshot(w.id).mining.plan.typeID,1230);
  for(let i=0;i<3;i++)await mineStep(w);assert.equal(w.miners.snapshot(w.id).mining.totalDelivered,100);
  await mineStep(w);assert.equal(w.miners.snapshot(w.id).mining.plan.typeID,1228);assert.equal(w.miners.snapshot(w.id).mining.history[0].cargo.typeID,1230);
});

test("an accepted refinery batch finishes once, then switches to the new mineral shortage",async()=>{
  const w=await establish();items.grantItemToOwnerLocation(w.id,60000001,4,1230,100);items.grantItemToOwnerLocation(w.id,60000001,4,1228,100);
  await refineStep(w,10);assert.equal(w.refiners.snapshot(w.id).refining.job.quote.typeID,1230);demand.setPrice(2,50);
  await refineStep(w);await refineStep(w);assert.equal(w.refiners.snapshot(w.id).refining.job.quote.typeID,1228);
  await refineStep(w);assert.equal(w.refiners.snapshot(w.id).refining.completedBatches,2);assert.equal(qty(w.id,35),45);
});

test("unprofitable production holds extraction and tax until sale prices recover",async()=>{
  demand.setPrice(1,0.1);demand.setPrice(2,1);const w=await establish();items.grantItemToOwnerLocation(w.id,60000001,4,1230,100);
  await startMiners(w);await mineStep(w);await refineStep(w,10);
  assert.equal(w.miners.snapshot(w.id).mining.status,"unprofitable");assert.equal(w.refiners.snapshot(w.id).refining.status,"unprofitable");
  assert.equal(wallet.getCharacterWallet(w.id).balance,100000);demand.setPrice(2,200);await refineStep(w,10);assert.ok(w.refiners.snapshot(w.id).refining.job);
});

test("a tiny mineral gap does not justify a more expensive refining tax",async()=>{
  demand.setPrice(2,50);const w=await establish();items.grantItemToOwnerLocation(w.id,60000003,4,34,67);items.grantItemToOwnerLocation(w.id,60000003,4,35,20);
  items.grantItemToOwnerLocation(w.id,60000001,4,1228,1000);await refineStep(w,10);
  assert.equal(w.refiners.snapshot(w.id).refining.status,"ore_not_economical");assert.equal(wallet.getCharacterWallet(w.id).balance,100000);
});

test("a lost native refining reply cannot double-count projected minerals",async()=>{
  const w=await establish({targetT:300});items.grantItemToOwnerLocation(w.id,60000001,4,1230,100);items.grantItemToOwnerLocation(w.id,60000003,4,35,45);
  const settle=w.inventory.settle;let fault=true;w.inventory.settle=async s=>{const result=await settle(s);if(fault){fault=false;throw Error("Lost native reply");}return result;};
  await refineStep(w,10);await refineStep(w,1,1);assert.equal(qty(w.id,34),200);
  await startMiners(w);await mineStep(w);assert.ok(w.miners.snapshot(w.id).mining.job);assert.equal(w.miners.snapshot(w.id).mining.priority.deficits.find(m=>m.typeID===34).missing,100);
});

test("source mineral reserves remain unavailable to the downstream factory",async()=>{
  const w=await establish({targetT:335,sourceReserve:100});items.grantItemToOwnerLocation(w.id,60000001,4,34,150);await startMiners(w);await mineStep(w);
  const state=w.miners.snapshot(w.id).mining;assert.equal(state.priority.deficits.find(m=>m.typeID===34).available,50);assert.equal(state.job.quantityLimit,200);
});

test("production-following controls stay strict and disabling them preserves the current trip",async()=>{
  const w=await establish();await startMiners(w);await mineStep(w);const before=w.miners.snapshot(w.id).mining.job.jobID;
  assert.throws(()=>command(w.miners,w.id,"prioritize",{enabled:"true"}),{code:"CREW_COMMAND_INVALID"});
  assert.throws(()=>command(w.miners,w.id,"prioritize",{enabled:true,ownerID:1}),{code:"CREW_COMMAND_INVALID"});
  await assert.rejects(command(w.refiners,w.id,"prioritize",{enabled:true,typeID:1230}),{code:"CREW_COMMAND_INVALID"});
  await command(w.miners,w.id,"prioritize",{enabled:false});assert.equal(w.miners.snapshot(w.id).mining.job.jobID,before);
  assert.equal(w.miners.snapshot(w.id).mining.plan.followProduction,false);
});

test("procurement waits for economical local ore instead of buying its projected minerals",async()=>{
  const w=await establish();items.grantItemToOwnerLocation(w.id,60000001,4,1230,100);items.grantItemToOwnerLocation(w.id,60000001,4,1228,100);
  items.grantItemToOwnerLocation(w.id,60000003,4,21857,1);clock+=10000;await w.sellers.tick({budgetMs:1000});
  await w.buyers.tick({budgetMs:1000});const state=w.buyers.snapshot(w.id).buying;
  assert.equal(state.status,"waiting_for_local_supply");assert.equal(state.totalSpent,0);assert.equal(state.projectedSupply[34],200);
  assert.equal(wallet.getCharacterWallet(w.id).balance,100184);
  items.grantItemToOwnerLocation(w.id,60000003,4,34,67);items.grantItemToOwnerLocation(w.id,60000003,4,35,21);
  clock+=10000;await w.buyers.tick({budgetMs:1000});
  assert.equal(w.buyers.snapshot(w.id).buying.status,"stock_target_met");assert.equal(w.buyers.snapshot(w.id).buying.totalSpent,0);
});

test("procurement can buy a tiny gap when refining the available ore costs more",async()=>{
  demand.setPrice(2,50);const w=await establish();items.grantItemToOwnerLocation(w.id,60000003,4,34,67);items.grantItemToOwnerLocation(w.id,60000003,4,35,20);
  items.grantItemToOwnerLocation(w.id,60000001,4,1228,1000);items.grantItemToOwnerLocation(w.id,60000003,4,21857,1);
  clock+=10000;await w.sellers.tick({budgetMs:1000});await w.buyers.tick({budgetMs:1000});
  assert.equal(w.buyers.snapshot(w.id).buying.totalSpent,2);assert.equal(qty(w.id,35,60000003),21);assert.equal(qty(w.id,1228),1000);
});

test("production-directed ore flows through all six crews with conserved minerals and ISK",async()=>{
  const w=await establish({veld:300,scordite:300});await startMiners(w);const consumed=new Map();
  for(let step=0;step<110;step++){
    clock+=1000;assert.deepEqual((await w.miners.plan({budgetMs:1000})).errors,[]);assert.deepEqual(w.miners.tick({budgetMs:1000}).errors,[]);
    assert.deepEqual((await w.refiners.tick({budgetMs:1000})).errors,[]);assert.deepEqual(w.courier.tick({budgetMs:1000}).errors,[]);
    const existing=w.factory.snapshot(w.id).manufacturing.job;if(existing?.phase==="building")require("../src/services/industry/industryRuntimeState").markIndustryJobReady(existing.nativeJobID);
    assert.deepEqual((await w.factory.tick({budgetMs:1000})).errors,[]);assert.deepEqual((await w.sellers.tick({budgetMs:1000})).errors,[]);assert.deepEqual((await w.buyers.tick({budgetMs:1000})).errors,[]);
    const m=w.miners.snapshot(w.id).mining,r=w.refiners.snapshot(w.id).refining,f=w.factory.snapshot(w.id).manufacturing,s=w.sellers.snapshot(w.id).selling,b=w.buyers.snapshot(w.id).buying;
    if(f.job?.phase==="building"&&!consumed.has(f.job.jobID))consumed.set(f.job.jobID,f.job.summary.materials);
    assert.equal(wallet.getCharacterWallet(w.id).balance,Math.round((100000+s.netRevenue-r.totalTaxPaid-f.totalFeesPaid-b.totalSpent)*100)/100);
    const locations=[[60000001,4],[60000003,4],[m.escrowLocationID,5],[r.escrowLocationID,5],[database.read("crewRuntime",`/${w.id}`).data.escrowLocationID,5]];
    for(const type of [34,35]){
      const stock=locations.reduce((n,[location,flag])=>n+qty(w.id,type,location,flag),0),used=[...consumed.values()].flat().filter(x=>x.typeID===type).reduce((n,x)=>n+x.quantity,0);
      assert.equal(stock+used,(r.mineralsProduced[type]||0)+(b.purchased[type]||0),`Mineral ${type} at step ${step}`);
    }
    const ore=locations.reduce((n,[location,flag])=>n+qty(w.id,1230,location,flag)+qty(w.id,1228,location,flag),0);
    assert.equal(ore+r.totalOreProcessed,m.totalMined);
  }
  const m=w.miners.snapshot(w.id).mining,r=w.refiners.snapshot(w.id).refining,f=w.factory.snapshot(w.id).manufacturing,s=w.sellers.snapshot(w.id).selling,b=w.buyers.snapshot(w.id).buying;
  assert.ok(m.history.some(h=>h.cargo.typeID===1230)&&m.history.some(h=>h.cargo.typeID===1228));
  assert.ok(r.mineralsProduced[34]>0&&r.mineralsProduced[35]>0);assert.ok(f.produced[215]>=100&&f.produced[21857]>=1);assert.ok(s.netRevenue>0);
  assert.ok(wallet.getCharacterWallet(w.id).balance>100000);
  evidence.push({case:"all_six_crews",oreMined:m.totalMined,oreRefined:r.totalOreProcessed,minerals:r.mineralsProduced,produced:f.produced,sold:s.sold,
    saleIncome:s.netRevenue,purchases:b.totalSpent,refiningTax:r.totalTaxPaid,factoryFees:f.totalFeesPaid,wallet:wallet.getCharacterWallet(w.id).balance,conservationTicks:110});
});

test("a stopped mining assignment cannot apply an asynchronous stale production decision",async()=>{
  const w=await establish();let release,entered;
  const started=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  w.miners=require("../src/services/crew/miningCrewService").createMiningCrewService({repo:createTableRepository("service:crew-mining"),resources:w.resources,
    crew:id=>w.courier.snapshot(id),planning:{async mining(...args){entered();await gate;return w.planner.mining(...args);}},now,cycleMs:1000,travelMs:1000});
  await startMiners(w);clock+=1000;const pending=w.miners.plan({budgetMs:1000});await started;
  await command(w.miners,w.id,"stop");release();assert.deepEqual((await pending).errors,[]);w.miners.tick({budgetMs:1000});
  assert.equal(w.miners.snapshot(w.id).mining.job,null);assert.equal(w.miners.snapshot(w.id).mining.plan.enabled,false);
});

test("a market outage holds both resource crews before custody or tax",async()=>{
  const w=await establish();items.grantItemToOwnerLocation(w.id,60000001,4,1230,100);
  const call=marketDaemonClient.call;marketDaemonClient.call=async()=>{throw Error("Isolated quote outage");};
  try{await startMiners(w);await mineStep(w);await refineStep(w,10);
    assert.equal(w.miners.snapshot(w.id).mining.status,"market_unavailable");assert.equal(w.refiners.snapshot(w.id).refining.status,"market_unavailable");
    assert.equal(wallet.getCharacterWallet(w.id).balance,100000);assert.equal(qty(w.id,1230),100);
  }finally{marketDaemonClient.call=call;}
});

test("production miners and supply forecasts respect a refinery kept on fixed ore",async()=>{
  const w=await establish();await command(w.refiners,w.id,"prioritize",{enabled:false});
  items.grantItemToOwnerLocation(w.id,60000001,4,1230,100);
  await startMiners(w);await mineStep(w);
  const state=w.miners.snapshot(w.id).mining;
  assert.equal(state.plan.typeID,1228);assert.ok(state.job);assert.equal(state.priority.deficits.find(m=>m.typeID===34).available,0);
  assert.deepEqual((await w.planner.forecast(w.id,60000003)).minerals,{});
});

test("couriers haul one native batch for the strongest recipe instead of a whole source stack",async()=>{
  const w=await establish({followCourier:true,targetT:335,targetP:105});
  items.grantItemToOwnerLocation(w.id,60000001,4,34,1000);items.grantItemToOwnerLocation(w.id,60000001,4,35,1000);
  await courierStep(w);const crew=w.courier.snapshot(w.id).crew;
  assert.equal(crew.job.cargo.typeID,34);assert.equal(crew.job.cargo.quantity,67);assert.equal(qty(w.id,34),933);
  assert.equal(crew.job.priority.productTypeID,21857);assert.equal(crew.job.priority.phase,"batch");
  evidence.push({case:"courier_module_batch",priority:crew.job.priority});
});

test("couriers switch to the ammo mineral shortage when profitable prices change",async()=>{
  const w=await establish({followCourier:true});items.grantItemToOwnerLocation(w.id,60000003,4,34,27);
  items.grantItemToOwnerLocation(w.id,60000001,4,34,1000);items.grantItemToOwnerLocation(w.id,60000001,4,35,1000);
  demand.setPrice(2,50);await courierStep(w);const job=w.courier.snapshot(w.id).crew.job;
  assert.equal(job.cargo.typeID,35);assert.equal(job.cargo.quantity,21);assert.equal(job.priority.productTypeID,215);
  evidence.push({case:"courier_ammo_after_price_change",priority:job.priority});
});

test("couriers fill another recipe's batch shortage before topping up a covered batch buffer",async()=>{
  const w=await establish({followCourier:true,targetT:335,targetP:105});items.grantItemToOwnerLocation(w.id,60000003,4,34,67);
  items.grantItemToOwnerLocation(w.id,60000001,4,34,1000);items.grantItemToOwnerLocation(w.id,60000001,4,35,1000);
  await courierStep(w);const job=w.courier.snapshot(w.id).crew.job;
  assert.equal(job.cargo.typeID,35);assert.equal(job.cargo.quantity,21);assert.equal(job.priority.phase,"batch");
});

test("couriers skip a stocked high-profit product and feed another profitable recipe",async()=>{
  const w=await establish({followCourier:true});items.grantItemToOwnerLocation(w.id,60000003,4,21857,2);items.grantItemToOwnerLocation(w.id,60000003,4,34,27);
  items.grantItemToOwnerLocation(w.id,60000001,4,34,1000);items.grantItemToOwnerLocation(w.id,60000001,4,35,1000);
  await courierStep(w);const job=w.courier.snapshot(w.id).crew.job;
  assert.equal(job.priority.productTypeID,215);assert.equal(job.cargo.typeID,35);assert.equal(job.cargo.quantity,21);
});

test("couriers stay at a stocked factory and resume only after minerals are consumed",async()=>{
  const w=await establish({followCourier:true});items.grantItemToOwnerLocation(w.id,60000001,4,34,1000);
  await courierStep(w);await courierStep(w,4);assert.equal(w.courier.snapshot(w.id).crew.stationID,60000003);
  items.grantItemToOwnerLocation(w.id,60000003,4,35,21);await courierStep(w,6);
  let state=w.courier.snapshot(w.id).crew;assert.equal(state.job,null);assert.equal(state.standingOrder.status,"stock_target_met");
  const item=items.listContainerItems(w.id,60000003,4).find(i=>i.typeID===34);items.consumeInventoryItemQuantity(item.itemID,10);
  await courierStep(w,6);assert.equal(w.courier.snapshot(w.id).crew.job.type,"travel");
  await courierStep(w,4);await courierStep(w);state=w.courier.snapshot(w.id).crew;
  assert.equal(state.job.cargo.quantity,10);assert.equal(state.job.cargo.typeID,34);
});

test("couriers preserve source reserves and cap a partial native load to useful supply",async()=>{
  const w=await establish({followCourier:true,sourceReserve:100});items.grantItemToOwnerLocation(w.id,60000001,4,34,120);
  await courierStep(w);const cargo=w.courier.snapshot(w.id).crew.job.cargo;
  assert.equal(cargo.quantity,20);assert.equal(qty(w.id,34),100);assert.ok(cargo.custodyItemID);
  assert.equal(w.courierInventory.selectSupply(w.id,60000001,34,0,0.05,100).quantity,5);
});

test("couriers retain accepted cargo and priority through price changes and reconstruction",async()=>{
  const w=await establish({followCourier:true});items.grantItemToOwnerLocation(w.id,60000001,4,34,1000);
  await courierStep(w);const before=w.courier.snapshot(w.id).crew.job;demand.setPrice(2,50);w.restore();await courierStep(w,4);
  const state=w.courier.snapshot(w.id);assert.equal(qty(w.id,34,60000003),67);
  assert.equal(state.history[0].jobID,before.jobID);assert.equal(state.history[0].priority.productTypeID,21857);
  assert.equal(state.crew.standingOrder.followProduction,true);
});

for(const phase of ["reserve","deliver"])test(`couriers recover a lost ${phase} reply without duplicating a limited load`,async()=>{
  const w=await establish({followCourier:true});items.grantItemToOwnerLocation(w.id,60000001,4,34,1000);
  const move=w.courierInventory.move;let fault=true;w.courierInventory.move=(...args)=>{const result=move(...args);if(fault&&args[2]===phase){fault=false;throw Error(`Lost ${phase} reply`);}return result;};
  await courierStep(w,1,phase==="reserve"?1:0);if(phase==="deliver")await courierStep(w,4,1);
  w.restore();await courierStep(w,4);await courierStep(w,4);
  assert.equal(qty(w.id,34,60000003),67);assert.equal(qty(w.id,34),933);
  assert.equal(w.courier.snapshot(w.id).crew.standingOrder.completedDeliveries,1);
});

test("courier follow commands remain strict, replayable and safe while paused or stopping",async()=>{
  const w=await establish({followCourier:true});items.grantItemToOwnerLocation(w.id,60000001,4,34,1000);await courierStep(w);
  const jobID=w.courier.snapshot(w.id).crew.job.jobID;
  assert.throws(()=>command(w.courier,w.id,"prioritize",{enabled:"true"}),{code:"CREW_COMMAND_INVALID"});
  assert.throws(()=>command(w.courier,w.id,"prioritize",{enabled:true,typeID:35}),{code:"CREW_COMMAND_INVALID"});
  const c={commandID:`courier-replay:${++serial}`,expectedRevision:w.courier.snapshot(w.id).revision,type:"prioritize",payload:{enabled:false}};
  w.courier.submit(w.id,c);assert.equal(w.courier.submit(w.id,c).replayed,true);assert.equal(w.courier.snapshot(w.id).crew.job.jobID,jobID);
  await command(w.courier,w.id,"prioritize",{enabled:true});await command(w.courier,w.id,"pause");await courierStep(w,10);
  assert.equal(w.courier.snapshot(w.id).crew.job.jobID,jobID);assert.equal(qty(w.id,34,60000003),0);
  await command(w.courier,w.id,"stop");await courierStep(w,4);
  assert.equal(qty(w.id,34,60000003),67);assert.equal(w.courier.snapshot(w.id).crew.job,null);
});

test("couriers discard an asynchronous decision after the standing order is stopped",async()=>{
  const w=await establish({followCourier:true});items.grantItemToOwnerLocation(w.id,60000001,4,34,1000);
  let release,entered;const enteredPromise=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const choose=w.courierPlanning.courier;w.courierPlanning.courier=async(...args)=>{const result=await choose(...args);entered();await gate;return result;};
  clock+=1000;const pending=w.courier.plan({budgetMs:1000});await enteredPromise;await command(w.courier,w.id,"stop");release();await pending;
  w.courier.tick({budgetMs:1000});assert.equal(w.courier.snapshot(w.id).crew.job,null);assert.equal(qty(w.id,34),1000);
});

test("couriers recheck destination arrivals before reserving a prepared load",async()=>{
  const w=await establish({followCourier:true});items.grantItemToOwnerLocation(w.id,60000001,4,34,1000);
  clock+=1000;await w.courier.plan({budgetMs:1000});items.grantItemToOwnerLocation(w.id,60000003,4,34,60);
  w.courier.tick({budgetMs:1000});assert.equal(w.courier.snapshot(w.id).crew.job.cargo.quantity,7);assert.equal(qty(w.id,34),993);
});

test("couriers count accepted purchases once and do not haul the same destination gap",async()=>{
  const w=await establish({followCourier:true});items.grantItemToOwnerLocation(w.id,60000001,4,34,1000);
  items.grantItemToOwnerLocation(w.id,60000003,4,35,21);
  const snapshot=w.buyers.snapshot;w.buyers={...w.buyers,snapshot(id){const s=snapshot(id);return{...s,buying:{...s.buying,job:{jobID:"pending-purchase",phase:"buying",summary:{typeID:34,quantity:67}}}};}};
  await courierStep(w);assert.equal(w.courier.snapshot(w.id).crew.job,null);assert.equal(qty(w.id,34),1000);
  assert.equal(w.courier.snapshot(w.id).crew.standingOrder.status,"stock_target_met");
});

test("couriers hold new cargo during a quote outage and recover when the market returns",async()=>{
  const w=await establish({followCourier:true});items.grantItemToOwnerLocation(w.id,60000001,4,34,1000);
  const call=marketDaemonClient.call;marketDaemonClient.call=async()=>{throw Error("Courier quote outage");};
  try{await courierStep(w);assert.equal(w.courier.snapshot(w.id).crew.standingOrder.status,"market_unavailable");assert.equal(qty(w.id,34),1000);}
  finally{marketDaemonClient.call=call;}
  await courierStep(w,6);assert.equal(w.courier.snapshot(w.id).crew.job.cargo.quantity,67);
});

test("couriers wait for an active destination factory without making empty return trips",async()=>{
  const w=await establish({followCourier:true});items.grantItemToOwnerLocation(w.id,60000001,4,34,1000);
  await command(w.factory,w.id,"pause");await courierStep(w);assert.equal(w.courier.snapshot(w.id).crew.job,null);
  assert.equal(w.courier.snapshot(w.id).crew.standingOrder.status,"waiting_for_factory");
  await command(w.factory,w.id,"resume");await courierStep(w,6);assert.equal(w.courier.snapshot(w.id).crew.job.cargo.typeID,34);
});

for(const reason of ["unprofitable","production_targets_covered"])test(`couriers wait without cargo when recipes are ${reason}`,async()=>{
  const w=await establish({followCourier:true});items.grantItemToOwnerLocation(w.id,60000001,4,34,1000);items.grantItemToOwnerLocation(w.id,60000001,4,35,1000);
  if(reason==="unprofitable"){demand.setPrice(1,0.1);demand.setPrice(2,50);}
  else{items.grantItemToOwnerLocation(w.id,60000003,4,215,200);items.grantItemToOwnerLocation(w.id,60000003,4,21857,2);}
  await courierStep(w);assert.equal(w.courier.snapshot(w.id).crew.job,null);assert.equal(w.courier.snapshot(w.id).crew.standingOrder.status,reason);
  assert.equal(qty(w.id,34),1000);assert.equal(qty(w.id,35),1000);assert.equal(wallet.getCharacterWallet(w.id).balance,100000);
});

test("couriers follow production through all six crews with conserved native cargo and ISK",async()=>{
  const w=await establish({followCourier:true,veld:300,scordite:300}),consumed=new Map();await startMiners(w);
  for(let step=0;step<160;step++){
    if(step===80)demand.setPrice(2,50);
    clock+=1000;await w.miners.plan({budgetMs:1000});assert.deepEqual(w.miners.tick({budgetMs:1000}).errors,[]);
    assert.deepEqual((await w.refiners.tick({budgetMs:1000})).errors,[]);await w.courier.plan({budgetMs:1000});assert.deepEqual(w.courier.tick({budgetMs:1000}).errors,[]);
    const prior=w.factory.snapshot(w.id).manufacturing.job;if(prior?.phase==="building")require("../src/services/industry/industryRuntimeState").markIndustryJobReady(prior.nativeJobID);
    assert.deepEqual((await w.factory.tick({budgetMs:1000})).errors,[]);assert.deepEqual((await w.sellers.tick({budgetMs:1000})).errors,[]);assert.deepEqual((await w.buyers.tick({budgetMs:1000})).errors,[]);
    const m=w.miners.snapshot(w.id).mining,r=w.refiners.snapshot(w.id).refining,f=w.factory.snapshot(w.id).manufacturing,s=w.sellers.snapshot(w.id).selling,b=w.buyers.snapshot(w.id).buying;
    if(f.job?.phase==="building"&&!consumed.has(f.job.jobID))consumed.set(f.job.jobID,f.job.summary.materials);
    const crewEscrow=database.read("crewRuntime",`/${w.id}`).data.escrowLocationID,locations=[[60000001,4],[60000003,4],[m.escrowLocationID,5],[r.escrowLocationID,5],[crewEscrow,5]];
    for(const type of [34,35]){const stock=locations.reduce((n,[location,flag])=>n+qty(w.id,type,location,flag),0),used=[...consumed.values()].flat().filter(x=>x.typeID===type).reduce((n,x)=>n+x.quantity,0);
      assert.equal(stock+used,(r.mineralsProduced[type]||0)+(b.purchased[type]||0),`Courier mineral ${type} at ${step}`);}
    const ore=locations.reduce((n,[location,flag])=>n+qty(w.id,1230,location,flag)+qty(w.id,1228,location,flag),0);assert.equal(ore+r.totalOreProcessed,m.totalMined);
    assert.equal(wallet.getCharacterWallet(w.id).balance,Math.round((100000+s.netRevenue-r.totalTaxPaid-f.totalFeesPaid-b.totalSpent)*100)/100);
  }
  const factory=w.factory.snapshot(w.id).manufacturing,sales=w.sellers.snapshot(w.id).selling,courier=w.courier.snapshot(w.id).crew;
  assert.ok(factory.produced[21857]>0);assert.ok(factory.produced[215]>=100);assert.ok(sales.netRevenue>0);assert.ok(wallet.getCharacterWallet(w.id).balance>100000);
  assert.ok(courier.standingOrder.completedDeliveries>0);assert.ok(courier.history.some(h=>h.priority));
  evidence.push({case:"courier_all_six_crews",produced:factory.produced,sold:sales.sold,netSales:sales.netRevenue,wallet:wallet.getCharacterWallet(w.id).balance,
    deliveries:courier.standingOrder.completedDeliveries,conservationTicks:160});
});

test("production stress: buying falls back when the strongest recipe's mineral exceeds its price ceiling",async()=>{
  const w=await establish({followCourier:true,veld:0,scordite:0});items.grantItemToOwnerLocation(w.id,60000003,4,34,27);
  items.grantItemToOwnerLocation(w.id,60000003,4,21857,1);clock+=10000;await w.sellers.tick({budgetMs:1000});demand.setPrice(3,1.1);
  await w.buyers.tick({budgetMs:1000});const buyer=w.buyers.snapshot(w.id).buying;
  assert.equal(buyer.totalSpent,42);assert.equal(buyer.purchased[35],21);assert.equal(buyer.priority.productTypeID,215);
  await w.factory.tick({budgetMs:1000});assert.equal(w.factory.snapshot(w.id).manufacturing.job.summary.productTypeID,215);
});

test("production stress: a policy too small for any complete batch keeps its ISK",async()=>{
  const w=await establish({followCourier:true,veld:0,scordite:0,budgetISK:50});
  items.grantItemToOwnerLocation(w.id,60000003,4,21857,1);clock+=10000;await w.sellers.tick({budgetMs:1000});await w.buyers.tick({budgetMs:1000});
  const buyer=w.buyers.snapshot(w.id).buying;assert.equal(buyer.totalSpent,0);assert.equal(buyer.status,"budget_too_small");
  assert.equal(wallet.getCharacterWallet(w.id).balance,100184);
});

test("production stress: a smaller budget funds an affordable recipe instead of stranding partial inputs",async()=>{
  const w=await establish({followCourier:true,veld:0,scordite:0,budgetISK:50});items.grantItemToOwnerLocation(w.id,60000003,4,35,21);
  items.grantItemToOwnerLocation(w.id,60000003,4,21857,1);clock+=10000;await w.sellers.tick({budgetMs:1000});await w.buyers.tick({budgetMs:1000});
  const buyer=w.buyers.snapshot(w.id).buying;assert.equal(buyer.totalSpent,27);assert.equal(buyer.priority.productTypeID,215);
  await w.factory.tick({budgetMs:1000});assert.equal(w.factory.snapshot(w.id).manufacturing.job.summary.productTypeID,215);
});

function stressLedger(w){
  const stock=type=>items.listOwnedItems(w.id,{typeID:type}).reduce((n,i)=>n+i.quantity,0);
  return{stock,initial:new Map([34,35,1230,1228,215,21857].map(type=>[type,stock(type)])),wallet:wallet.getCharacterWallet(w.id).balance,used:new Map(),ticks:0,purchases:0};
}
function equipmentPayments(id){
  const receipts=database.read("characters",`/${id}`).data.crewEquipmentWalletReceipts||{},payments=new Map();
  for(const[key,receipt]of Object.entries(receipts)){
    const match=/^crew-equipment:(mining|hauling|manufacturing):([1-3])$/.exec(key);assert.ok(match);
    const cost=require("../src/services/crew/crewEquipmentState").CATALOG[match[1]].costs[Number(match[2])-1];
    assert.equal(JSON.parse(receipt.fingerprint).amount,-cost);payments.set(key,cost);
  }
  return payments;
}
async function stressTick(w,ledger,offset,outage=false,onAcknowledgementRetry){
  clock+=1000;const prior=w.factory.snapshot(w.id).manufacturing.job;
  if(prior?.phase==="building"){
    ledger.buildingSince||=new Map();if(!ledger.buildingSince.has(prior.jobID))ledger.buildingSince.set(prior.jobID,ledger.ticks);
    if(ledger.ticks-ledger.buildingSince.get(prior.jobID)>=(ledger.factoryReadyDelayTicks||0))require("../src/services/industry/industryRuntimeState").markIndustryJobReady(prior.nativeJobID);
  }
  const stages=[w.miners,w.refiners,w.courier,w.factory,w.sellers,w.buyers,...(w.equipment?[w.equipment]:[])],rotated=stages.slice(offset%stages.length).concat(stages.slice(0,offset%stages.length));
  for(const stage of rotated){
    if(stage.plan)assert.deepEqual((await stage.plan({budgetMs:1000})).errors,[]);
    const before=stage===w.buyers?{spent:w.buyers.snapshot(w.id).buying.totalSpent,wallet:wallet.getCharacterWallet(w.id).balance}:null;
    const equipmentBefore=stage===w.equipment?{state:w.equipment.snapshot(w.id).equipment,paid:equipmentPayments(w.id),wallet:wallet.getCharacterWallet(w.id).balance}:null;
    const result=await stage.tick({budgetMs:1000});
    if(onAcknowledgementRetry&&result.errors.length&&result.errors.every(e=>["XP_COHORT_ACK_REPLY_LOST","EQUIPMENT_STRESS_DEBIT_REPLY_LOST"].includes(e.code))){
      onAcknowledgementRetry(stage,result.errors);
    }else if(outage&&stage===w.sellers&&result.errors.length){
      assert.ok(result.errors.every(e=>e.code==="CREW_MARKET_PENDING"));
      const seller=w.sellers.snapshot(w.id).selling;assert.equal(seller.job,null);assert.equal(seller.status,"market_unavailable");ledger.quoteHolds=(ledger.quoteHolds||0)+1;
    }else assert.deepEqual(result.errors,[],`Unexpected crew error at stress tick ${ledger.ticks}`);
    if(before){const buyer=w.buyers.snapshot(w.id).buying,spent=buyer.totalSpent-before.spent;
      if(spent>0){ledger.purchases++;assert.equal(wallet.getCharacterWallet(w.id).balance,Math.round((before.wallet-spent)*100)/100);
        assert.ok(wallet.getCharacterWallet(w.id).balance>=buyer.plan.walletReserve);assert.ok(buyer.history[0].unitPrice<=buyer.plan.orders.find(o=>o.typeID===buyer.history[0].typeID).maximumPrice);}}
    if(equipmentBefore){
      const current=w.equipment.snapshot(w.id).equipment,paid=equipmentPayments(w.id),fresh=[...paid].filter(([key])=>!equipmentBefore.paid.has(key));
      assert.ok(fresh.length<=1);const cost=fresh.reduce((sum,[,amount])=>sum+amount,0);
      assert.equal(wallet.getCharacterWallet(w.id).balance,Math.round((equipmentBefore.wallet-cost)*100)/100,"Equipment replay changed the wallet twice");
      if(cost){
        assert.ok(cost<=equipmentBefore.state.funding.profitAllowance&&cost<=equipmentBefore.state.funding.budgetRemaining);
        const intent=current.job||current.history[0];assert.equal(intent.cost,cost);assert.ok(intent.paybackHours<=current.plan.maxPaybackHours);
        assert.ok(wallet.getCharacterWallet(w.id).balance>=intent.minimumBalance);ledger.equipmentPurchases=(ledger.equipmentPurchases||0)+1;
      }
    }
  }
  const m=w.miners.snapshot(w.id).mining,r=w.refiners.snapshot(w.id).refining,c=w.courier.snapshot(w.id).crew,f=w.factory.snapshot(w.id).manufacturing,s=w.sellers.snapshot(w.id).selling,b=w.buyers.snapshot(w.id).buying;
  const completions=[["mining",m,m.completedDeliveries,h=>Boolean(h.cargo)],["refining",r,r.completedBatches,h=>!h.rejected],
    ["hauling",c,c.standingOrder.completedDeliveries,h=>Boolean(h.cargo)],["manufacturing",f,f.completedBatches,h=>h.outcome==="delivered"],
    ["selling",s,s.completedSales,h=>!h.rejected],["buying",b,b.completedPurchases,h=>!h.rejected]];
  ledger.completions||=new Map();
  for(const[role,team,completed,success]of completions){
    if(!ledger.completions.has(role))ledger.completions.set(role,new Set());
    const jobs=ledger.completions.get(role);for(const entry of team.history.filter(success))jobs.add(entry.jobID);
    assert.equal(completed,jobs.size,`${role} completion counters diverged from distinct successful jobs`);
    assert.equal(team.skill.xp,Math.min(1500,completed*10),"Stress replay or empty travel changed earned crew XP");
  }
  if(f.job?.phase==="building"&&!ledger.used.has(f.job.jobID)){assert.ok(f.job.summary.profit.allowed&&f.job.summary.profit.expectedProfit>0);ledger.used.set(f.job.jobID,f.job.summary.materials);}
  for(const type of [34,35]){const consumed=[...ledger.used.values()].flat().filter(x=>x.typeID===type).reduce((n,x)=>n+x.quantity,0);
    assert.equal(ledger.stock(type)+consumed,ledger.initial.get(type)+(r.mineralsProduced[type]||0)+(b.purchased[type]||0),`Stress mineral ${type} at ${ledger.ticks}`);}
  for(const type of [215,21857])assert.equal(ledger.stock(type)+(s.sold[type]||0),ledger.initial.get(type)+(f.produced[type]||0),`Stress product ${type} at ${ledger.ticks}`);
  assert.equal(ledger.stock(1230)+ledger.stock(1228)+r.totalOreProcessed,ledger.initial.get(1230)+ledger.initial.get(1228)+m.totalMined);
  const g=w.equipment?.snapshot(w.id).equipment;
  const payments=g?equipmentPayments(w.id):new Map(),equipmentPaid=[...payments.values()].reduce((sum,cost)=>sum+cost,0);
  assert.equal(wallet.getCharacterWallet(w.id).balance,Math.round((ledger.wallet+s.netRevenue-r.totalTaxPaid-f.totalFeesPaid-b.totalSpent-equipmentPaid)*100)/100);
  assert.ok(b.totalSpent+equipmentPaid<=s.netRevenue&&b.plan.spent<=b.plan.budgetISK);
  if(g){
    assert.equal(g.history.reduce((sum,entry)=>sum+entry.cost,0),g.totalSpent);assert.equal(new Set(g.history.map(entry=>`${entry.role}:${entry.tier}`)).size,g.history.length);assert.ok(g.totalSpent<=g.plan.budgetISK);
    for(const purchase of g.history)assert.equal(payments.get(`crew-equipment:${purchase.role}:${purchase.tier}`),purchase.cost);
    assert.equal(equipmentPaid-g.totalSpent,g.job&&payments.has(`crew-equipment:${g.job.role}:${g.job.tier}`)?g.job.cost:0);
    assert.equal(payments.size,ledger.equipmentPurchases||0);
  }
  ledger.ticks++;
  return{m,r,c,f,s,b,g};
}
const stressSpending=state=>({tax:state.r.totalTaxPaid,fees:state.f.totalFeesPaid,purchases:state.b.totalSpent,mined:state.m.totalMined,deliveries:state.c.standingOrder.completedDeliveries,equipment:state.g?.totalSpent||0});
const stressEvidence=(state,ledger)=>({ticks:ledger.ticks,oreMined:state.m.totalMined,oreRefined:state.r.totalOreProcessed,produced:state.f.produced,sold:state.s.sold,
  netSales:state.s.netRevenue,purchases:state.b.totalSpent,refiningTax:state.r.totalTaxPaid,factoryFees:state.f.totalFeesPaid,wallet:wallet.getCharacterWallet(state.m.ownerID).balance,
  deliveries:state.c.standingOrder.completedDeliveries,checkedPurchases:ledger.purchases,quoteHolds:ledger.quoteHolds||0,...(state.g?{equipmentSpent:state.g.totalSpent,equipmentTiers:state.g.tiers}: {})});

test("production stress: changing demand, shortages, price crashes and recovery conserve the full aware economy",async()=>{
  const w=await establish({followCourier:true,veld:200,scordite:200,budgetISK:10000});await startMiners(w);const ledger=stressLedger(w),events=[];
  let state,quiet,producedBeforeRecovery;const call=marketDaemonClient.call;let outage=false;
  marketDaemonClient.call=function(method,...args){return outage&&method==="GetOrders"?Promise.reject(Error("Stress quote outage")):call.call(this,method,...args);};
  try{for(let step=0;step<480;step++){
    if(step===60){demand.setPrice(2,50);demand.setPrice(1,3);events.push({step,event:"ammo_becomes_best"});}
    if(step===100||step===280){demand.setRemaining(1,0);demand.setRemaining(2,0);events.push({step,event:"all_demand_exhausted"});}
    if(step===145||step===325){demand.setRemaining(1,1000000);demand.setRemaining(2,1000000);demand.setPrice(1,2);demand.setPrice(2,200);events.push({step,event:"demand_restored"});}
    if(step===180){await command(w.courier,w.id,"pause");events.push({step,event:"source_route_paused"});}
    if(step===190){await command(w.courier,w.id,"resume");events.push({step,event:"source_route_resumed"});}
    if(step===210){demand.setPrice(3,1.1);events.push({step,event:"tritanium_above_ceiling"});}
    if(step===245){demand.setPrice(3,1);demand.setRemaining(4,0);events.push({step,event:"pyerite_supply_exhausted"});}
    if(step===280)demand.setRemaining(4,1000000);
    if(step===360){demand.setPrice(3,1000);demand.setPrice(4,1000);events.push({step,event:"unprofitable_mineral_spike"});}
    if(step===405){demand.setPrice(3,1);demand.setPrice(4,2);events.push({step,event:"mineral_prices_restored"});producedBeforeRecovery=state.f.completedBatches;}
    if(step===430){outage=true;events.push({step,event:"quote_outage"});}if(step===450){outage=false;events.push({step,event:"quotes_restored"});}
    state=await stressTick(w,ledger,step,outage);
    if([112,292,372,435].includes(step))quiet=stressSpending(state);
    if([140,320,400,445].includes(step))assert.deepEqual(stressSpending(state),quiet,"Settled blocked markets must not spend or dispatch more work");
    if([70,170,300,420].includes(step)){await Promise.all([w.courier.drain(),w.miners.drain(),w.refiners.drain(),w.factory.drain(),w.sellers.drain(),w.buyers.drain()]);w.restore();events.push({step,event:"services_reconstructed"});}
  }}finally{marketDaemonClient.call=call;}
  assert.ok(state.f.produced[215]>=100&&state.f.produced[21857]>0);assert.ok(state.b.totalSpent>0);assert.ok(state.m.totalMined<=400&&state.m.totalMined>0);
  assert.ok(state.f.completedBatches>producedBeforeRecovery);assert.ok(wallet.getCharacterWallet(w.id).balance>ledger.wallet);
  evidence.push({case:"production_stress_scripted",events,...stressEvidence(state,ledger),blockedWindowsChecked:4,servicesRestored:4});
});

for(const seed of [73,991])test(`production stress: seeded market sequence ${seed} recovers without duplication or overspending`,async()=>{
  const w=await establish({followCourier:true,veld:200,scordite:200,budgetISK:10000});await startMiners(w);const ledger=stressLedger(w);let state,random=seed,recovery;
  const choose=values=>{random=(Math.imul(random,1664525)+1013904223)>>>0;return values[random%values.length];};
  for(let step=0;step<360;step++){
    if(step>=40&&step<240&&step%20===0){demand.setPrice(1,choose([0.1,2,3]));demand.setPrice(2,choose([50,200,400]));
      demand.setPrice(3,choose([1,1.1,1000]));demand.setPrice(4,choose([2,2.1,1000]));demand.setRemaining(1,choose([0,99,100000]));demand.setRemaining(2,choose([0,1,100000]));}
    if(step===240){for(const[id,price]of [[1,2],[2,200],[3,1],[4,2]]){demand.setPrice(id,price);demand.setRemaining(id,1000000);}recovery=state.f.completedBatches;}
    state=await stressTick(w,ledger,step+seed);
    if(step===180){await Promise.all([w.courier.drain(),w.miners.drain(),w.refiners.drain(),w.factory.drain(),w.sellers.drain(),w.buyers.drain()]);w.restore();}
  }
  assert.ok(state.f.completedBatches>recovery);assert.ok(state.b.totalSpent<=state.s.netRevenue);evidence.push({case:"production_stress_seeded",seed,...stressEvidence(state,ledger),servicesRestored:1});
});

function seedCrewXP(w,role,table,xp){
  const repo=createTableRepository(role),state=repo.read(table,`/${w.id}`).data;state.progression={version:1,xp};
  assert.equal(repo.write(table,`/${w.id}`,state).success,true);assert.equal(repo.flushTableSync(table).success,true);
}

test("progression: a recovered mining delivery levels up once and shortens only the next extraction",async()=>{
  const w=await establish();await startMiners(w);seedCrewXP(w,"service:crew-mining","miningCrewRuntime",90);await mineStep(w);
  const accepted=w.miners.snapshot(w.id).mining.job;assert.equal(accepted.cycleMs,1000);assert.equal(accepted.skillAtStart.level,0);
  const unload=w.resources.unload;let fault=true;w.resources.unload=(...args)=>{const result=unload(...args);if(fault){fault=false;throw Error("XP unload reply lost");}return result;};
  await mineStep(w);await mineStep(w);clock+=1000;assert.equal(w.miners.tick({budgetMs:1000}).errors.length,1);
  assert.equal(w.miners.snapshot(w.id).mining.skill.xp,90);w.restore();await mineStep(w);
  let state=w.miners.snapshot(w.id).mining;assert.equal(state.skill.xp,100);assert.equal(state.history[0].experienceGained,10);
  await mineStep(w);state=w.miners.snapshot(w.id).mining;assert.equal(state.job.cycleMs,970);assert.equal(state.job.skillAtStart.level,1);
  evidence.push({case:"progression_mining",skill:state.skill,oldCycleMs:accepted.cycleMs,newCycleMs:state.job.cycleMs});
});

test("progression: an empty stopped mining trip earns no experience",async()=>{
  const w=await establish();await startMiners(w);await mineStep(w);await command(w.miners,w.id,"stop");await mineStep(w,4);
  assert.equal(w.miners.snapshot(w.id).mining.skill.xp,0);assert.equal(w.miners.snapshot(w.id).mining.completedDeliveries,0);
});

test("progression: refining completion reply loss earns XP once without repeating tax or output",async()=>{
  const w=await establish();seedCrewXP(w,"service:crew-refining","refiningCrewRuntime",90);items.grantItemToOwnerLocation(w.id,60000001,4,1230,100);
  const settle=w.inventory.settle;let fault=true;w.inventory.settle=async(...args)=>{const result=await settle(...args);if(fault){fault=false;throw Error("XP refining reply lost");}return result;};
  await refineStep(w,10);assert.equal(w.refiners.snapshot(w.id).refining.job.cycleMs,1000);await refineStep(w,1,1);
  assert.equal(w.refiners.snapshot(w.id).refining.skill.xp,90);w.restore();await refineStep(w);
  const state=w.refiners.snapshot(w.id).refining;assert.equal(state.skill.xp,100);assert.equal(state.totalTaxPaid,20);assert.equal(state.mineralsProduced[34],200);
  assert.equal(state.history[0].experienceGained,10);assert.equal(w.refiners.universeFacts({ownerID:w.id}).actors[0].skill.level,1);
  items.grantItemToOwnerLocation(w.id,60000001,4,1228,100);await refineStep(w);assert.equal(w.refiners.snapshot(w.id).refining.job.cycleMs,970);
});

test("progression: a rejected refining payment returns ore without experience",async()=>{
  const w=await establish();seedCrewXP(w,"service:crew-refining","refiningCrewRuntime",90);items.grantItemToOwnerLocation(w.id,60000001,4,1230,100);
  w.inventory.balance=()=>100000;await wallet.adjustCharacterBalanceAsync(w.id,-100000,{description:"Progression native tax rejection"});database.flushTableSync("characters");
  await refineStep(w,10);await refineStep(w);const state=w.refiners.snapshot(w.id).refining;
  assert.equal(state.skill.xp,90);assert.equal(state.completedBatches,0);assert.equal(state.totalTaxPaid,0);assert.equal(qty(w.id,1230),100);
  assert.equal(state.history[0].rejected,true);assert.equal(state.history[0].experienceGained,0);
});

test("progression: courier XP survives replay and route changes while empty returns earn nothing",async()=>{
  const w=await establish({followCourier:true});seedCrewXP(w,"service:crew","crewRuntime",90);items.grantItemToOwnerLocation(w.id,60000001,4,34,1000);
  await courierStep(w);const accepted=w.courier.snapshot(w.id).crew.job;assert.equal(accepted.legMs,1000);
  const move=w.courierInventory.move;let fault=true;w.courierInventory.move=(...args)=>{const result=move(...args);if(fault&&args[2]==="deliver"){fault=false;throw Error("XP courier reply lost");}return result;};
  await courierStep(w,4,1);assert.equal(w.courier.snapshot(w.id).crew.skill.xp,90);w.restore();await courierStep(w);
  assert.equal(w.courier.snapshot(w.id).crew.skill.xp,100);assert.equal(qty(w.id,34,60000003),67);
  items.grantItemToOwnerLocation(w.id,60000001,4,35,21);await courierStep(w,6);
  assert.equal(w.courier.snapshot(w.id).crew.job.type,"travel");assert.equal(w.courier.snapshot(w.id).crew.job.legMs,970);
  await courierStep(w,4);assert.equal(w.courier.snapshot(w.id).crew.skill.xp,100);
  await command(w.courier,w.id,"stop");assert.equal(w.courier.snapshot(w.id).crew.skill.xp,100);
  await command(w.courier,w.id,"automate",{sourceStationID:60000001,destinationStationID:60000003,typeID:35,sourceReserve:0});
  assert.equal(w.courier.snapshot(w.id).crew.skill.xp,100);assert.equal(w.courier.snapshot(w.id).crew.job.legMs,970);
});

test("progression: native factory completion levels up once and persists shorter subsequent jobs",async()=>{
  const w=await establish();await command(w.factory,w.id,"stop");seedCrewXP(w,"service:crew-manufacturing","manufacturingCrewRuntime",90);
  items.grantItemToOwnerLocation(w.id,60000003,4,34,20000);const blueprint=w.factory.catalog(w.id,60000003).find(b=>b.productTypeID===21857);
  await command(w.factory,w.id,"start",{stationID:60000003,orders:[{blueprintID:blueprint.blueprintID,runs:100,targetStock:200}]});
  const first=w.factory.snapshot(w.id).manufacturing.job;assert.equal(first.summary.timeSeconds,first.summary.baseTimeSeconds);
  const native=require("../src/services/industry/industryRuntimeState"),deliver=w.industry.deliver;let fault=true;
  w.industry.deliver=(...args)=>{const result=deliver(...args);if(fault){fault=false;throw Error("XP native industry reply lost");}return result;};
  native.markIndustryJobReady(first.nativeJobID);clock+=1000;assert.equal((await w.factory.tick({budgetMs:1000})).errors.length,1);
  assert.equal(w.factory.snapshot(w.id).manufacturing.skill.xp,90);w.restore();await w.factory.tick({budgetMs:1000});
  assert.equal(w.factory.snapshot(w.id).manufacturing.skill.xp,100);await w.factory.tick({budgetMs:1000});
  const second=w.factory.snapshot(w.id).manufacturing.job,record=native.getJobByID(second.nativeJobID);
  assert.equal(second.summary.crewSkill.level,1);assert.equal(second.summary.timeSeconds,Math.ceil(first.summary.baseTimeSeconds*0.97));
  assert.ok(second.summary.timeSeconds<first.summary.timeSeconds);assert.equal(record.timeInSeconds,second.summary.timeSeconds);
  assert.equal(Number((BigInt(record.endDate)-BigInt(record.startDate))/10000000n),second.summary.timeSeconds);
  assert.equal(second.summary.cost,first.summary.cost);assert.deepEqual(second.summary.materials,first.summary.materials);
  w.restore();assert.equal(w.factory.snapshot(w.id).manufacturing.job.endDate,second.endDate);
  evidence.push({case:"progression_manufacturing",skill:w.factory.snapshot(w.id).manufacturing.skill,oldSeconds:first.summary.timeSeconds,newSeconds:second.summary.timeSeconds});
});

test("progression: cancelled native production earns no experience",async()=>{
  const w=await establish();seedCrewXP(w,"service:crew-manufacturing","manufacturingCrewRuntime",90);items.grantItemToOwnerLocation(w.id,60000003,4,34,1000);
  clock+=10000;await w.factory.tick({budgetMs:1000});const job=w.factory.snapshot(w.id).manufacturing.job,native=require("../src/services/industry/industryRuntimeState");
  assert.equal(native.cancelIndustryJob(native.createCrewIndustryActor(w.id,60000003),job.nativeJobID).success,true);
  await w.factory.tick({budgetMs:1000});const state=w.factory.snapshot(w.id).manufacturing;
  assert.equal(state.skill.xp,90);assert.equal(state.completedBatches,0);assert.equal(state.history[0].experienceGained,0);
});

test("progression: XP and production multipliers cannot be supplied by public commands or retail actors",async()=>{
  const w=await establish();seedCrewXP(w,"service:crew-manufacturing","manufacturingCrewRuntime",1500);const native=require("../src/services/industry/industryRuntimeState");
  const blueprint=w.factory.catalog(w.id,60000003).find(b=>b.productTypeID===21857),location={itemID:60000003,ownerID:w.id,flagID:4};
  const request={blueprintID:blueprint.blueprintID,activityID:1,facilityID:60000003,runs:100,inputLocation:location,outputLocation:location};
  const actor=native.createCrewIndustryActor(w.id,60000003);actor.crewSkill={level:5,durationBasisPoints:1};
  const real=native.quoteManufacturingJob(actor,request).quote;
  const retail=native.quoteManufacturingJob({...actor,stationid:60000003,stationID:60000003},{...request,crewSkill:{level:5},durationBasisPoints:1}).quote;
  assert.ok(real&&retail);assert.equal(real.timeInSeconds,Math.ceil(real.baseTimeInSeconds*0.85));assert.equal(retail.timeInSeconds,real.baseTimeInSeconds);assert.equal(retail.crewSkill,undefined);
  assert.ok(Object.isFrozen(real.crewSkill));assert.throws(()=>{real.crewSkill.durationBasisPoints=1;},TypeError);
  assert.throws(()=>command(w.courier,w.id,"prioritize",{enabled:true,xp:1500}),{code:"CREW_COMMAND_INVALID"});
  await assert.rejects(command(w.refiners,w.id,"prioritize",{enabled:true,xp:1500}),{code:"CREW_COMMAND_INVALID"});
  await assert.rejects(command(w.factory,w.id,"start",{stationID:60000003,orders:[],xp:1500}),{code:"CREW_COMMAND_INVALID"});
  await assert.rejects(command(w.buyers,w.id,"pause",{xp:1500}),{code:"CREW_COMMAND_INVALID"});
  await assert.rejects(command(w.sellers,w.id,"pause",{xp:1500}),{code:"CREW_COMMAND_INVALID"});
});

test("trade progression: a recovered sale levels up once and freezes its accepted cooldown",async()=>{
  const w=await establish({veld:0,scordite:0});seedCrewXP(w,"service:crew-selling","sellingCrewRuntime",90);
  items.grantItemToOwnerLocation(w.id,60000003,4,21857,3);demand.dropNextFill();clock+=10000;
  assert.equal((await w.sellers.tick({budgetMs:1000})).errors.length,1);let seller=w.sellers.snapshot(w.id).selling;
  assert.equal(seller.skill.xp,90);assert.equal(seller.job.cooldownMs,5000);const jobID=seller.job.jobID;w.restore();clock+=1000;
  assert.deepEqual((await w.sellers.tick({budgetMs:1000})).errors,[]);seller=w.sellers.snapshot(w.id).selling;
  assert.equal(seller.skill.xp,100);assert.equal(seller.history[0].jobID,jobID);assert.equal(seller.history[0].experienceGained,10);
  assert.equal(seller.netRevenue,184);assert.equal(seller.taxPaid,16);assert.equal(seller.nextCheckAtMs-clock,5000);
  assert.equal(seller.timing.checkMs,9000);clock+=4999;await w.sellers.tick({budgetMs:1000});assert.equal(w.sellers.snapshot(w.id).selling.completedSales,1);
  clock++;await w.sellers.tick({budgetMs:1000});seller=w.sellers.snapshot(w.id).selling;
  assert.equal(seller.completedSales,2);assert.equal(seller.skill.xp,110);assert.equal(seller.nextCheckAtMs-clock,4500);
  evidence.push({case:"trade_progression_selling",skill:seller.skill,oldCooldownMs:5000,newCooldownMs:4500,taxPerSale:16});
});

test("trade progression: a recovered purchase levels up once and improves subsequent turnaround",async()=>{
  const w=await establish({veld:0,scordite:0});seedCrewXP(w,"service:crew-buying","buyingCrewRuntime",90);
  items.grantItemToOwnerLocation(w.id,60000003,4,21857,1);clock+=10000;await w.sellers.tick({budgetMs:1000});demand.dropNextFill();
  assert.equal((await w.buyers.tick({budgetMs:1000})).errors.length,1);let buyer=w.buyers.snapshot(w.id).buying;
  assert.equal(buyer.skill.xp,90);assert.equal(buyer.job.cooldownMs,5000);w.restore();clock+=1000;await w.buyers.tick({budgetMs:1000});
  buyer=w.buyers.snapshot(w.id).buying;assert.equal(buyer.skill.xp,100);assert.equal(buyer.totalSpent,67);assert.equal(buyer.history[0].experienceGained,10);
  assert.equal(qty(w.id,34,60000003),67);assert.equal(buyer.nextCheckAtMs-clock,5000);assert.equal(buyer.timing.checkMs,9000);
  clock+=4999;await w.buyers.tick({budgetMs:1000});assert.equal(w.buyers.snapshot(w.id).buying.completedPurchases,1);
  clock++;await w.buyers.tick({budgetMs:1000});buyer=w.buyers.snapshot(w.id).buying;
  assert.equal(buyer.completedPurchases,2);assert.equal(buyer.skill.xp,110);assert.equal(buyer.totalSpent,109);assert.equal(buyer.nextCheckAtMs-clock,4500);
  assert.equal(wallet.getCharacterWallet(w.id).balance,100075);evidence.push({case:"trade_progression_buying",skill:buyer.skill,purchaseCost:buyer.totalSpent});
});

for(const role of ["selling","buying"])test(`trade progression: rejected ${role} settlement returns assets without XP`,async()=>{
  const w=await establish({veld:0,scordite:0}),service=role==="selling"?w.sellers:w.buyers,table=role==="selling"?"sellingCrewRuntime":"buyingCrewRuntime";
  seedCrewXP(w,`service:crew-${role}`,table,90);items.grantItemToOwnerLocation(w.id,60000003,4,21857,1);clock+=10000;
  if(role==="buying")await w.sellers.tick({budgetMs:1000});demand.rejectNextFill(role==="selling"?2:3);
  assert.deepEqual((await service.tick({budgetMs:1000})).errors,[]);const state=service.snapshot(w.id)[role];
  assert.equal(state.skill.xp,90);assert.equal(state.history[0].rejected,true);assert.equal(state.history[0].experienceGained,0);
  assert.equal(role==="selling"?state.completedSales:state.completedPurchases,0);
  assert.equal(wallet.getCharacterWallet(w.id).balance,role==="selling"?100000:100184);
  assert.equal(qty(w.id,role==="selling"?21857:34,60000003),role==="selling"?1:0);
});

test("trade progression: idle checks become faster without earning XP or exceeding policies",async()=>{
  const w=await establish({veld:0,scordite:0});seedCrewXP(w,"service:crew-selling","sellingCrewRuntime",300);seedCrewXP(w,"service:crew-buying","buyingCrewRuntime",300);
  clock+=10000;await w.sellers.tick({budgetMs:1000});await w.buyers.tick({budgetMs:1000});
  for(const[service,key]of [[w.sellers,"selling"],[w.buyers,"buying"]]){const state=service.snapshot(w.id)[key];assert.equal(state.nextCheckAtMs-clock,8000);assert.equal(state.skill.xp,300);assert.equal(state.timing.cooldownMs,4000);}
  const revisions=[w.sellers.snapshot(w.id).revision,w.buyers.snapshot(w.id).revision];clock+=7999;
  await w.sellers.tick({budgetMs:1000});await w.buyers.tick({budgetMs:1000});assert.deepEqual([w.sellers.snapshot(w.id).revision,w.buyers.snapshot(w.id).revision],revisions);
  clock++;await w.sellers.tick({budgetMs:1000});await w.buyers.tick({budgetMs:1000});
  assert.equal(w.sellers.snapshot(w.id).selling.skill.xp,300);assert.equal(w.buyers.snapshot(w.id).buying.skill.xp,300);assert.equal(wallet.getCharacterWallet(w.id).balance,100000);
});

test("trade progression: policy restarts preserve experience and damaged XP holds both traders",async()=>{
  const w=await establish({veld:0,scordite:0});
  for(const[service,key,table]of [[w.sellers,"selling","sellingCrewRuntime"],[w.buyers,"buying","buyingCrewRuntime"]]){
    seedCrewXP(w,`service:crew-${key}`,table,300);const before=service.snapshot(w.id)[key];
    await command(service,w.id,"pause");await command(service,w.id,"resume");await command(service,w.id,"stop");
    const payload=key==="selling"?{stationID:before.stationID,orders:before.plan.orders}:{stationID:before.stationID,orders:before.plan.orders,budgetISK:before.plan.budgetISK,walletReserve:before.plan.walletReserve};
    await command(service,w.id,"start",payload);assert.equal(service.snapshot(w.id)[key].skill.xp,300);
    seedCrewXP(w,`service:crew-${key}`,table,1501);try{assert.throws(()=>service.snapshot(w.id),{code:"CREW_STATE_INVALID"});}finally{seedCrewXP(w,`service:crew-${key}`,table,300);}
  }
});

for(const role of ["selling","buying"])test(`trade progression: ${role} acknowledgement replay and legacy jobs preserve one reward`,async()=>{
  const w=await establish({veld:0,scordite:0}),escrow=require("../src/services/market/marketEscrowState"),method=role==="selling"?"acknowledgeCrewSale":"acknowledgeCrewPurchase";
  const table=role==="selling"?"sellingCrewRuntime":"buyingCrewRuntime";seedCrewXP(w,`service:crew-${role}`,table,90);
  items.grantItemToOwnerLocation(w.id,60000003,4,21857,1);clock+=10000;if(role==="buying")await w.sellers.tick({budgetMs:1000});
  const ack=escrow[method];let fail=true;escrow[method]=(...args)=>{const result=ack(...args);if(fail){fail=false;throw Error("Trade XP acknowledgement reply lost");}return result;};
  const service=role==="selling"?w.sellers:w.buyers;
  try{assert.equal((await service.tick({budgetMs:1000})).errors.length,1);}finally{escrow[method]=ack;}
  assert.equal(service.snapshot(w.id)[role].skill.xp,100);const repo=createTableRepository(`service:crew-${role}`),saved=repo.read(table,`/${w.id}`).data;
  assert.equal(saved.job.phase,"acknowledging");delete saved.job.cooldownMs;delete saved.job.skillAtStart;repo.write(table,`/${w.id}`,saved);repo.flushTableSync(table);
  w.restore();const recovered=role==="selling"?w.sellers:w.buyers;clock+=1000;assert.deepEqual((await recovered.tick({budgetMs:1000})).errors,[]);
  const state=recovered.snapshot(w.id)[role];assert.equal(state.skill.xp,100);assert.equal(state.job,null);assert.equal(state.nextCheckAtMs-clock,5000);
});

for(const scenario of [false,true,"scripted",991]){
const growth=scenario!==false,stress=typeof scenario==="string"||typeof scenario==="number";
test(stress?`equipment stress: ${scenario} markets, shortages and paid-upgrade recovery conserve the full economy`:`economy cohort: all six crews level naturally, recover first-level reply loss and resume profitable work${growth?" with automatic equipment reinvestment":""}`,async()=>{
  const w=await establish({followCourier:true,veld:5000,scordite:5000,targetT:6700,targetP:2100,budgetISK:stress?1000000:100000});
  if(growth){
    const adapter=require("../src/services/crew/crewEquipmentEconomy");w.equipmentPayment=adapter.createCrewEquipmentPayment();
    const restore=w.restore;w.restore=()=>{
      restore();
      w.equipment=require("../src/services/crew/crewEquipmentService").createCrewEquipmentService({repo:createTableRepository("service:crew-equipment"),now,
        payment:w.equipmentPayment,economy:adapter.createCrewEquipmentEconomy({mining:id=>w.miners.snapshot(id),refining:id=>w.refiners.snapshot(id),hauling:id=>w.courier.snapshot(id),
          manufacturing:id=>w.factory.snapshot(id),selling:id=>w.sellers.snapshot(id),buying:id=>w.buyers.snapshot(id),industry:w.industry,wallet})});
    };w.restore();
    await command(w.equipment,w.id,"start",{budgetISK:100000,walletReserve:100000,workingCapitalISK:1000,reinvestPercent:25,maxPaybackHours:24});
  }
  await command(w.factory,w.id,"stop");await command(w.sellers,w.id,"stop");
  const catalog=w.factory.catalog(w.id,60000003);
  await command(w.sellers,w.id,"start",{stationID:60000003,orders:[{typeID:215,reserve:0,batchSize:10000,minimumPrice:0.01},{typeID:21857,reserve:0,batchSize:100,minimumPrice:0.01}]});
  await command(w.factory,w.id,"start",{stationID:60000003,orders:catalog.map(b=>({blueprintID:b.blueprintID,runs:100,targetStock:b.productTypeID===215?20000:200}))});
  await startMiners(w);
  const teams=()=>({mining:w.miners.snapshot(w.id).mining,refining:w.refiners.snapshot(w.id).refining,hauling:w.courier.snapshot(w.id).crew,
    manufacturing:w.factory.snapshot(w.id).manufacturing,selling:w.sellers.snapshot(w.id).selling,buying:w.buyers.snapshot(w.id).buying});
  assert.ok(Object.values(teams()).every(s=>s.skill.xp===0),"The cohort must earn its levels, without seeded XP");
  const ledger=stressLedger(w),faulted=new Set(),observed=new Set(),wrapped=new WeakMap(),undo=[],levels={},applications={},equipmentApplications={},events=[];
  if(stress)ledger.factoryReadyDelayTicks=3;
  const equipmentFaults=new Set(),equipmentRetries=new Set(),call=marketDaemonClient.call;let outage=false,seed=typeof scenario==="number"?scenario:73,stressRecovery=0,blockedWindows=0,quietStress;
  const choose=values=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return values[seed%values.length];};
  if(stress){
    const debit=w.equipmentPayment.debit;
    w.equipmentPayment.debit=async(...args)=>{const result=await debit(...args);const role=args[1].role;
      if(result.success&&!equipmentFaults.has(role)){equipmentFaults.add(role);const error=Error("Equipment supplier reply lost after debit");error.code="EQUIPMENT_STRESS_DEBIT_REPLY_LOST";throw error;}return result;};
    undo.push(()=>{w.equipmentPayment.debit=debit;});
    marketDaemonClient.call=function(method,...args){return outage&&method==="GetOrders"?Promise.reject(Error("Equipment stress quote outage")):call.call(this,method,...args);};
    undo.push(()=>{marketDaemonClient.call=call;});
  }
  const escrow=require("../src/services/market/marketEscrowState");let restoredFaults=0,servicesRestored=0,allLeveledAt=null,shockAt=null,quiet=null,recoveryBatches=0,state,oreBudget=10000;
  function wrap(object,method,role,belongs){
    let methods=wrapped.get(object);if(!methods){methods=new Set();wrapped.set(object,methods);}if(methods.has(method))return;methods.add(method);
    const original=object[method];undo.push(()=>{object[method]=original;});object[method]=function(...args){
      const result=original.apply(this,args);
      if(!faulted.has(role)&&belongs(args)&&teams()[role].skill.xp>=100){
        assert.equal(teams()[role].skill.xp,100,"First-level interruption was missed");faulted.add(role);
        const error=Error(`Cohort ${role} acknowledgement reply lost`);error.code="XP_COHORT_ACK_REPLY_LOST";throw error;
      }
      return result;
    };
  }
  function installHooks(){
    wrap(w.resources,"acknowledge","mining",args=>teams().mining.job?.jobID===args[0]);
    wrap(w.inventory,"acknowledge","refining",args=>args[0].ownerID===w.id);
    wrap(w.courierInventory,"acknowledge","hauling",args=>teams().hauling.history[0]?.jobID===args[0]);
    wrap(w.industry,"acknowledge","manufacturing",args=>args[0].intent.characterID===w.id);
    wrap(escrow,"acknowledgeCrewSale","selling",args=>args[0]===w.id);
    wrap(escrow,"acknowledgeCrewPurchase","buying",args=>args[0]===w.id);
  }
  function retry(stage,errors){
    if(stage===w.equipment){assert.ok(errors.every(e=>e.ownerID===w.id&&e.code==="EQUIPMENT_STRESS_DEBIT_REPLY_LOST"));const job=w.equipment.snapshot(w.id).equipment.job;assert.ok(equipmentFaults.has(job.role)&&!equipmentRetries.has(job.role));equipmentRetries.add(job.role);events.push({tick:ledger.ticks,event:"paid_equipment_reply_lost",role:job.role,tier:job.tier});return;}
    const role=[[w.miners,"mining"],[w.refiners,"refining"],[w.courier,"hauling"],[w.factory,"manufacturing"],[w.sellers,"selling"],[w.buyers,"buying"]].find(([service])=>service===stage)?.[1];
    assert.ok(role&&faulted.has(role)&&!observed.has(role));assert.ok(errors.every(e=>e.ownerID===w.id));const team=teams()[role];
    assert.equal(team.skill.xp,100);if(role==="hauling")assert.equal(team.confirmationPending,true);else assert.equal(team.job.phase,"acknowledging");
    observed.add(role);events.push({tick:ledger.ticks,event:"level_up_acknowledgement_retry",role,xp:team.skill.xp});
  }
  function captureApplications(step){
    const current=teams();
    for(const role of Object.keys(current))if(current[role].skill.level>=1&&levels[role]===undefined)levels[role]=step;
    for(const[role,baseMs,duration]of [["mining",1000,"cycleMs"],["refining",1000,"cycleMs"],["hauling",1000,"legMs"]]){
      const job=current[role].job;if(!applications[role]&&job?.skillAtStart?.level>=1){
        const skilled=Math.ceil(baseMs*job.skillAtStart.durationBasisPoints/10000);
        assert.equal(job[duration],Math.ceil(skilled*(job.equipmentAtStart?.durationBasisPoints||10000)/10000));assert.ok(job[duration]<baseMs);
        applications[role]={level:job.skillAtStart.level,baseMs,effectiveMs:job[duration]};
      }
    }
    const job=current.manufacturing.job,quote=job?.summary;
    if(!applications.manufacturing&&quote?.crewSkill?.level>=1){
      assert.equal(quote.timeSeconds,Math.ceil(Math.ceil(quote.baseTimeSeconds*quote.crewSkill.durationBasisPoints/10000)*(quote.crewEquipment?.durationBasisPoints||10000)/10000));assert.ok(quote.timeSeconds<quote.baseTimeSeconds);
      applications.manufacturing={level:quote.crewSkill.level,baseSeconds:quote.baseTimeSeconds,effectiveSeconds:quote.timeSeconds};
    }
    for(const role of ["selling","buying"]){const team=current[role];
      if(!applications[role]&&team.skill.xp>=110&&!team.job&&team.history[0]?.completedAtMs===clock){
        const accepted=require("../src/services/crew/crewProgression").profile({progression:{version:1,xp:team.skill.xp-10}},role);
        assert.equal(team.nextCheckAtMs-clock,Math.ceil(5000*accepted.durationBasisPoints/10000));assert.ok(team.nextCheckAtMs-clock<5000);
        applications[role]={level:accepted.level,baseMs:5000,effectiveMs:team.nextCheckAtMs-clock};
      }
    }
    for(const[role,base,duration]of [["mining",1000,"cycleMs"],["hauling",1000,"legMs"]]){
      const job=current[role].job;if(job?.equipmentAtStart?.tier>=1){const skilled=Math.ceil(base*job.skillAtStart.durationBasisPoints/10000);assert.equal(job[duration],Math.ceil(skilled*job.equipmentAtStart.durationBasisPoints/10000));assert.ok(job[duration]<skilled);equipmentApplications[role]={tier:job.equipmentAtStart.tier,skilledMs:skilled,equippedMs:job[duration]};}
    }
    if(quote?.crewEquipment?.tier>=1){const skilled=Math.ceil(quote.baseTimeSeconds*quote.crewSkill.durationBasisPoints/10000);assert.equal(quote.timeSeconds,Math.ceil(skilled*quote.crewEquipment.durationBasisPoints/10000));assert.ok(quote.timeSeconds<skilled);equipmentApplications.manufacturing={tier:quote.crewEquipment.tier,skilledSeconds:skilled,equippedSeconds:quote.timeSeconds};}
  }
  installHooks();
  try{for(let step=0;step<1800;step++){
    if(shockAt===null&&step%80===0){demand.setPrice(1,step%160===0?2:3);demand.setPrice(2,step%160===0?200:50);}
    const phase=shockAt===null?-1:step-shockAt;
    if(stress&&phase===80){for(const service of [w.miners,w.refiners,w.courier])await command(service,w.id,"pause");events.push({tick:step,event:"local_supply_paused"});}
    if(stress&&phase===95){
      for(const station of [60000001,60000003])for(const item of items.listContainerItems(w.id,station,4).filter(item=>[34,35].includes(item.typeID)&&!item.custodyReservation))assert.equal(items.moveItemToLocation(item.itemID,60000099,4).success,true);
      demand.setPrice(3,1.1);demand.setRemaining(4,0);events.push({tick:step,event:"working_minerals_moved_to_remote_store_and_asks_blocked"});
    }
    if(stress&&phase===150){demand.setPrice(3,1);demand.setRemaining(4,1000000);for(const service of [w.miners,w.refiners,w.courier])await command(service,w.id,"resume");events.push({tick:step,event:"mineral_supply_restored"});}
    if(stress&&phase===190){demand.setPrice(3,1000);demand.setPrice(4,1000);events.push({tick:step,event:"all_recipes_unprofitable"});}
    if(stress&&phase===245){demand.setPrice(3,1);demand.setPrice(4,2);events.push({tick:step,event:"profitable_inputs_restored"});}
    if(stress&&phase===280){outage=true;events.push({tick:step,event:"quotes_unavailable"});}
    if(stress&&phase===325){outage=false;events.push({tick:step,event:"quotes_restored"});}
    if(stress&&typeof scenario==="number"&&phase>=360&&phase<540&&phase%20===0){
      for(const[id,price]of [[1,choose([0.1,2,3])],[2,choose([50,200,400])],[3,choose([1,1.1,1000])],[4,choose([2,2.1,1000])]])demand.setPrice(id,price);
      demand.setRemaining(1,choose([0,9999,1000000]));demand.setRemaining(2,choose([0,100,1000000]));demand.setRemaining(4,choose([0,1000000]));
    }
    if(stress&&phase===540){for(const[id,price]of [[1,2],[2,200],[3,1],[4,2]]){demand.setPrice(id,price);demand.setRemaining(id,1000000);}stressRecovery=state.f.completedBatches;events.push({tick:step,event:"final_market_recovery"});}
    state=await stressTick(w,ledger,step,outage,retry);captureApplications(step);
    if(observed.size+equipmentRetries.size>restoredFaults){
      await Promise.all([w.courier.drain(),w.miners.drain(),w.refiners.drain(),w.factory.drain(),w.sellers.drain(),w.buyers.drain(),w.equipment?.drain()]);
      const skills=Object.fromEntries(Object.entries(teams()).map(([role,team])=>[role,team.skill]));
      w.restore();installHooks();restoredFaults=observed.size+equipmentRetries.size;servicesRestored++;
      assert.deepEqual(Object.fromEntries(Object.entries(teams()).map(([role,team])=>[role,team.skill])),skills,"Service recovery changed earned experience");
    }
    if(allLeveledAt===null&&Object.keys(levels).length===6){
      allLeveledAt=step;w.scenes.add(field++,5000,1230);w.scenes.add(field++,5000,1228);oreBudget+=10000;
      events.push({tick:step,event:"all_six_leveled_and_new_finite_fields_surveyed"});
    }
    if(shockAt===null&&allLeveledAt!==null&&Object.keys(applications).length===6&&(!growth||Object.keys(equipmentApplications).length===3)){
      shockAt=step;demand.setRemaining(1,0);demand.setRemaining(2,0);events.push({tick:step,event:"demand_exhausted_after_level_ups"});
    }
    if(shockAt!==null&&step===shockAt+15)quiet={spending:stressSpending(state),xp:Object.fromEntries(Object.entries(teams()).map(([role,team])=>[role,team.skill.xp]))};
    if(shockAt!==null&&step===shockAt+45){
      assert.deepEqual(stressSpending(state),quiet.spending);assert.deepEqual(Object.fromEntries(Object.entries(teams()).map(([role,team])=>[role,team.skill.xp])),quiet.xp);
      for(const[id,price]of [[1,2],[2,200],[3,1],[4,2]]){demand.setRemaining(id,1000000);demand.setPrice(id,price);}
      recoveryBatches=state.f.completedBatches;events.push({tick:step,event:"market_reopened"});
    }
    if(stress&&[110,205,295].includes(phase))quietStress={spending:stressSpending(state),xp:[state.m,state.r,state.c,state.f,state.s,state.b].map(team=>team.skill.xp)};
    if(stress&&[140,235,315].includes(phase)){assert.deepEqual(stressSpending(state),quietStress.spending,"Blocked equipment economy spent after settling accepted work");assert.deepEqual([state.m,state.r,state.c,state.f,state.s,state.b].map(team=>team.skill.xp),quietStress.xp);blockedWindows++;}
    if(stress&&[60,170,255,335].includes(phase)){await Promise.all([w.courier.drain(),w.miners.drain(),w.refiners.drain(),w.factory.drain(),w.sellers.drain(),w.buyers.drain(),w.equipment.drain()]);w.restore();installHooks();servicesRestored++;events.push({tick:step,event:"all_services_reconstructed"});}
    if(shockAt!==null&&step>=shockAt+(stress?680:160)&&state.f.completedBatches>(stress?stressRecovery:recoveryBatches))break;
  }}finally{for(const restore of undo.reverse())restore();}
  assert.equal(Object.keys(levels).length,6,"A crew stalled before its first earned level");assert.equal(Object.keys(applications).length,6,"A crew never applied its earned bonus");
  assert.deepEqual([...observed].sort(),["buying","hauling","manufacturing","mining","refining","selling"]);
  assert.ok(shockAt!==null&&ledger.ticks>shockAt+160&&state.f.completedBatches>recoveryBatches,JSON.stringify({message:"The economy did not recover after demand returned",shockAt,ticks:ledger.ticks,recoveryBatches,completed:state.f.completedBatches,
    status:{mining:state.m.status,refining:state.r.status,hauling:state.c.standingOrder.status,factory:state.f.status,buying:state.b.status,equipment:state.g?.status},equipmentApplications,equipmentFaults:[...equipmentFaults],equipmentRetries:[...equipmentRetries],applications,levels,gear:state.g?.tiers,buyingSpent:state.b.totalSpent,gearSpent:state.g?.totalSpent}));
  assert.ok(state.m.totalMined<=oreBudget);assert.ok(wallet.getCharacterWallet(w.id).balance>ledger.wallet);
  if(growth){assert.equal(Object.keys(equipmentApplications).length,3,"An equipment investment never improved useful work");assert.ok(Object.values(state.g.tiers).every(tier=>tier>=1));assert.ok(state.g.totalSpent>0);}
  if(stress){assert.equal(equipmentRetries.size,3);assert.equal(blockedWindows,3);assert.ok(state.f.completedBatches>stressRecovery);assert.equal(state.g.job,null);}
  const finalSkills=Object.fromEntries(Object.entries(teams()).map(([role,team])=>[role,team.skill]));
  evidence.push({case:stress?"equipment_economy_stress":growth?"all_six_equipment_cohort":"all_six_xp_cohort",...(stress?{scenario,equipmentReplyFaults:equipmentRetries.size,blockedWindows}:{}),...stressEvidence(state,ledger),firstLevelTicks:levels,skillApplications:applications,skills:finalSkills,equipmentApplications,
    uniqueCompletions:Object.fromEntries([...ledger.completions].map(([role,jobs])=>[role,jobs.size])),acknowledgementFaults:observed.size,servicesRestored,events});
});
}
