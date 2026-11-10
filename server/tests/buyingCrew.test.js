"use strict";
const {createIsolatedGameStore}=require("./helpers/isolatedGameStore"),store=createIsolatedGameStore();
const {seedSellingStatic,createCrewMarketFixture}=require("./helpers/crewMarketFixture");seedSellingStatic(store);
const test=require("node:test"),assert=require("node:assert/strict"),path=require("node:path");
let clock=0,demand;const world=require("./helpers/buyingCrewFixture").createBuyingWorld({now:()=>clock});
const {database,items,courier,factory,sellers,buyers,market,make,command,establish}=world;
const wallet=require("../src/services/account/walletState"),native=require("../src/services/market/marketProxyService"),escrow=require("../src/services/market/marketEscrowState");
const {marketDaemonClient}=require("../src/services/market/marketDaemonClient");
const qty=(id,typeID=35,stationID=60000001)=>items.listContainerItems(id,stationID,4).filter(i=>i.typeID===typeID).reduce((a,i)=>a+i.quantity,0);
const policy=(extra={})=>({stationID:60000001,walletReserve:0,budgetISK:1000,orders:[{typeID:35,targetStock:21,batchSize:21,maximumPrice:2}],...extra});
const start=(id,payload=policy(),runtime=buyers)=>runtime.submit(id,command(runtime,id,"start",payload));
async function tick(time,runtime=buyers){clock=time;assert.deepEqual((await runtime.tick({budgetMs:1000})).errors,[]);}
test.before(async()=>{demand=await createCrewMarketFixture(path.join(store.storeRoot,"market.json"));marketDaemonClient.port=demand.port;demand.add({id:1,typeID:21857,price:100});demand.add({id:2,typeID:215,price:2});demand.add({id:3,typeID:35,price:2,bid:false});demand.add({id:4,typeID:34,price:4,bid:false});});
test.after(async()=>{await buyers.drain();await sellers.drain();await factory.drain();await demand.close();native.__testHooks.stopMarketExpiryPollerForTests();await native.__testHooks.waitForMarketExpiryPollerIdleForTests();clearInterval(require.cache[require.resolve("../src/space/runtime")]?.exports?._tickHandle);await new Promise(r=>setImmediate(r));await database.shutdown("buying-tests");require("../src/gameStore/sqliteStore").close();await require("../src/utils/rotatingLog").closeAll();store.cleanup();});

test("missing recipe minerals are bought from real supply using net sales income",async()=>{
  const id=90600;await establish(id);const before=wallet.getCharacterWallet(id).balance,supply=demand.remaining(3);
  const result=await start(id);assert.equal(result.buying.completedPurchases,1);assert.equal(result.buying.totalSpent,42);assert.equal(qty(id),21);assert.equal(wallet.getCharacterWallet(id).balance,before-42);assert.equal(demand.remaining(3),supply-21);
  await tick(10000);assert.equal(buyers.snapshot(id).buying.status,"stock_target_met");assert.equal(escrow.getCrewPurchaseReceipt(id).custodyKey,undefined);
});
test("a funded pilot without crew sales income cannot buy minerals",async()=>{
  clock=20000;const id=90601;await establish(id,{incomeUnits:0,balance:1000000000});const result=await start(id);
  assert.equal(result.buying.status,"waiting_for_income");assert.equal(result.buying.totalSpent,0);assert.equal(qty(id),0);assert.equal(wallet.getCharacterWallet(id).balance,1000000000);
});
test("policy budgets and wallet reserves bound partial purchases",async()=>{
  clock=30000;await establish(90602);let result=await start(90602,policy({budgetISK:20}));assert.equal(result.buying.totalSpent,20);assert.equal(qty(90602),10);
  await tick(40000);assert.equal(buyers.snapshot(90602).buying.status,"budget_exhausted");
  clock=50000;await establish(90603);const before=wallet.getCharacterWallet(90603).balance;
  result=await start(90603,policy({walletReserve:before-15}));assert.equal(result.buying.totalSpent,14);assert.equal(qty(90603),7);assert.equal(wallet.getCharacterWallet(90603).balance,before-14);
});
test("the wallet owner enforces the reserve after another expense wins a quote race",async()=>{
  clock=60000;const id=90604;await establish(id);const before=wallet.getCharacterWallet(id).balance;
  const runtime=make({market:{...market,async prepare(...args){const r=await market.prepare(...args);if(r.ready){await wallet.adjustCharacterBalanceAsync(id,-12,{description:"Concurrent production fee"});database.flushTableSync("characters");}return r;}}});
  const result=await start(id,policy({walletReserve:before-42}),runtime);assert.equal(result.buying.completedPurchases,0);assert.equal(qty(id),0);assert.equal(wallet.getCharacterWallet(id).balance,before-12);assert.equal(result.buying.history[0].rejected,true);
});
test("price ceilings and newly arrived minerals prevent unnecessary spending",async()=>{
  clock=70000;const id=90605;await establish(id);let result=await start(id,policy({orders:[{typeID:35,targetStock:21,batchSize:21,maximumPrice:1}]}));assert.equal(result.buying.status,"waiting_for_sellers");assert.equal(qty(id),0);
  await buyers.submit(id,command(buyers,id,"stop"));
  const runtime=make({market:{...market,async prepare(...args){const r=await market.prepare(...args);if(r.ready){items.grantItemToOwnerLocation(id,60000001,4,35,21);database.flushTableSync("items");}return r;}}});
  const before=wallet.getCharacterWallet(id).balance;result=await start(id,policy(),runtime);assert.equal(result.buying.completedPurchases,0);assert.equal(qty(id),21);assert.equal(wallet.getCharacterWallet(id).balance,before);
});
test("a lost fill reply recovers the same debit and mineral delivery",async()=>{
  clock=80000;const id=90606;await establish(id);const before=wallet.getCharacterWallet(id).balance,supply=demand.remaining(3);demand.dropNextFill();const result=await start(id);
  assert.equal(result.buying.job.phase,"buying");assert.equal(result.buying.completedPurchases,0);assert.equal(wallet.getCharacterWallet(id).balance,before-42);assert.equal(qty(id),0);
  await tick(90000);assert.equal(buyers.snapshot(id).buying.completedPurchases,1);assert.equal(wallet.getCharacterWallet(id).balance,before-42);assert.equal(qty(id),21);assert.equal(demand.remaining(3),supply-21);
});
test("a lost completion cannot recreate purchased minerals moved or consumed by production",async()=>{
  clock=100000;const id=90607;await establish(id);let pending=true;
  const runtime=make({market:{...market,async settle(job){const r=await market.settle(job);if(pending){pending=false;throw Error("Lost native completion");}return r;}}});
  await start(id,policy(),runtime);const item=items.listContainerItems(id,60000001,4).find(i=>i.typeID===35);items.moveItemToLocation(item.itemID,60000003,4);database.flushTableSync("items");
  await tick(110000,runtime);assert.equal(runtime.snapshot(id).buying.completedPurchases,1);assert.equal(qty(id),0);assert.equal(qty(id,35,60000003),21);
});
test("pause, stop, factory suspension and strict policy rules prevent new purchases",async()=>{
  clock=120000;const id=90608;await establish(id);items.grantItemToOwnerLocation(id,60000001,4,35,21);await start(id);
  await buyers.submit(id,command(buyers,id,"pause"));const item=items.listContainerItems(id,60000001,4).find(i=>i.typeID===35);items.moveItemToLocation(item.itemID,60000003,4);await tick(130000);assert.equal(qty(id),0);
  await buyers.submit(id,command(buyers,id,"stop"));await factory.submit(id,command(factory,id,"pause"));await assert.rejects(start(id),{code:"CREW_CARGO_INVALID"});
  await factory.submit(id,command(factory,id,"resume"));await assert.rejects(start(id,policy({orders:[{typeID:215,targetStock:21,batchSize:21,maximumPrice:2}]})),{code:"CREW_CARGO_INVALID"});
  await assert.rejects(start(id,policy({budgetISK:-1})),{code:"CREW_COMMAND_INVALID"});await assert.rejects(start(id,policy({orders:[{typeID:35,targetStock:21,batchSize:21,maximumPrice:2.001}]})),{code:"CREW_COMMAND_INVALID"});
});
test("100 purchases retain bounded completion and wallet watermarks",async()=>{
  clock=200000;const id=90609;await establish(id,{incomeUnits:100});await start(id,policy({budgetISK:5000}));
  for(let i=0;i<100;i++){
    const current=items.listContainerItems(id,60000001,4).find(i=>i.typeID===35);assert.ok(current);items.moveItemToLocation(current.itemID,60000003,4);database.flushTableSync("items");
    if(i<99)for(let pass=0;pass<3&&qty(id)===0;pass++)await tick(210000+i*10000+pass*1000);
  }
  const s=buyers.snapshot(id).buying;assert.equal(s.completedPurchases,100);assert.equal(s.history.length,20);assert.equal(s.totalSpent,4200);assert.equal(qty(id,35,60000003),2100);assert.equal(wallet.getCharacterWallet(id).balance,105000);
  const record=database.read("characters",`/${id}`).data;assert.equal(record.crewPurchaseWalletReceipts.debit.serial,100);assert.ok(Object.keys(record.crewPurchaseWalletReceipts).length<=2);assert.equal(escrow.getCrewPurchaseReceipt(id).custodyKey,undefined);
});

test("separate processes recover debits, supply fills, delivery, completion, acknowledgement and refunds",async()=>{
  const {spawn}=require("node:child_process");
  const child=(args,env)=>new Promise(resolve=>{const p=spawn(process.execPath,args,{env,windowsHide:true});let output="";p.stdout.on("data",d=>output+=d);p.stderr.on("data",d=>output+=d);const timer=setTimeout(()=>p.kill(),30000);p.on("close",code=>{clearTimeout(timer);resolve({code,output});});});
  for(const fault of ["debit","daemon","delivery","completion","ack","refund"]){
    const isolated=createIsolatedGameStore({activate:false});seedSellingStatic(isolated);const server=await createCrewMarketFixture(path.join(isolated.storeRoot,"demand.json"));
    server.add({id:1,typeID:21857,price:100});server.add({id:3,typeID:35,price:2,bid:false});
    try{for(const phase of ["fail","recover"]){
      if(phase==="fail"&&fault==="refund")server.rejectNextFill(3);
      const result=await child([path.join(__dirname,"fixtures/buyingCrewRestart.cjs"),phase,fault,String(server.port)],{...process.env,...isolated.env});
      assert.equal(result.code,phase==="fail"?70:0,`${fault}/${phase}: ${result.output}`);
    }assert.equal(server.remaining(3),fault==="refund"?1000000:999979);}
    finally{await server.close();isolated.cleanup();}
  }
});

test("module sale income buys Pyerite, resumes ammo manufacture and funds subsequent production",async()=>{
  clock=2000000;const id=90610;await establish(id,{incomeUnits:0,startFactory:false});const recipes=factory.catalog(id,60000001);
  await sellers.submit(id,command(sellers,id,"stop"));await sellers.submit(id,command(sellers,id,"start",{stationID:60000001,orders:[{typeID:21857,reserve:0,batchSize:1,minimumPrice:1},{typeID:215,reserve:0,batchSize:100,minimumPrice:1}]}));
  await factory.submit(id,command(factory,id,"start",{stationID:60000001,orders:recipes.map(b=>({blueprintID:b.blueprintID,runs:1,targetStock:b.productTypeID===215?100:1}))}));
  const initial=await start(id,policy({budgetISK:500}));assert.equal(initial.buying.status,"waiting_for_income");
  for(let i=1;i<=35;i++){
    clock=2000000+i*1000;const job=factory.snapshot(id).manufacturing.job;if(job?.phase==="building")require("../src/services/industry/industryRuntimeState").markIndustryJobReady(job.nativeJobID);
    assert.deepEqual((await factory.tick({budgetMs:1000})).errors,[]);assert.deepEqual((await sellers.tick({budgetMs:1000})).errors,[]);await tick(clock);
  }
  const b=buyers.snapshot(id).buying,s=sellers.snapshot(id).selling,f=factory.snapshot(id).manufacturing;
  assert.ok(b.purchased[35]>=21);assert.ok(f.produced[215]>=100);assert.ok(s.sold[215]>=100);assert.ok(s.netRevenue>b.totalSpent);
  assert.equal(wallet.getCharacterWallet(id).balance,Math.round((100000+s.netRevenue-b.totalSpent-f.totalFeesPaid)*100)/100);
});

test("replacing a policy cannot reuse previously spent sales income",async()=>{
  clock=3000000;const id=90611;await establish(id);await start(id);await buyers.submit(id,command(buyers,id,"stop"));
  const result=await start(id,policy({orders:[{typeID:35,targetStock:100,batchSize:100,maximumPrice:2}]}));
  assert.equal(result.buying.totalSpent,92);assert.equal(result.buying.plan.spent,50);assert.equal(qty(id),46);
  for(let i=0;i<3;i++)await tick(3010000+i*1000);assert.equal(buyers.snapshot(id).buying.status,"waiting_for_income");
});
test("a lost debit confirmation before filling supply refunds exactly once",async()=>{
  clock=3100000;const id=90612;await establish(id);const before=wallet.getCharacterWallet(id).balance,flush=database.flushTableSync;let fault=true;
  database.flushTableSync=(table,...args)=>{const r=flush(table,...args);if(fault&&table==="characters"&&wallet.getCharacterWallet(id)?.balance===before-42){fault=false;throw Error("Lost wallet confirmation");}return r;};
  try{const result=await start(id,policy({walletReserve:before-42}));assert.equal(fault,false);assert.equal(result.buying.completedPurchases,0);assert.equal(qty(id),0);assert.equal(wallet.getCharacterWallet(id).balance,before);assert.equal(result.buying.history[0].rejected,true);}
  finally{database.flushTableSync=flush;}
});
test("pausing an accepted purchase finishes its delivery and blocks new orders",async()=>{
  clock=3200000;const id=90613;await establish(id);demand.dropNextFill();await start(id);
  const result=await buyers.submit(id,command(buyers,id,"pause"));assert.equal(result.buying.paused,true);assert.equal(result.buying.completedPurchases,1);assert.equal(qty(id),21);
  const item=items.listContainerItems(id,60000001,4).find(i=>i.typeID===35);items.moveItemToLocation(item.itemID,60000003,4);await tick(3210000);assert.equal(qty(id),0);
});

test("a missing batch mineral is funded before a nonessential buffer top-up",async()=>{
  clock=3300000;const id=90614;await establish(id);
  const before=wallet.getCharacterWallet(id).balance;
  const result=await start(id,policy({orders:[
    {typeID:34,targetStock:2000,batchSize:1000,maximumPrice:4},
    {typeID:35,targetStock:105,batchSize:105,maximumPrice:2},
  ]}));
  assert.equal(result.buying.purchased[35],21,"Fund one buildable batch before filling large buffers");
  assert.equal(result.buying.purchased[34]||0,0,"Existing Tritanium already covers the next batch");
  assert.equal(wallet.getCharacterWallet(id).balance,before-42);
  for(let i=0;i<4&&!factory.snapshot(id).manufacturing.job;i++){clock+=5000;await factory.tick({budgetMs:1000});}
  assert.equal(factory.snapshot(id).manufacturing.job.phase,"building");
});

test("completed stock targets do not spend sales income on idle production buffers",async()=>{
  clock=3400000;const id=90615;await establish(id);
  items.grantItemToOwnerLocation(id,60000001,4,215,100);
  const before=wallet.getCharacterWallet(id).balance;
  await start(id);
  assert.equal(buyers.snapshot(id).buying.totalSpent,0);
  assert.equal(wallet.getCharacterWallet(id).balance,before);
});

test("a queue blocked by missing skills cannot spend income and recovers when its skill returns",async()=>{
  clock=3500000;const id=90616;await establish(id);
  const skills=require("../src/services/skills/skillState");skills.removeCharacterSkillTypes(id,[3380]);
  const before=wallet.getCharacterWallet(id).balance;const result=await start(id);
  assert.equal(result.buying.totalSpent,0);assert.equal(wallet.getCharacterWallet(id).balance,before);
  assert.equal(result.buying.status,"waiting_for_factory");
  skills.grantCharacterSkillLevels(id,[{typeID:3380,level:1}]);
  for(let i=0;i<4&&!buyers.snapshot(id).buying.completedPurchases;i++)await tick(3510000+i*10000);
  assert.equal(buyers.snapshot(id).buying.purchased[35],21);
});

test("equipment reservations made during a mineral quote cannot reuse the same sales income",async()=>{
  clock=3600000;const id=90617;await establish(id,{incomeUnits:44});items.grantItemToOwnerLocation(id,60000001,4,35,21);
  let equipmentCommitted=0;
  const runtime=make({market:{...market,funds(owner){return{...market.funds(owner),equipmentCommitted};},async prepare(...args){const result=await market.prepare(...args);if(result.ready)equipmentCommitted=2000;return result;}}});
  const before=wallet.getCharacterWallet(id).balance,supply=demand.remaining(3);
  const result=await start(id,policy({budgetISK:10000,orders:[{typeID:35,targetStock:2000,batchSize:2000,maximumPrice:2}]}),runtime);
  assert.equal(result.buying.completedPurchases,0);assert.equal(result.buying.job,null);assert.equal(result.buying.history.length,0);
  assert.equal(result.buying.status,"waiting_for_income");assert.equal(wallet.getCharacterWallet(id).balance,before);assert.equal(demand.remaining(3),supply);assert.equal(qty(id),21);
});
