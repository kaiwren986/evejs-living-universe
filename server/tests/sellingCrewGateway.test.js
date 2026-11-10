"use strict";
const {createIsolatedGameStore}=require("./helpers/isolatedGameStore"),store=createIsolatedGameStore();
const {createCrewMarketFixture,seedSellingStatic}=require("./helpers/crewMarketFixture");seedSellingStatic(store);
process.env.EVEJS_WEB_GATEWAY_TOKEN="selling-test-token";
const test=require("node:test"),assert=require("node:assert/strict"),path=require("node:path"),database=require("../src/gameStore"),items=require("../src/services/inventory/itemStore");
require("./helpers/manufacturingCrewFixture").fundManufacturingPilot(database,items);
const {createTableRepository}=require("../src/gameStore/tableRepository"),worldData=require("../src/space/worldData");
const courier=require("../src/services/crew/crewService").createCrewService({repo:createTableRepository("service:crew"),inventory:require("../src/services/crew/crewInventory").createCrewInventory({items}),world:require("../src/services/crew/crewRuntime").createCrewWorld(worldData),character:id=>database.read("characters",`/${id}`).data});
courier.submit(90001,{commandID:"crew",expectedRevision:0,type:"create",payload:{name:"Gateway traders"}});
const sellers=require("../src/services/crew/sellingCrewService").createSellingCrewService({repo:createTableRepository("service:crew-selling"),market:require("../src/services/crew/sellingCrewMarket").createSellingCrewMarket({items,worldData,productionTypes:()=>[215,21857]}),crew:id=>courier.snapshot(id)});
const harness=require("./helpers/crewGatewayHarness").createCrewGatewayHarness(courier,null,null,null,sellers);
let demand,server,base;const uri="/_evejs-web/v1/crew/selling",identity="accountID=1&characterID=90001",headers={"x-evejs-web-token":"selling-test-token"};
const post=(command,extra={})=>fetch(base+uri+"/orders",{method:"POST",headers:{...headers,"content-type":"application/json",...extra},body:JSON.stringify({accountID:1,characterID:90001,command})});
test.before(async()=>{demand=await createCrewMarketFixture(path.join(store.storeRoot,"market.json"));require("../src/services/market/marketDaemonClient").marketDaemonClient.port=demand.port;demand.add({id:1,typeID:215,price:2});server=harness.app.listen(0,"127.0.0.1");await new Promise(r=>server.once("listening",r));base=`http://127.0.0.1:${server.address().port}`;});
test.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await harness.close();await sellers.drain();await demand.close();require("../src/services/market/marketProxyService").__testHooks.stopMarketExpiryPollerForTests();clearInterval(require.cache[require.resolve("../src/space/runtime")]?.exports?._tickHandle);await new Promise(r=>setImmediate(r));await database.shutdown("selling-gateway");require("../src/gameStore/sqliteStore").close();await require("../src/utils/rotatingLog").closeAll();store.cleanup();});
test("selling gateway retains token, owner, origin and strict policy protections",async()=>{
  assert.equal((await fetch(base+uri+"?"+identity)).status,401);assert.equal((await fetch(base+uri+"?accountID=2&characterID=90001",{headers})).status,403);
  assert.equal((await fetch(base+uri+"/catalog?"+identity+"&stationID=invalid",{headers})).status,400);
  assert.equal((await post({},{origin:"https://foreign.invalid"})).status,403);assert.equal((await post({},{"content-type":"text/plain"})).status,403);
  assert.equal((await post({commandID:"bad",expectedRevision:0,type:"start",payload:{stationID:60000001,orders:[{typeID:215,reserve:0,batchSize:100,minimumPrice:0}]}})).status,400);
});
test("catalog, sale proceeds, replay and persistent traders cross actual serialized owner IPC",async()=>{
  const catalog=await(await fetch(base+uri+"/catalog?"+identity+"&stationID=60000001",{headers})).json();assert.equal(catalog.products.find(p=>p.typeID===215).bestPrice,2);
  items.grantItemToOwnerLocation(90001,60000001,4,215,200);
  const command={commandID:"start",expectedRevision:0,type:"start",payload:{stationID:60000001,orders:[{typeID:215,reserve:100,batchSize:100,minimumPrice:1}]}};
  const response=await post(command,{origin:base});assert.equal(response.status,200);const data=await response.json();assert.equal(data.selling.netRevenue,184);assert.equal(data.selling.completedSales,1);
  assert.equal((await(await post(command)).json()).replayed,true);
  const universe=(await(await fetch(base+"/_evejs-web/v1/crew/universe?"+identity,{headers})).json()).universe;assert.equal(universe.actors.length,4);assert.equal(universe.recentEvents[0].type,"goods_sold");
});
