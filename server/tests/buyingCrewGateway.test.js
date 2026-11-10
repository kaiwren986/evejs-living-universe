"use strict";
const {createIsolatedGameStore}=require("./helpers/isolatedGameStore"),store=createIsolatedGameStore();
const {seedSellingStatic,createCrewMarketFixture}=require("./helpers/crewMarketFixture");seedSellingStatic(store);process.env.EVEJS_WEB_GATEWAY_TOKEN="buying-test-token";
const test=require("node:test"),assert=require("node:assert/strict"),path=require("node:path"),world=require("./helpers/buyingCrewFixture").createBuyingWorld();
const {courier,factory,sellers,buyers,database}=world,{marketDaemonClient}=require("../src/services/market/marketDaemonClient");
const harness=require("./helpers/crewGatewayHarness").createCrewGatewayHarness(courier,null,null,factory,sellers,buyers);
const uri="/_evejs-web/v1/crew/buying",identity="accountID=1&characterID=90001",headers={"x-evejs-web-token":"buying-test-token"};let server,demand,base;
const post=(command,extra={})=>fetch(base+uri+"/orders",{method:"POST",headers:{...headers,"content-type":"application/json",...extra},body:JSON.stringify({accountID:1,characterID:90001,command})});
test.before(async()=>{demand=await createCrewMarketFixture(path.join(store.storeRoot,"market.json"));marketDaemonClient.port=demand.port;demand.add({id:1,typeID:21857,price:100});demand.add({id:2,typeID:35,price:2,bid:false});await world.establish(90001);server=harness.app.listen(0,"127.0.0.1");await new Promise(r=>server.once("listening",r));base=`http://127.0.0.1:${server.address().port}`;});
test.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await harness.close();await buyers.drain();await sellers.drain();await factory.drain();await demand.close();require("../src/services/market/marketProxyService").__testHooks.stopMarketExpiryPollerForTests();clearInterval(require.cache[require.resolve("../src/space/runtime")]?.exports?._tickHandle);await new Promise(r=>setImmediate(r));await database.shutdown("buying-gateway");require("../src/gameStore/sqliteStore").close();await require("../src/utils/rotatingLog").closeAll();store.cleanup();});
test("buying APIs enforce token, ownership, origin and strict budget policies",async()=>{
  assert.equal((await fetch(base+uri+"?"+identity)).status,401);assert.equal((await fetch(base+uri+"?accountID=2&characterID=90001",{headers})).status,403);
  assert.equal((await fetch(base+uri+"/catalog?"+identity+"&stationID=invalid",{headers})).status,400);assert.equal((await post({},{origin:"https://foreign.invalid"})).status,403);assert.equal((await post({},{"content-type":"text/plain"})).status,403);
  assert.equal((await post({commandID:"invalid",expectedRevision:0,type:"start",payload:{stationID:60000001,walletReserve:0,budgetISK:0,orders:[]}})).status,400);
});
test("recipe requirements, purchases, replay and procurement actors cross serialized owner IPC",async()=>{
  const catalog=await(await fetch(base+uri+"/catalog?"+identity+"&stationID=60000001",{headers})).json();assert.equal(catalog.minerals.find(m=>m.typeID===35).bestPrice,2);assert.equal(catalog.minerals.find(m=>m.typeID===35).batchRequirement,21);
  const command={commandID:"start",expectedRevision:0,type:"start",payload:{stationID:60000001,walletReserve:0,budgetISK:100,orders:[{typeID:35,targetStock:21,batchSize:21,maximumPrice:2}]}};
  const response=await post(command,{origin:base});assert.equal(response.status,200);const data=await response.json();assert.equal(data.buying.totalSpent,42);assert.equal(data.buying.completedPurchases,1);assert.equal((await(await post(command)).json()).replayed,true);
  const universe=(await(await fetch(base+"/_evejs-web/v1/crew/universe?"+identity,{headers})).json()).universe;assert.equal(universe.actors.length,8);assert.ok(universe.recentEvents.some(e=>e.type==="minerals_purchased"));
});
