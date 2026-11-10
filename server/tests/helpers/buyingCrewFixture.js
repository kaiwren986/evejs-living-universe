"use strict";
function createBuyingWorld({now=Date.now}={}){
  const database=require("../../src/gameStore"),items=require("../../src/services/inventory/itemStore"),worldData=require("../../src/space/worldData");
  const {createTableRepository}=require("../../src/gameStore/tableRepository");
  const courier=require("../../src/services/crew/crewService").createCrewService({repo:createTableRepository("service:crew"),inventory:require("../../src/services/crew/crewInventory").createCrewInventory({items}),world:require("../../src/services/crew/crewRuntime").createCrewWorld(worldData),character:id=>database.read("characters",`/${id}`).data,now});
  const profitability=require("./nativeIndustryProfitFixture");
  const factory=require("../../src/services/crew/manufacturingCrewService").createManufacturingCrewService({repo:createTableRepository("service:crew-manufacturing"),industry:require("../../src/services/crew/manufacturingCrewIndustry").createManufacturingCrewIndustry({items,worldData,profitability}),crew:id=>courier.snapshot(id),now});
  const sellers=require("../../src/services/crew/sellingCrewService").createSellingCrewService({repo:createTableRepository("service:crew-selling"),market:require("../../src/services/crew/sellingCrewMarket").createSellingCrewMarket({items,worldData,productionTypes:()=>[215,21857]}),crew:id=>courier.snapshot(id),now});
  const market=require("../../src/services/crew/buyingCrewMarket").createBuyingCrewMarket({items,worldData,profitability,manufacturing:id=>factory.snapshot(id),selling:id=>sellers.snapshot(id)});
  const make=overrides=>require("../../src/services/crew/buyingCrewService").createBuyingCrewService({repo:createTableRepository("service:crew-buying"),market,crew:id=>courier.snapshot(id),now,...overrides});
  const buyers=make();let serial=0;
  const command=(service,id,type,payload={})=>({commandID:`buy-fixture:${++serial}`,expectedRevision:service.snapshot(id).revision,type,payload});
  async function establish(id,{incomeUnits=1,balance=100000,startFactory=true}={}){
    require("./manufacturingCrewFixture").fundManufacturingPilot(database,items,id,balance);
    courier.submit(id,command(courier,id,"create",{name:"Supply and trade"}));
    await factory.submit(id,command(factory,id,"starter",{stationID:60000001}));
    const blueprint=factory.catalog(id,60000001).find(b=>b.productTypeID===215);
    if(startFactory)await factory.submit(id,command(factory,id,"start",{stationID:60000001,orders:[{blueprintID:blueprint.blueprintID,runs:1,targetStock:100}]}));
    if(incomeUnits)items.grantItemToOwnerLocation(id,60000001,4,21857,incomeUnits);
    await sellers.submit(id,command(sellers,id,"start",{stationID:60000001,orders:[{typeID:21857,reserve:0,batchSize:1000,minimumPrice:1}]}));
    return blueprint;
  }
  return{database,items,worldData,courier,factory,sellers,buyers,market,make,command,establish};
}
module.exports={createBuyingWorld};
