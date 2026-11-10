"use strict";
const { createIsolatedGameStore } = require("./helpers/isolatedGameStore"), store = createIsolatedGameStore();
const { seedSellingStatic, createCrewMarketFixture } = require("./helpers/crewMarketFixture"); seedSellingStatic(store);
const fs = require("node:fs"), path = require("node:path");
const definitions = JSON.parse(fs.readFileSync(path.join(store.dataDir,"industryBlueprints/data.json")));
definitions.blueprintDefinitions.find(b => b.productTypeID === 21857).activities.manufacturing.time = 20;
store.writeStatic("industryBlueprints",definitions);
const test = require("node:test"), assert = require("node:assert/strict");
const database = require("../src/gameStore"), items = require("../src/services/inventory/itemStore"), worldData = require("../src/space/worldData");
const { createTableRepository } = require("../src/gameStore/tableRepository");
const native = require("../src/services/industry/industryRuntimeState"), wallet = require("../src/services/account/walletState");
const nativeMarket = require("../src/services/market/marketProxyService"), { marketDaemonClient } = require("../src/services/market/marketDaemonClient");
let clock=0,serial=0,nextID=90900,demand,factory,sellers,buyers;const evidence=[];
const courier=require("../src/services/crew/crewService").createCrewService({repo:createTableRepository("service:crew"),
  inventory:require("../src/services/crew/crewInventory").createCrewInventory({items}),world:require("../src/services/crew/crewRuntime").createCrewWorld(worldData),
  character:id=>database.read("characters",`/${id}`).data,now:()=>clock});
const profit=require("../src/services/crew/crewProfitability").createCrewProfitability({worldData,selling:id=>sellers?.snapshot(id),now:()=>clock});
const industry=require("../src/services/crew/manufacturingCrewIndustry").createManufacturingCrewIndustry({items,worldData,profitability:profit});
function restore(){
  factory=require("../src/services/crew/manufacturingCrewService").createManufacturingCrewService({repo:createTableRepository("service:crew-manufacturing"),industry,crew:id=>courier.snapshot(id),now:()=>clock});
  sellers=require("../src/services/crew/sellingCrewService").createSellingCrewService({repo:createTableRepository("service:crew-selling"),
    market:require("../src/services/crew/sellingCrewMarket").createSellingCrewMarket({items,worldData,productionTypes:()=>[215,21857]}),crew:id=>courier.snapshot(id),now:()=>clock});
  buyers=require("../src/services/crew/buyingCrewService").createBuyingCrewService({repo:createTableRepository("service:crew-buying"),
    market:require("../src/services/crew/buyingCrewMarket").createBuyingCrewMarket({items,worldData,profitability:profit,manufacturing:id=>factory.snapshot(id),selling:id=>sellers.snapshot(id)}),crew:id=>courier.snapshot(id),now:()=>clock});
}
restore();
const command=(service,id,type,payload={})=>service.submit(id,{commandID:`adaptive:${++serial}`,expectedRevision:service.snapshot(id).revision,type,payload});
const qty=(id,typeID)=>items.listContainerItems(id,60000001,4).filter(i=>i.typeID===typeID).reduce((n,i)=>n+i.quantity,0);
async function establish({tritanium=5000,pyerite=500,income=false}={}){
  clock+=100000;const id=nextID++;
  require("./helpers/manufacturingCrewFixture").fundManufacturingPilot(database,items,id,100000);
  if(tritanium<1000){for(const i of items.listContainerItems(id,60000001,4).filter(i=>i.typeID===34))items.consumeInventoryItemQuantity(i.itemID,i.quantity);}
  if(tritanium!==1000)items.grantItemToOwnerLocation(id,60000001,4,34,tritanium<1000?tritanium:tritanium-1000);
  if(pyerite)items.grantItemToOwnerLocation(id,60000001,4,35,pyerite);
  await command(courier,id,"create",{name:"Adaptive production crew"});await command(factory,id,"starter",{stationID:60000001});
  if(income)items.grantItemToOwnerLocation(id,60000001,4,21857,1);
  await command(sellers,id,"start",{stationID:60000001,orders:[{typeID:215,reserve:0,batchSize:100,minimumPrice:0.01},{typeID:21857,reserve:0,batchSize:1,minimumPrice:0.01}]});
  const catalog=factory.catalog(id,60000001);
  return{id,ammo:catalog.find(b=>b.productTypeID===215),module:catalog.find(b=>b.productTypeID===21857)};
}
const start=(w,{ammoTarget=200,moduleTarget=2}={})=>command(factory,w.id,"start",{stationID:60000001,orders:[
  {blueprintID:w.module.blueprintID,runs:1,targetStock:moduleTarget},{blueprintID:w.ammo.blueprintID,runs:1,targetStock:ammoTarget}]});
const buy=id=>command(buyers,id,"start",{stationID:60000001,walletReserve:100000,budgetISK:10000,orders:[
  {typeID:35,targetStock:105,batchSize:105,maximumPrice:2},{typeID:34,targetStock:470,batchSize:470,maximumPrice:1}]});
async function advance(service,predicate){
  for(let i=0;i<12&&!predicate();i++){clock+=10000;assert.deepEqual((await service.tick({budgetMs:1000})).errors,[]);}
  assert.ok(predicate(),"The crew must reach the expected decision");
}
async function finish(id){
  const state=factory.snapshot(id).manufacturing,count=state.completedBatches;
  assert.equal(native.markIndustryJobReady(state.job.nativeJobID).success,true);
  await advance(factory,()=>factory.snapshot(id).manufacturing.completedBatches===count+1);
}
test.before(async()=>{demand=await createCrewMarketFixture(path.join(store.storeRoot,"market.json"));marketDaemonClient.port=demand.port;});
test.beforeEach(()=>{demand.resetOrders();demand.add({id:1,typeID:215,price:2});demand.add({id:2,typeID:21857,price:1000});
  demand.add({id:3,typeID:34,price:1,bid:false});demand.add({id:4,typeID:35,price:2,bid:false});});
test.after(async()=>{
  if(process.env.EVEJS_PRIORITY_EVIDENCE)fs.writeFileSync(process.env.EVEJS_PRIORITY_EVIDENCE,JSON.stringify({decisions:evidence,eveLaunched:false},null,2)+"\n");
  await Promise.all([factory.drain(),sellers.drain(),buyers.drain()]);await demand.close();nativeMarket.__testHooks.stopMarketExpiryPollerForTests();await nativeMarket.__testHooks.waitForMarketExpiryPollerIdleForTests();
  clearInterval(require.cache[require.resolve("../src/space/runtime")]?.exports?._tickHandle);await new Promise(r=>setImmediate(r));
  await database.shutdown("adaptive-production-tests");require("../src/gameStore/sqliteStore").close();await require("../src/utils/rotatingLog").closeAll();store.cleanup();
});

test("profit per native production hour beats queue order and higher total batch profit",async()=>{
  const w=await establish(),result=await start(w),state=result.manufacturing;
  assert.equal(state.job.summary.productTypeID,215);
  const [ammo,module]=state.selection.candidates;
  assert.equal(ammo.productTypeID,215);assert.ok(module.expectedProfit>ammo.expectedProfit);assert.ok(ammo.profitPerHour>module.profitPerHour);
  assert.equal(state.selection.selectedBlueprintID,w.ammo.blueprintID);assert.equal(state.selection.strategy,"profit_per_hour");
  assert.equal(native.listJobsByOwner(w.id,true).length,1,"Quoting losing candidates cannot install jobs");
  assert.equal(wallet.getCharacterWallet(w.id).balance,100000-18);
  evidence.push({case:"profit_per_hour",selection:state.selection});
});

test("price changes switch the next batch after the existing job survives reconstruction",async()=>{
  const w=await establish();await start(w);const first=factory.snapshot(w.id).manufacturing.job;
  demand.setPrice(2,1200);restore();clock+=10000;await factory.tick({budgetMs:1000});
  assert.equal(factory.snapshot(w.id).manufacturing.job.jobID,first.jobID);assert.equal(wallet.getCharacterWallet(w.id).balance,99982);
  await finish(w.id);await advance(factory,()=>factory.snapshot(w.id).manufacturing.job?.summary.productTypeID===21857);
  assert.equal(factory.snapshot(w.id).manufacturing.selection.selectedBlueprintID,w.module.blueprintID);
  assert.equal(wallet.getCharacterWallet(w.id).balance,99972);assert.equal(qty(w.id,215),100);
  evidence.push({case:"price_change_after_restart",selection:factory.snapshot(w.id).manufacturing.selection});
});

test("unsold surplus consumes the best bids before valuing another batch",async()=>{
  const w=await establish();demand.add({id:2,typeID:21857,price:2000,quantity:1});demand.add({id:5,typeID:21857,price:300});
  items.grantItemToOwnerLocation(w.id,60000001,4,21857,1);
  const result=await start(w);assert.equal(result.manufacturing.job.summary.productTypeID,215);
  const quoted=result.manufacturing.availability.find(a=>a.blueprintID===w.module.blueprintID).profit;
  assert.equal(quoted.committedSurplus,1);assert.equal(quoted.grossRevenue,300);assert.equal(quoted.expectedProfit,199);
});

test("exhausted demand causes a fallback and replenished demand changes the following choice",async()=>{
  const w=await establish();demand.add({id:2,typeID:21857,price:1200,quantity:1});
  items.grantItemToOwnerLocation(w.id,60000001,4,21857,1);
  await start(w);assert.equal(factory.snapshot(w.id).manufacturing.job.summary.productTypeID,215);
  assert.equal(factory.snapshot(w.id).manufacturing.availability.find(a=>a.blueprintID===w.module.blueprintID).status,"waiting_for_profitable_demand");
  demand.add({id:2,typeID:21857,price:1200,quantity:100});
  await finish(w.id);await advance(factory,()=>factory.snapshot(w.id).manufacturing.job?.summary.productTypeID===21857);
});

test("a ready lower-rate recipe runs while the highest-rate recipe lacks minerals",async()=>{
  demand.setPrice(2,1200);const w=await establish({tritanium:30,pyerite:21});
  const result=await start(w);assert.equal(result.manufacturing.job.summary.productTypeID,215);
  const top=result.manufacturing.selection.candidates[0];assert.equal(top.productTypeID,21857);assert.equal(top.ready,false);assert.equal(top.status,"waiting_for_materials");
  assert.equal(qty(w.id,34),3);assert.equal(qty(w.id,35),0);
});

test("the highest-rate product stops at its configured stock target",async()=>{
  demand.setPrice(2,1200);const w=await establish();items.grantItemToOwnerLocation(w.id,60000001,4,21857,2);
  const result=await start(w);assert.equal(result.manufacturing.job.summary.productTypeID,215);
  assert.equal(result.manufacturing.plan.orders[0].targetStock,2);assert.equal(result.manufacturing.plan.orders[1].targetStock,200);
  assert.equal(result.manufacturing.availability.find(a=>a.blueprintID===w.module.blueprintID).status,"stock_target_met");
});

test("procurement feeds the highest-rate shortage before the first mineral in the policy",async()=>{
  demand.setPrice(2,1200);const w=await establish({tritanium:0,pyerite:0,income:true});await start(w,{moduleTarget:1});
  const result=await buy(w.id);assert.equal(result.buying.purchased[34],67);assert.equal(result.buying.purchased[35]||0,0);
  assert.equal(result.buying.priority.productTypeID,21857);assert.equal(result.buying.totalSpent,67);
  await advance(factory,()=>factory.snapshot(w.id).manufacturing.job?.summary.productTypeID===21857);
  await advance(buyers,()=>buyers.snapshot(w.id).buying.purchased[35]===21);
  assert.equal(buyers.snapshot(w.id).buying.priority.productTypeID,215,"Incoming module already covers its target");
  evidence.push({case:"procurement_after_incoming_target",priority:buyers.snapshot(w.id).buying.priority,spent:buyers.snapshot(w.id).buying.totalSpent});
});

test("a price change redirects the next mineral purchase to the newly best recipe",async()=>{
  const w=await establish({tritanium:0,pyerite:0,income:true});await start(w);let result=await buy(w.id);
  assert.equal(result.buying.priority.productTypeID,215);assert.equal(result.buying.purchased[35],21);
  demand.setPrice(2,1200);await advance(buyers,()=>buyers.snapshot(w.id).buying.purchased[34]>0);
  result=buyers.snapshot(w.id);assert.equal(result.buying.priority.productTypeID,21857);assert.equal(result.buying.purchased[34],67);
});

test("all losing recipes wait without fees, then select the best recovered opportunity",async()=>{
  demand.setPrice(1,0.1);demand.setPrice(2,1);const w=await establish();await start(w);
  assert.equal(factory.snapshot(w.id).manufacturing.job,null);assert.equal(wallet.getCharacterWallet(w.id).balance,100000);
  demand.setPrice(1,2);demand.setPrice(2,1200);restore();await advance(factory,()=>factory.snapshot(w.id).manufacturing.job?.summary.productTypeID===21857);
  assert.equal(wallet.getCharacterWallet(w.id).balance,99990);
});

test("equal profit rates rotate instead of starving the next recipe",async()=>{
  const w=await establish();const ammoQuote=await profit.evaluate(w.id,60000001,w.ammo,w.ammo.cost,{targetStock:200});
  const moduleQuote=await profit.evaluate(w.id,60000001,w.module,w.module.cost,{targetStock:2});
  const desiredProfit=Math.round(ammoQuote.expectedProfit*100*w.module.timeSeconds/w.ammo.timeSeconds);
  const desiredNet=desiredProfit+Math.round(moduleQuote.totalCost*100),estimate=Math.round(desiredNet/(1-moduleQuote.salesTax/moduleQuote.grossRevenue));
  let price;
  for(let candidate=estimate-100;candidate<=estimate+100;candidate++)if(candidate-Math.round(nativeMarket.quoteCrewSalesTax(w.id,60000001,candidate/100)*100)===desiredNet){price=candidate/100;break;}
  assert.ok(price);demand.setPrice(2,price);await start(w);
  assert.equal(factory.snapshot(w.id).manufacturing.job.summary.productTypeID,21857);
  await finish(w.id);await advance(factory,()=>factory.snapshot(w.id).manufacturing.job?.summary.productTypeID===215);
});

test("a price change during quote refresh can replace a still-profitable first choice",async()=>{
  const w=await establish();let change=true;
  factory=require("../src/services/crew/manufacturingCrewService").createManufacturingCrewService({repo:createTableRepository("service:crew-manufacturing"),
    industry:{...industry,async prepare(...args){if(change){change=false;demand.setPrice(1,1.5);}return industry.prepare(...args);}},crew:id=>courier.snapshot(id),now:()=>clock});
  await start(w);assert.equal(factory.snapshot(w.id).manufacturing.job.summary.productTypeID,21857);
  assert.equal(wallet.getCharacterWallet(w.id).balance,99990);assert.equal(qty(w.id,35),500);
  restore();
});
