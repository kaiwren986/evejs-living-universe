"use strict";
// Disposable RPC demand. Native inventory, custody, tax, wallet and settlement
// implementations remain in use; no connection to the player's market daemon.
const net = require("node:net"), fs = require("node:fs");
async function createCrewMarketFixture(filename) {
  let state = fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename)) : { orders: {}, receipts: {} }, dropNextFill = false, rejectNextFill = false, rejectOrderID = null;
  const sockets = new Set();
  const persist = () => fs.writeFileSync(filename, JSON.stringify(state));
  const server = net.createServer(socket => {
    socket.on("error", () => {}); // A crash/reply-loss test deliberately resets connections.
    sockets.add(socket); socket.on("close",()=>sockets.delete(socket)); let buffer="";
    socket.on("data", data => { buffer += data; let at;
      while((at=buffer.indexOf("\n"))>=0){const request=JSON.parse(buffer.slice(0,at));buffer=buffer.slice(at+1);const p=request.params||{};let result,error;
        if(request.method==="Health")result={capabilities:["idempotent-fill-v1"]};
        else if(request.method==="GetOrders")result={buys:Object.values(state.orders).filter(o=>o.type_id===p.type_id&&o.region_id===p.region_id&&o.bid),sells:Object.values(state.orders).filter(o=>o.type_id===p.type_id&&o.region_id===p.region_id&&!o.bid)};
        else if(request.method==="FillOrder"){
          const prior=state.receipts[p.idempotency_key],o=state.orders[String(p.order_id)];
          if(prior){if(prior.order_id!==String(p.order_id)||prior.fill_quantity!==p.fill_quantity)error="idempotency receipt does not match fill request";else result=prior.result;}
          else if(rejectNextFill&&(!rejectOrderID||String(p.order_id)===rejectOrderID)){rejectNextFill=false;error="order has insufficient remaining volume";}
          else if(!o||o.vol_remaining<p.fill_quantity)error="order has insufficient remaining volume";
          else{o.vol_remaining-=p.fill_quantity;result={state:o.vol_remaining?"open":"filled",vol_remaining:o.vol_remaining,price:o.price};state.receipts[p.idempotency_key]={order_id:String(p.order_id),fill_quantity:p.fill_quantity,result};persist();}
          if(dropNextFill&&!error){dropNextFill=false;socket.destroy();continue;}
        }else error=`Unsupported fixture RPC ${request.method}`;
        socket.write(JSON.stringify({id:request.id,ok:!error,...(error?{error}:{result})})+"\n");
      }
    });
  });
  server.listen(0,"127.0.0.1");await new Promise(resolve=>server.once("listening",resolve));
  return{port:server.address().port,add({id,typeID,price,quantity=1000000,stationID=60000001,minVolume=1,bid=true}){
    state.orders[String(id)]={order_id:String(id),bid,source:"seed",type_id:typeID,price,vol_remaining:quantity,vol_entered:quantity,min_volume:minVolume,station_id:stationID,solar_system_id:stationID-60000000,region_id:1,range_value:-1};persist();},
    remaining:id=>state.orders[String(id)]?.vol_remaining,
    resetOrders(){state.orders={};persist();},
    setPrice(id,price){if(!state.orders[String(id)]||!Number.isFinite(price)||price<=0)throw Error("Invalid fixture price");state.orders[String(id)].price=price;persist();},
    setRemaining(id,quantity){if(!state.orders[String(id)]||!Number.isSafeInteger(quantity)||quantity<0)throw Error("Invalid fixture volume");state.orders[String(id)].vol_remaining=quantity;persist();},
    dropNextFill(){dropNextFill=true;},
    rejectNextFill(orderID=null){rejectNextFill=true;rejectOrderID=orderID===null?null:String(orderID);},
    async close(){for(const s of sockets)s.destroy();await new Promise(resolve=>server.close(resolve));}};
}
function seedSellingStatic(store){require("./manufacturingCrewFixture").seedManufacturingStatic(store);
  store.writeStatic("factions", { factions: [] });
  store.writeStatic("stations",{stations:[1,2,3,99].map(id=>({stationID:60000000+id,stationName:`Station ${id}`,solarSystemID:id,regionID:1,reprocessingEfficiency:0.5,reprocessingStationsTake:0.05,corporationID:0}))});}
module.exports={createCrewMarketFixture,seedSellingStatic};
