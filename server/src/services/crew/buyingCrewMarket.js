"use strict";
const { CrewError } = require("./crewService");
const { compareProductionPriority, productionPriority } = require("./productionPriority");
function createBuyingCrewMarket({items,worldData,manufacturing,selling,profitability,projectedSupply}) {
  const native=require("../market/marketProxyService"),escrow=require("../market/marketEscrowState");
  const {marketDaemonClient}=require("../market/marketDaemonClient");
  const industry=require("../industry/industryRuntimeState"),staticData=require("../industry/industryStaticData");
  const {INDUSTRY_ERROR}=require("../industry/industryConstants");
  const temporaryErrors=new Set([INDUSTRY_ERROR.MISSING_MATERIAL,INDUSTRY_ERROR.BLUEPRINT_INSTALLED,INDUSTRY_ERROR.SLOTS_FULL]);
  profitability ||= require("./crewProfitability").createCrewProfitability({worldData,selling});
  function stock(id,stationID,typeID){return items.listContainerItems(id,stationID,4).filter(i=>i.typeID===typeID&&i.singleton===0&&!i.custodyReservation).reduce((sum,i)=>sum+i.quantity,0);}
  function rawRequirements(id,stationID,{includeSatisfied=false}={}){
    const factory=manufacturing(id)?.manufacturing;
    if(!factory?.plan?.enabled||factory.paused||factory.stationID!==stationID)return{active:false,minerals:[],recipes:[]};
    const minerals=new Map(),recipes=[];let covered=0;
    for(const order of factory.plan.orders){
      const incomingQuantity=factory.job&&factory.job.summary.productTypeID===order.recipe.productTypeID&&["installing","building","delivering"].includes(factory.job.phase)?factory.job.summary.quantity:0;
      if(!includeSatisfied&&items.listContainerItems(id,stationID,4).filter(i=>i.typeID===order.recipe.productTypeID&&!i.custodyReservation).reduce((n,i)=>n+Math.max(0,i.quantity),0)+incomingQuantity>=order.targetStock){covered++;continue;}
      // Use current blueprint research and run sizes, including an installed BPO.
      const item=items.findItemById(order.blueprintID),state=industry.getBlueprintState(order.blueprintID);
      if(!item||item.ownerID!==id||(!state?.original&&!(state?.runsRemaining>=order.runs)))continue;
      if(industry.getBlueprintByItemID(order.blueprintID)?.facilityID!==stationID)continue;
      const definition=staticData.getBlueprintDefinitionByTypeID(item.typeID);
      if(!definition?.activities?.manufacturing||definition.activities.manufacturing.products?.length!==1||definition.activities.manufacturing.products[0].typeID!==definition.productTypeID)continue;
      const location={itemID:stationID,ownerID:id,flagID:4};
      const quote=industry.quoteManufacturingJob(industry.createCrewIndustryActor(id,stationID),{
          blueprintID:order.blueprintID,activityID:1,facilityID:stationID,runs:order.runs,inputLocation:location,outputLocation:location,
      });
      if(!includeSatisfied&&!quote.success&&(!quote.errors?.length||quote.errors.some(e=>!temporaryErrors.has(e.code))))continue;
      const materials=industry.buildManufacturingMaterials(definition,order.runs,state?.materialEfficiency||0);
      recipes.push({blueprintID:order.blueprintID,targetStock:order.targetStock,productTypeID:definition.productTypeID,name:definition.productName,
        quantity:definition.activities.manufacturing.products.reduce((n,p)=>n+p.quantity,0)*order.runs,materials,cost:quote.quote?.totalCost,timeSeconds:quote.quote?.timeInSeconds,incomingQuantity});
      for(const m of materials){
        const meta=items.getItemMetadata(m.typeID);if(meta?.groupID!==18)continue;
        const prior=minerals.get(m.typeID)||{typeID:m.typeID,name:meta.name,batchRequirement:0};prior.batchRequirement+=m.quantity;minerals.set(m.typeID,prior);
      }
    }
    return{active:minerals.size>0,minerals:[...minerals.values()],recipes,status:covered===factory.plan.orders.length?"production_targets_covered":"waiting_for_factory"};
  }
  async function requirements(id,stationID,{minimumMaterialPrice={},onlyTypeID,buyingOrders,projectedMinerals={},allowance,walletBalance}={}){
    const raw=rawRequirements(id,stationID);
    const recipes=raw.recipes.filter(r=>!onlyTypeID||r.materials.some(m=>m.typeID===onlyTypeID));
    const profit=await Promise.all(recipes.map(async recipe=>({blueprintID:recipe.blueprintID,
      ...await profitability.evaluate(id,stationID,recipe,recipe.cost,{targetStock:recipe.targetStock,minimumMaterialPrice,incomingQuantity:recipe.incomingQuantity})})));
    const ranked=recipes.map((recipe,index)=>({recipe,profit:profit[index],timeSeconds:recipe.timeSeconds})).filter(r=>r.profit.allowed).sort(compareProductionPriority);
    const supported=r=>!buyingOrders||r.recipe.materials.some(m=>buyingOrders.some(o=>o.typeID===m.typeID));
    const books=new Map(),fundability=new Map();
    async function fundBatch(row){
      let cost=0;
      for(const material of row.recipe.materials){
        let missing=Math.max(0,material.quantity-stock(id,stationID,material.typeID)-(projectedMinerals[material.typeID]||0));
        if(!missing)continue;
        const rule=buyingOrders.find(o=>o.typeID===material.typeID);
        if(!rule)return{allowed:false,status:"waiting_for_local_supply"};
        if(!books.has(material.typeID))books.set(material.typeID,marketDaemonClient.call("GetOrders",{region_id:worldData.getStationByID(stationID).regionID,type_id:material.typeID}));
        const book=await books.get(material.typeID);
        const asks=(book?.sells||[]).filter(o=>o.source==="seed"&&o.bid===false&&Number(o.station_id)===stationID&&Number(o.type_id)===material.typeID&&
          Number.isSafeInteger(o.vol_remaining)&&o.vol_remaining>0&&o.price>=0.01&&Math.abs(o.price*100-Math.round(o.price*100))<0.0001&&o.price<=rule.maximumPrice&&!native.isCrewQuoteOrderPending(o.order_id))
          .sort((a,b)=>a.price-b.price||String(a.order_id).localeCompare(String(b.order_id))).slice(0,256);
        for(const ask of asks){
          const minimum=Math.min(ask.min_volume||1,ask.vol_remaining);if(rule.batchSize<minimum)continue;
          const available=Math.min(missing,ask.vol_remaining),full=Math.floor(available/rule.batchSize),tail=available%rule.batchSize;
          const take=full*rule.batchSize+(tail>=Math.min(ask.min_volume||1,ask.vol_remaining-full*rule.batchSize)?tail:0);
          cost+=take*Math.round(ask.price*100);missing-=take;if(!missing)break;
        }
        if(missing)return{allowed:false,status:"waiting_for_sellers"};
      }
      const allowed=Number.isSafeInteger(cost)&&cost<=Math.round(allowance*100)&&(!Number.isFinite(walletBalance)||cost+Math.round(row.recipe.cost*100)<=Math.round(walletBalance*100));
      return{allowed,status:allowed?"funded":"budget_too_small",cost:cost/100};
    }
    if(buyingOrders&&Number.isFinite(allowance))for(const row of ranked.filter(supported)){
      try{fundability.set(row.recipe.blueprintID,await fundBatch(row));}catch{fundability.set(row.recipe.blueprintID,{allowed:false,status:"market_unavailable"});}
    }
    const feasible=ranked.filter(r=>supported(r)&&fundability.get(r.recipe.blueprintID)?.allowed!==false);
    const priority=feasible.find(r=>r.recipe.materials.some(m=>{
      const rule=buyingOrders?.find(o=>o.typeID===m.typeID);
      // An incoming top-priority batch should finish arriving before we fund
      // another recipe; its remaining raw ore may supply that recipe next.
      return(!buyingOrders||rule)&&stock(id,stationID,m.typeID)<Math.min(m.quantity,rule?.targetStock??m.quantity);
    }))||feasible[0]||ranked.find(supported);
    const blocked=priority&&fundability.get(priority.recipe.blueprintID)?.allowed===false;
    const minerals=(priority?.recipe.materials||[]).map(m=>({typeID:m.typeID,name:items.getItemMetadata(m.typeID)?.name,batchRequirement:m.quantity}));
    return{active:minerals.length>0,minerals,profit,blocked:Boolean(blocked),status:blocked?fundability.get(priority.recipe.blueprintID).status:profit.find(p=>!p.allowed)?.status||raw.status||"waiting_for_factory",
      priority:priority?{blueprintID:priority.recipe.blueprintID,productTypeID:priority.recipe.productTypeID,name:priority.recipe.name,...productionPriority(priority)}:null,
      ranking:ranked.map(r=>({blueprintID:r.recipe.blueprintID,productTypeID:r.recipe.productTypeID,name:r.recipe.name,...productionPriority(r)}))};
  }
  function describe(id,stationID,typeID){
    const m=rawRequirements(id,stationID,{includeSatisfied:true}).minerals.find(m=>m.typeID===typeID);
    if(!m)throw new CrewError("CREW_CARGO_INVALID","Choose minerals used by the active manufacturing queue at this station.",400);return m;
  }
  return{station:id=>worldData.getStationByID(id),stock,requirements,describe,projectedSupply,
    funds(id){return{salesIncome:selling(id)?.selling?.netRevenue||0,equipmentCommitted:require("./crewEquipmentState").committed(id),walletBalance:require("../account/walletState").getCharacterWallet(id)?.balance||0};},
    async catalog(id,stationID){
      const station=worldData.getStationByID(stationID);if(!station)throw new CrewError("CREW_STATION_INVALID","Choose an NPC factory station.",400);
      const needed=rawRequirements(id,stationID,{includeSatisfied:true});
      const minerals=await Promise.all(needed.minerals.map(async m=>{const book=await marketDaemonClient.call("GetOrders",{region_id:station.regionID,type_id:m.typeID});
        const asks=(book?.sells||[]).filter(o=>o.source==="seed"&&o.bid===false&&Number(o.station_id)===stationID&&o.price>0&&o.vol_remaining>0).sort((a,b)=>a.price-b.price);
        return{...m,stock:stock(id,stationID,m.typeID),bestPrice:asks[0]?.price||null,supply:asks.reduce((sum,o)=>sum+o.vol_remaining,0)};}));
      const profit=await Promise.all(needed.recipes.map(async r=>({blueprintID:r.blueprintID,...await profitability.evaluate(id,stationID,r,r.cost,{targetStock:r.targetStock})})));
      return{active:needed.active,minerals,profit};
    },
    async prepare(id,stationID,order,tag,limits){
      const result=await native.prepareCrewPurchase(id,stationID,order,tag,limits);
      if(!result.ready)return result;
      const needed=await requirements(id,stationID,{onlyTypeID:order.typeID,minimumMaterialPrice:{[order.typeID]:result.summary.unitPrice}});
      if(!needed.active)return{ready:false,status:needed.status,profit:needed.profit};
      result.summary.profit=needed.profit;return result;
    },
    async settle(job){
      const saga=job.saga;
      if(!escrow.getEscrowRecord(saga.anchorOrderID)&&escrow.getCrewPurchaseReceipt(saga.buyerCharacterID)?.jobID!==saga.crewPurchase.jobID){
        const needed=await requirements(saga.buyerCharacterID,saga.destinationStationID,{onlyTypeID:saga.typeID,minimumMaterialPrice:{[saga.typeID]:saga.orderPrice}});
        if(!needed.active)return{deferred:true,status:needed.status,profit:needed.profit};
      }
      return native.settleCrewPurchase(saga);
    },
    acknowledge(job){if(!escrow.acknowledgeCrewPurchase(job.saga.buyerCharacterID,job.saga.crewPurchase).success)throw new CrewError("CREW_CUSTODY_PENDING","Purchase confirmation is pending. The saved purchase will retry.",503);},
  };
}
module.exports={createBuyingCrewMarket};
