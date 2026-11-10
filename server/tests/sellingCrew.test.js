"use strict";
const {createIsolatedGameStore}=require("./helpers/isolatedGameStore"),store=createIsolatedGameStore();
const {createCrewMarketFixture,seedSellingStatic}=require("./helpers/crewMarketFixture");seedSellingStatic(store);
const test=require("node:test"),assert=require("node:assert/strict"),path=require("node:path");
const database=require("../src/gameStore"),items=require("../src/services/inventory/itemStore"),wallet=require("../src/services/account/walletState");
const {createTableRepository}=require("../src/gameStore/tableRepository"),worldData=require("../src/space/worldData");
const courier=require("../src/services/crew/crewService").createCrewService({repo:createTableRepository("service:crew"),inventory:require("../src/services/crew/crewInventory").createCrewInventory({items}),
  world:require("../src/services/crew/crewRuntime").createCrewWorld(worldData),character:id=>database.read("characters",`/${id}`).data,now:()=>clock,legMs:1000});
const market=require("../src/services/crew/sellingCrewMarket").createSellingCrewMarket({items,worldData,productionTypes:()=>[215,21857]});
const native=require("../src/services/market/marketProxyService"),escrow=require("../src/services/market/marketEscrowState");
const {marketDaemonClient}=require("../src/services/market/marketDaemonClient");
let clock=0,sequence=0,demand;
const make=(overrides={})=>require("../src/services/crew/sellingCrewService").createSellingCrewService({repo:createTableRepository("service:crew-selling"),market,crew:id=>courier.snapshot(id),now:()=>clock,...overrides});
const service=make(),order=(runtime,id,type,payload={})=>({commandID:`sell-test:${++sequence}`,expectedRevision:runtime.snapshot(id).revision,type,payload});
function establish(id){require("./helpers/manufacturingCrewFixture").fundManufacturingPilot(database,items,id);courier.submit(id,order(courier,id,"create",{name:"Industry and trade"}));}
const policy=(typeID=215,reserve=100,batchSize=100,minimumPrice=1)=>({typeID,reserve,batchSize,minimumPrice});
const start=(id,orders=[policy()],runtime=service,stationID=60000001)=>runtime.submit(id,order(runtime,id,"start",{stationID,orders}));
const qty=(id,typeID,station=60000001)=>items.listContainerItems(id,station,4).filter(i=>i.typeID===typeID).reduce((a,i)=>a+i.quantity,0);
async function tick(time,runtime=service){clock=time;assert.deepEqual((await runtime.tick({budgetMs:1000})).errors,[]);}
test.before(async()=>{demand=await createCrewMarketFixture(path.join(store.storeRoot,"market-fixture.json"));marketDaemonClient.port=demand.port;demand.add({id:1,typeID:215,price:2});demand.add({id:2,typeID:21857,price:100});});
test.after(async()=>{await service.drain();await demand.close();native.__testHooks.stopMarketExpiryPollerForTests();await native.__testHooks.waitForMarketExpiryPollerIdleForTests();
  clearInterval(require.cache[require.resolve("../src/space/runtime")]?.exports?._tickHandle);await new Promise(r=>setImmediate(r));await database.shutdown("selling-tests");require("../src/gameStore/sqliteStore").close();await require("../src/utils/rotatingLog").closeAll();store.cleanup();});

test("surplus sales keep the reserve, consume actual demand and pay net native proceeds once",async()=>{
  establish(90500);items.grantItemToOwnerLocation(90500,60000001,4,215,200);const remaining=demand.remaining(1),before=wallet.getCharacterWallet(90500).balance;
  const accepted=await start(90500);assert.equal(accepted.selling.completedSales,1);assert.equal(qty(90500,215),100);assert.equal(demand.remaining(1),remaining-100);
  assert.equal(accepted.selling.grossRevenue,200);assert.equal(accepted.selling.taxPaid,16);assert.equal(accepted.selling.netRevenue,184);assert.equal(wallet.getCharacterWallet(90500).balance,before+184);
  await tick(10000);assert.equal(service.snapshot(90500).selling.status,"reserve_met");assert.equal(escrow.getCrewSaleReceipt(90500).custodyKeys,undefined);
});
test("price floors, missing buyers, minimum volumes and partial demand leave unsold goods safe",async()=>{
  clock=20000;establish(90501);items.grantItemToOwnerLocation(90501,60000001,4,21857,6);
  let s=await start(90501,[policy(21857,1,10,101)]);assert.equal(s.selling.status,"waiting_for_buyers");assert.equal(qty(90501,21857),6);
  await service.submit(90501,order(service,90501,"stop"));demand.add({id:3,typeID:21857,price:110,quantity:2,minVolume:2});
  s=await start(90501,[policy(21857,1,10,101)]);assert.equal(s.selling.sold[21857],2);assert.equal(qty(90501,21857),4);await tick(30000);assert.equal(qty(90501,21857),4);
});
test("a lost daemon fill reply recovers one sale with the same payment and demand receipt",async()=>{
  clock=40000;establish(90502);items.grantItemToOwnerLocation(90502,60000001,4,215,200);demand.dropNextFill();
  const remaining=demand.remaining(1),s=await start(90502);assert.equal(s.selling.job.phase,"selling");assert.equal(qty(90502,215),100);assert.equal(s.selling.completedSales,0);
  await tick(50000);assert.equal(service.snapshot(90502).selling.completedSales,1);assert.equal(wallet.getCharacterWallet(90502).balance,100184);assert.equal(demand.remaining(1),remaining-100);
});
test("lost native completion and acknowledgement replies cannot repeat sales after stock moved onward",async()=>{
  clock=60000;establish(90503);items.grantItemToOwnerLocation(90503,60000001,4,215,200);let fail=true;
  const runtime=make({market:{...market,async settle(job){const result=await market.settle(job);if(fail){fail=false;throw Error("Lost completion");}return result;}}});
  await start(90503,undefined,runtime);const item=items.listContainerItems(90503,60000001,4).find(i=>i.typeID===215);items.moveItemToLocation(item.itemID,60000003,4);database.flushTableSync("items");
  await tick(70000,runtime);assert.equal(runtime.snapshot(90503).selling.completedSales,1);assert.equal(qty(90503,215,60000003),100);assert.equal(qty(90503,215),0);assert.equal(wallet.getCharacterWallet(90503).balance,100184);
});
test("pause, resume and stop prevent new sales while preserving completed results and identities",async()=>{
  clock=80000;establish(90504);await start(90504);await service.submit(90504,order(service,90504,"pause"));items.grantItemToOwnerLocation(90504,60000001,4,215,200);await tick(90000);assert.equal(qty(90504,215),200);
  await service.submit(90504,order(service,90504,"resume"));assert.equal(qty(90504,215),100);await service.submit(90504,order(service,90504,"stop"));items.grantItemToOwnerLocation(90504,60000001,4,215,100);await tick(100000);assert.equal(qty(90504,215),200);
  assert.equal(service.universeFacts({ownerID:90504}).actors[0].actorID,"selling:90504:member:0");assert.equal(service.universeFacts({ownerID:90504}).recentEvents[0].type,"goods_sold");
});
test("strict product policies, command replay and stale revisions never sell unauthorized goods",async()=>{
  clock=110000;establish(90505);
  await assert.rejects(start(90505,[policy(34)]),{code:"CREW_CARGO_INVALID"});await assert.rejects(start(90505,[{...policy(),minimumPrice:0}]),{code:"CREW_COMMAND_INVALID"});
  await assert.rejects(start(90505,[{...policy(),reserve:-1}]),{code:"CREW_COMMAND_INVALID"});await assert.rejects(start(90505,[{...policy(),itemID:123}]),{code:"CREW_COMMAND_INVALID"});
  const c=order(service,90505,"start",{stationID:60000001,orders:[policy()]});await service.submit(90505,c);assert.equal((await service.submit(90505,c)).replayed,true);
  await assert.rejects(service.submit(90505,{...c,payload:{...c.payload,orders:[policy(215,0)]}}),{code:"CREW_COMMAND_REUSED"});await assert.rejects(service.submit(90505,{...order(service,90505,"pause"),expectedRevision:0}),{code:"CREW_REVISION_CONFLICT"});
});
test("100 sales retain one native completion watermark and bounded crew/custody records",async()=>{
  clock=120000;establish(90506);await start(90506,[policy(215,0)]);
  for(let i=0;i<100;i++){items.grantItemToOwnerLocation(90506,60000001,4,215,100);await tick(130000+i*10000);}
  const s=service.snapshot(90506).selling;assert.equal(s.completedSales,100);assert.equal(s.history.length,20);assert.equal(s.sold[215],10000);assert.equal(s.netRevenue,18400);assert.equal(wallet.getCharacterWallet(90506).balance,118400);assert.equal(escrow.getCrewSaleReceipt(90506).serial,100);
  const receipts=Object.values(database.read("items","/__evejsInventoryGrantReceipts").data||{});assert.equal(receipts.filter(r=>r.receiptKey?.startsWith("item-custody:")&&JSON.stringify(r).includes('"ownerID":90506')).length,0);
});

test("separate processes recover reservation, demand fill, consumption, wallet and completion crashes",async()=>{
  const {spawn}=require("node:child_process");
  const child=(args,env)=>new Promise(resolve=>{const p=spawn(process.execPath,args,{env,windowsHide:true});let output="";p.stdout.on("data",d=>output+=d);p.stderr.on("data",d=>output+=d);const timeout=setTimeout(()=>p.kill(),30000);p.on("close",code=>{clearTimeout(timeout);resolve({code,output});});});
  for(const fault of ["reserve","daemon","consume","credit","tax","completion","ack"]){
    const isolated=createIsolatedGameStore({activate:false});seedSellingStatic(isolated);const marketServer=await createCrewMarketFixture(path.join(isolated.storeRoot,"demand.json"));marketServer.add({id:1,typeID:215,price:2});
    try{for(const phase of ["fail","recover"]){const result=await child([path.join(__dirname,"fixtures/sellingCrewRestart.cjs"),phase,fault,String(marketServer.port)],{...process.env,...isolated.env});assert.equal(result.code,phase==="fail"?70:0,`${fault}/${phase}: ${result.output}`);}assert.equal(marketServer.remaining(1),999900);}
    finally{await marketServer.close();isolated.cleanup();}
  }
});

test("finite mining, refining, mixed hauling, manufacture and sales fund the same pilot wallet",async()=>{
  clock=2000000;const id=90507;establish(id);
  demand.add({id:4,typeID:215,price:20,stationID:60000003});demand.add({id:5,typeID:21857,price:200,stationID:60000003});
  const scenes=require("./helpers/miningCrewFixture").createFiniteScenes();scenes.add(40010,1000,1228);
  const miners=require("../src/services/crew/miningCrewService").createMiningCrewService({repo:createTableRepository("service:crew-mining"),resources:require("../src/services/crew/miningCrewResources").createMiningCrewResources({items,worldData,sceneForSystem:scenes.sceneForSystem}),crew:id=>courier.snapshot(id),now:()=>clock,cycleMs:1000,travelMs:1000,batchM3:150});
  const refiners=require("../src/services/crew/refiningCrewService").createRefiningCrewService({repo:createTableRepository("service:crew-refining"),inventory:require("../src/services/crew/refiningCrewInventory").createRefiningCrewInventory({items,worldData}),crew:id=>courier.snapshot(id),now:()=>clock,cycleMs:1000});
  const factory=require("../src/services/crew/manufacturingCrewService").createManufacturingCrewService({repo:createTableRepository("service:crew-manufacturing"),industry:require("../src/services/crew/manufacturingCrewIndustry").createManufacturingCrewIndustry({items,worldData,profitability:require("./helpers/nativeIndustryProfitFixture")}),crew:id=>courier.snapshot(id),now:()=>clock});
  await factory.submit(id,order(factory,id,"starter",{stationID:60000003}));const blueprints=factory.catalog(id,60000003);
  miners.submit(id,order(miners,id,"start",{homeStationID:60000001,beltID:40010,typeID:1228}));await refiners.submit(id,order(refiners,id,"start",{stationID:60000001,typeID:1228,oreReserve:0}));
  courier.submit(id,order(courier,id,"automate",{sourceStationID:60000001,destinationStationID:60000003,typeID:34,typeIDs:[34,35],sourceReserve:0}));
  await factory.submit(id,order(factory,id,"start",{stationID:60000003,orders:blueprints.map(b=>({blueprintID:b.blueprintID,runs:1,targetStock:b.productTypeID===215?100:1}))}));
  await start(id,[policy(215,0,100,10),policy(21857,0,1,100)],service,60000003);
  for(let i=1;i<=40;i++){clock=2000000+i*1000;assert.deepEqual(miners.tick({budgetMs:1000}).errors,[]);assert.deepEqual((await refiners.tick({budgetMs:1000})).errors,[]);assert.deepEqual(courier.tick({budgetMs:1000}).errors,[]);
    const job=factory.snapshot(id).manufacturing.job;if(job?.phase==="building")require("../src/services/industry/industryRuntimeState").markIndustryJobReady(job.nativeJobID);
    assert.deepEqual((await factory.tick({budgetMs:1000})).errors,[]);await tick(clock);}
  const f=factory.snapshot(id).manufacturing,r=refiners.snapshot(id).refining,s=service.snapshot(id).selling;
  assert.equal(r.totalOreProcessed,1000);assert.ok(s.sold[215]>=100&&s.sold[21857]>=1);
  assert.equal(wallet.getCharacterWallet(id).balance,Math.round((100000-r.totalTaxPaid-f.totalFeesPaid+s.netRevenue)*100)/100);
  for(const typeID of [215,21857])assert.equal(f.produced[typeID],(s.sold[typeID]||0)+qty(id,typeID,60000003));
  assert.ok(s.netRevenue>r.totalTaxPaid+f.totalFeesPaid,"Sales must fund the native refining and factory fees");
});

test("a changed reserve before native custody rejects the saved offer without touching the remaining goods",async()=>{
  clock=2100000;const id=90508;establish(id);items.grantItemToOwnerLocation(id,60000001,4,215,200);
  const runtime=make({market:{...market,async prepare(...args){const result=await market.prepare(...args);if(result.ready){items.moveItemToLocation(result.saga.itemLegs[0].sourceItem.itemID,60000003,4);database.flushTableSync("items");}return result;}}});
  const result=await start(id,[policy()],runtime);assert.equal(result.selling.completedSales,0);assert.equal(wallet.getCharacterWallet(id).balance,100000);assert.equal(qty(id,215,60000003),200);
});
test("native completion must be durable before crew totals or receipt retirement",async()=>{
  clock=2200000;const id=90509;establish(id);items.grantItemToOwnerLocation(id,60000001,4,215,200);
  const original=database.flushTableSync;let blocked=true;
  database.flushTableSync=(table,...args)=>{if(blocked&&table==="marketEscrow"&&database.read("marketEscrow",`/_crewSales/${id}`).data)return{success:false,errorMsg:"Injected completion fence"};return original(table,...args);};
  try{const accepted=await start(id);assert.equal(accepted.selling.completedSales,0);assert.equal(accepted.selling.job.phase,"selling");assert.equal(wallet.getCharacterWallet(id).balance,100184);
    blocked=false;await tick(2210000);assert.equal(service.snapshot(id).selling.completedSales,1);assert.equal(wallet.getCharacterWallet(id).balance,100184);
  }finally{database.flushTableSync=original;}
});

test("an exhausted bid compensates reserved goods without charging or paying the seller",async()=>{
  clock=2300000;const id=90510;establish(id);items.grantItemToOwnerLocation(id,60000001,4,21857,2);demand.add({id:30,typeID:21857,price:300,quantity:1});
  const runtime=make({market:{...market,async prepare(...args){const r=await market.prepare(...args);if(r.ready)demand.add({id:30,typeID:21857,price:300,quantity:0});return r;}}});
  const result=await start(id,[policy(21857,1,1,300)],runtime);assert.equal(result.selling.completedSales,0);assert.equal(result.selling.history[0].rejected,true);assert.equal(qty(id,21857),2);assert.equal(wallet.getCharacterWallet(id).balance,100000);
});
test("a lost reservation checkpoint can compensate using the committed native custody receipt",async()=>{
  clock=2400000;const id=90511;establish(id);items.grantItemToOwnerLocation(id,60000001,4,215,200);
  const custody=require("../src/services/inventory/marketItemCustody"),original=custody.reserveSeedItem;let pending=true;
  custody.reserveSeedItem=(...args)=>{const r=original(...args);if(r.success&&pending){pending=false;throw Error("Lost reserve checkpoint");}return r;};
  try{const result=await start(id);assert.equal(result.selling.completedSales,0);assert.equal(qty(id,215),200);assert.equal(wallet.getCharacterWallet(id).balance,100000);}
  finally{custody.reserveSeedItem=original;}
});

test("an unreadable custody receipt holds compensation until its durable reservation can be recovered",async()=>{
  clock=2500000;const id=90512;establish(id);items.grantItemToOwnerLocation(id,60000001,4,215,200);
  const custody=require("../src/services/inventory/marketItemCustody"),receipts=require("../src/services/inventory/itemCustody"),reserve=custody.reserveSeedItem,read=receipts.getCommittedReceipt;let blocked=false;
  custody.reserveSeedItem=(...args)=>{const r=reserve(...args);if(r.success){blocked=true;throw Error("Lost checkpoint");}return r;};
  receipts.getCommittedReceipt=(...args)=>blocked?{success:false,committed:false,errorMsg:"Receipt durability pending"}:read(...args);
  try{const accepted=await start(id);assert.equal(accepted.selling.completedSales,0);assert.equal(accepted.selling.job.phase,"selling");assert.equal(qty(id,215),100);assert.equal(wallet.getCharacterWallet(id).balance,100000);}
  finally{custody.reserveSeedItem=reserve;receipts.getCommittedReceipt=read;}
  for(let i=0;i<4&&service.snapshot(id).selling.job;i++)await tick(2510000+i*1000);
  assert.equal(service.snapshot(id).selling.job,null);assert.equal(qty(id,215),200);assert.equal(wallet.getCharacterWallet(id).balance,100000);
});
