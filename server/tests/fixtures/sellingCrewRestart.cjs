"use strict";
const assert=require("node:assert/strict");
const database=require("../../src/gameStore"),items=require("../../src/services/inventory/itemStore"),worldData=require("../../src/space/worldData");
const [phase,fault,port]=process.argv.slice(2),{createTableRepository}=require("../../src/gameStore/tableRepository");
const {marketDaemonClient}=require("../../src/services/market/marketDaemonClient");marketDaemonClient.port=Number(port);
const courier=require("../../src/services/crew/crewService").createCrewService({repo:createTableRepository("service:crew"),inventory:require("../../src/services/crew/crewInventory").createCrewInventory({items}),world:require("../../src/services/crew/crewRuntime").createCrewWorld(worldData),character:id=>database.read("characters",`/${id}`).data});
const market=require("../../src/services/crew/sellingCrewMarket").createSellingCrewMarket({items,worldData}),wallet=require("../../src/services/account/walletState");
const custody=require("../../src/services/inventory/marketItemCustody");
let armed=false;
if(phase==="fail"){
  if(fault==="reserve"||fault==="consume"){const method=fault==="reserve"?"reserveSeedItem":"consumeSeedItem",original=custody[method];custody[method]=(...args)=>{const r=original(...args);if(r.success)process.exit(70);return r;};}
  const original=marketDaemonClient.call.bind(marketDaemonClient);
  marketDaemonClient.call=async(...args)=>{const r=await original(...args);if(args[0]==="FillOrder"){armed=true;if(fault==="daemon")process.exit(70);}return r;};
  if(fault==="credit"||fault==="tax"){const flush=database.flushTableSync;database.flushTableSync=(table,...args)=>{const r=flush(table,...args);if(armed&&table==="characters"&&r.success&&wallet.getCharacterWallet(90001)?.balance===(fault==="credit"?100200:100184))process.exit(70);return r;};}
  if(fault==="completion"){const settle=market.settle;market.settle=async job=>{const result=await settle(job);process.exit(70);return result;};}
  if(fault==="ack"){const ack=market.acknowledge;market.acknowledge=job=>{ack(job);process.exit(70);};}
}
const service=require("../../src/services/crew/sellingCrewService").createSellingCrewService({repo:createTableRepository("service:crew-selling"),market,crew:id=>courier.snapshot(id),now:()=>10000});
async function main(){
  if(phase==="fail"){
    require("../helpers/manufacturingCrewFixture").fundManufacturingPilot(database,items);items.grantItemToOwnerLocation(90001,60000001,4,215,200);
    courier.submit(90001,{commandID:"crew",expectedRevision:0,type:"create",payload:{name:"Persistent traders"}});
    await service.submit(90001,{commandID:"sell",expectedRevision:0,type:"start",payload:{stationID:60000001,orders:[{typeID:215,reserve:100,batchSize:100,minimumPrice:1}]}});
    throw Error(`Fault ${fault} was not reached`);
  }
  assert.deepEqual((await service.tick({budgetMs:1000})).errors,[]);
  const s=service.snapshot(90001).selling;assert.equal(s.completedSales,1);assert.equal(s.netRevenue,184);assert.equal(s.job,null);
  assert.equal(s.skill.xp,10,"A recovered sale must award experience exactly once");
  assert.equal(wallet.getCharacterWallet(90001).balance,100184);assert.equal(items.listContainerItems(90001,60000001,4).filter(i=>i.typeID===215).reduce((a,i)=>a+i.quantity,0),100);
  assert.equal(require("../../src/services/market/marketEscrowState").getCrewSaleReceipt(90001).custodyKeys,undefined);
  await service.drain();clearInterval(require.cache[require.resolve("../../src/space/runtime")]?.exports?._tickHandle);
  await new Promise(r=>setImmediate(r));assert.equal((await database.shutdown("selling-restart")).success,true);
}
main().catch(e=>{console.error(e);process.exitCode=1;});
