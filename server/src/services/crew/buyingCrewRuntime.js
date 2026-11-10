"use strict";
let service;
function getDefaultBuyingCrewService(){
  if(!service){
    service=require("./buyingCrewService").createBuyingCrewService({repo:require("../../gameStore/tableRepository").createTableRepository("service:crew-buying"),enabled:require("../../config").crewOperationsEnabled===true,
      market:require("./buyingCrewMarket").createBuyingCrewMarket({items:require("../inventory/itemStore"),worldData:require("../../space/worldData"),
        manufacturing:id=>require("./manufacturingCrewRuntime").getDefaultManufacturingCrewService().snapshot(id),selling:id=>require("./sellingCrewRuntime").getDefaultSellingCrewService().snapshot(id),
        projectedSupply:(id,station)=>require("./crewResourcePlanning").getDefaultResourcePlanning().forecast(id,station)}),
      crew:id=>require("./crewRuntime").getDefaultCrewService().snapshot(id)});
  }
  return service;
}
async function drainBuyingCrews(){if(service)await service.drain();}
module.exports={getDefaultBuyingCrewService,drainBuyingCrews};
