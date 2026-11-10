"use strict";
let service;
function getDefaultSellingCrewService(){
  if(!service){const {createTableRepository}=require("../../gameStore/tableRepository");
    service=require("./sellingCrewService").createSellingCrewService({repo:createTableRepository("service:crew-selling"),enabled:require("../../config").crewOperationsEnabled===true,
      market:require("./sellingCrewMarket").createSellingCrewMarket({items:require("../inventory/itemStore"),worldData:require("../../space/worldData"),
        productionTypes:id=>require("./manufacturingCrewRuntime").getDefaultManufacturingCrewService().snapshot(id).manufacturing?.plan?.orders.map(o=>o.recipe.productTypeID)||[]}),
      crew:id=>require("./crewRuntime").getDefaultCrewService().snapshot(id)});}
  return service;
}
async function drainSellingCrews(){if(service)await service.drain();}
module.exports={getDefaultSellingCrewService,drainSellingCrews};
