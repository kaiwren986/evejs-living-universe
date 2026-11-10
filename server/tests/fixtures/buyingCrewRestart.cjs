"use strict";
const assert=require("node:assert/strict");
const [phase,fault,port]=process.argv.slice(2);
const world=require("../helpers/buyingCrewFixture").createBuyingWorld({now:()=>10000});
const {database,items,buyers,market,make,command,establish}=world;
const wallet=require("../../src/services/account/walletState"),{marketDaemonClient}=require("../../src/services/market/marketDaemonClient");
marketDaemonClient.port=Number(port);
const custody=require("../../src/services/inventory/marketItemCustody");let armed=false;
if(phase==="fail"){
  const call=marketDaemonClient.call.bind(marketDaemonClient);
  marketDaemonClient.call=async(...args)=>{try{const r=await call(...args);if(args[0]==="FillOrder"&&armed&&fault==="daemon")process.exit(70);return r;}finally{if(args[0]==="FillOrder"&&armed)armed=true;}};
  if(fault==="debit"||fault==="refund"){
    const flush=database.flushTableSync;
    database.flushTableSync=(table,...args)=>{const result=flush(table,...args);if(armed&&table==="characters"&&result.success&&wallet.getCharacterWallet(90001)?.balance===(fault==="debit"?100050:100092))process.exit(70);return result;};
  }
  if(fault==="delivery"){const grant=custody.grantSeedItem;custody.grantSeedItem=(...args)=>{const r=grant(...args);if(armed&&r.success)process.exit(70);return r;};}
  if(fault==="completion"){const settle=market.settle;market.settle=async job=>{const r=await settle(job);process.exit(70);return r;};}
  if(fault==="ack"){const ack=market.acknowledge;market.acknowledge=job=>{ack(job);process.exit(70);};}
}
const runtime=make({market});
async function main(){
  if(phase==="fail"){
    await establish(90001);armed=true;
    await runtime.submit(90001,command(runtime,90001,"start",{stationID:60000001,walletReserve:100050,budgetISK:100,orders:[{typeID:35,targetStock:21,batchSize:21,maximumPrice:2}]}));
    throw Error(`Fault ${fault} was not reached`);
  }
  if(["delivery","completion","ack"].includes(fault)){
    const item=items.listContainerItems(90001,60000001,4).find(i=>i.typeID===35);
    if(item){items.moveItemToLocation(item.itemID,60000003,4);database.flushTableSync("items");}
  }
  assert.deepEqual((await runtime.tick({budgetMs:1000})).errors,[]);
  const s=runtime.snapshot(90001).buying;
  assert.equal(s.job,null);assert.equal(s.completedPurchases,fault==="refund"?0:1);assert.equal(s.totalSpent,fault==="refund"?0:42);
  assert.equal(s.skill.xp,fault==="refund"?0:10,"Refunds earn no experience and recovered purchases earn it once");
  assert.equal(wallet.getCharacterWallet(90001).balance,fault==="refund"?100092:100050);
  const quantity=[60000001,60000003].flatMap(station=>items.listContainerItems(90001,station,4)).filter(i=>i.typeID===35).reduce((sum,i)=>sum+i.quantity,0);
  assert.equal(quantity,fault==="refund"?0:21);assert.equal(require("../../src/services/market/marketEscrowState").getCrewPurchaseReceipt(90001).custodyKey,undefined);
  await runtime.drain();clearInterval(require.cache[require.resolve("../../src/space/runtime")]?.exports?._tickHandle);await new Promise(r=>setImmediate(r));assert.equal((await database.shutdown("buying-restart")).success,true);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
