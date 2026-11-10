"use strict";
const { compareProductionPriority, productionPriority } = require("./productionPriority");

// Read-only forecasts. Mining custody, reprocessing and wallet owners retain
// all authority for extraction, ore consumption, tax and mineral delivery.
function createCrewResourcePlanning({items,worldData,industry,inventory,courierInventory,resources,manufacturing,selling,crew,mining,refining,buying,now=Date.now}){
  industry ||= require("./manufacturingCrewIndustry").createManufacturingCrewIndustry({items,worldData,selling});
  courierInventory ||= require("./crewInventory").createCrewInventory({items});
  const settlements=require("../reprocessing/reprocessingSettlementState"),escrow=require("../market/marketEscrowState");
  const allowedErrors=new Set(["MISSING_MATERIAL","BLUEPRINT_INSTALLED","SLOTS_FULL","ACCOUNT_FUNDS"]);
  const rows=(id,station)=>items.listContainerItems(id,station,4).filter(i=>i.singleton===0&&!i.custodyReservation&&Number.isSafeInteger(i.quantity)&&i.quantity>0);
  const total=(list,type)=>list.filter(i=>i.typeID===type).reduce((n,i)=>n+i.quantity,0);
  const hold=(status,priority=null)=>({status,priority,choice:null});
  function applied(key){const result=items.getIdempotentGrantReceipt(key,{requireDurable:true});if(!result.success)throw Error("Resource custody confirmation pending");return result.found;}
  function quote(id,station,type,quantity){
    try{return inventory.recipe(id,station,type,quantity);}catch(e){if(e.code==="CREW_CARGO_INVALID")return null;throw e;}
  }
  function oreTotals(id,station,refiner,miner){
    const result=new Map();for(const item of rows(id,station))if(item.categoryID===25)result.set(item.typeID,(result.get(item.typeID)||0)+item.quantity);
    const job=refiner?.job;
    if(job?.phase==="reserving"&&!applied(`crew-refine:${job.jobID}:reserve`)){
      result.set(job.cargo.typeID,Math.max(0,(result.get(job.cargo.typeID)||0)-job.cargo.quantity));
    }
    const load=miner?.job;
    if(miner?.plan.homeStationID===station&&load?.cargo&&["returning","unloading"].includes(load.phase)&&
      !applied(`crew-mining:${load.jobID}:unload`))
      result.set(load.cargo.typeID,(result.get(load.cargo.typeID)||0)+load.cargo.quantity);
    if(!refiner.plan.followProduction)for(const type of result.keys())if(type!==refiner.plan.typeID)result.delete(type);
    return result;
  }
  async function context(id,station,stage,current){
    const refiner=stage==="courier"?null:stage==="refining"?current:refining(id)?.refining;
    if(stage!=="courier"&&(!refiner?.plan.enabled||refiner.paused||refiner.plan.stationID!==station))return hold("waiting_for_refinery");
    const factory=manufacturing(id)?.manufacturing;
    if(!factory?.plan?.enabled||factory.paused)return hold("waiting_for_factory");
    const parent=stage==="courier"?current:crew(id)?.crew,route=parent?.standingOrder,direct=station===factory.stationID;
    if(!direct&&(!route?.enabled||route.paused||route.sourceStationID!==station||route.destinationStationID!==factory.stationID))return hold("waiting_for_supply_route");
    const transportable=type=>direct||(route.typeIDs||[route.typeID]).includes(type);
    const factoryItems=rows(id,factory.stationID),sourceItems=direct?[]:rows(id,station),buyer=buying?.(id)?.buying,miner=mining?.(id)?.mining;
    const ore=refiner?oreTotals(id,station,refiner,miner):new Map(),available=new Map();
    const add=(type,quantity)=>{if(transportable(type))available.set(type,(available.get(type)||0)+quantity);};
    const types=new Set([...factoryItems,...sourceItems].filter(i=>i.groupID===18).map(i=>i.typeID));
    for(const type of types)available.set(type,total(factoryItems,type)+(transportable(type)?Math.max(0,total(sourceItems,type)-(direct?0:route.sourceReserve)):0));
    const cargo=parent?.job?.cargo;
    if(cargo&&parent.job.type==="deliver"&&parent.job.destinationStationID===factory.stationID){
      if(!parent.confirmationPending&&parent.job.phase!=="delivering")add(cargo.typeID,cargo.quantity);
      else if(!applied(`crew:${parent.job.jobID}:deliver`))add(cargo.typeID,cargo.quantity);
    }
    const batch=refiner?.job;
    if(batch&&!batch.rejected&&["reserving","working","settling"].includes(batch.phase)&&!settlements.getCrewReprocessingResult(id,batch.jobID,batch.serial))
      for(const output of batch.quote.outputs)add(output.typeID,output.quantity);
    const purchase=buyer?.job;
    if(buyer?.stationID===factory.stationID&&purchase?.phase==="buying"&&escrow.getCrewPurchaseReceipt(id)?.jobID!==purchase.jobID)
      available.set(purchase.summary.typeID,(available.get(purchase.summary.typeID)||0)+purchase.summary.quantity);
    if(stage==="mining")for(const[type,quantity]of [...ore].slice(0,32)){
      const amount=Math.max(0,quantity-refiner.plan.oreReserve),unit=quote(id,station,type);
      if(!unit||amount<unit.portionSize)continue;
      const projected=quote(id,station,type,Math.min(2147483647,amount));
      if(projected)for(const output of projected.outputs)add(output.typeID,output.quantity);
    }
    const assessed=await Promise.all(factory.plan.orders.map(async order=>{
      const incoming=factory.job&&factory.job.summary.productTypeID===order.recipe.productTypeID&&["installing","building","delivering"].includes(factory.job.phase)?factory.job.summary.quantity:0;
      if(total(rows(id,factory.stationID),order.recipe.productTypeID)+incoming>=order.targetStock)return{order,covered:true};
      const result=await industry.assess(id,factory.stationID,order,{incomingQuantity:incoming});
      return{order,result,profit:result.profit,timeSeconds:result.summary?.timeSeconds};
    }));
    const ranked=assessed.filter(r=>r.profit?.allowed&&(!r.result.errors||r.result.errors.every(e=>allowedErrors.has(e.code)))).sort(compareProductionPriority);
    if(!ranked.length)return hold(assessed.every(r=>r.covered)?"production_targets_covered":assessed.find(r=>r.profit&&!r.profit.allowed)?.profit.status||"waiting_for_factory");
    return{factory,refiner,ore,ranked,transportable,available,buyer};
  }
  function needs(ctx,rank){
    return rank.result.summary.materials.map(m=>{
      const rule=ctx.buyer?.stationID===ctx.factory.stationID?ctx.buyer.plan.orders.find(o=>o.typeID===m.typeID):null;
      const target=Math.min(1000000,Math.max(m.quantity,rule?.targetStock||m.quantity*5)),inPipeline=ctx.available.get(m.typeID)||0;
      const priced=rank.profit.materials.find(p=>p.typeID===m.typeID);
      return{typeID:m.typeID,name:items.getItemMetadata(m.typeID)?.name,batchRequirement:m.quantity,target,available:inPipeline,missing:Math.max(0,target-inPipeline),
        unitPrice:priced.replacementCost/priced.quantity,transportable:ctx.transportable(m.typeID)};
    });
  }
  function details(ctx,rank,deficits){return{checkedAtMs:now(),factoryStationID:ctx.factory.stationID,blueprintID:rank.order.blueprintID,
    productTypeID:rank.order.recipe.productTypeID,name:rank.order.recipe.name,...productionPriority(rank),deficits};}
  function useful(q,deficits){
    let coverage=0,value=0;
    for(const need of deficits){if(!need.transportable||!need.missing)continue;const output=q.outputs.find(o=>o.typeID===need.typeID)?.quantity||0;
      const matched=Math.min(need.missing,output);coverage+=matched/need.missing;value+=matched*need.unitPrice;}
    return{coverage,value,tax:q.totalCost};
  }
  function compare(a,b){return Math.abs(a.coverage-b.coverage)>1e-9?b.coverage-a.coverage:a.tax-b.tax||a.volume-b.volume||a.typeID-b.typeID||(a.beltID||0)-(b.beltID||0);}
  function limit(unit,deficits){
    let portions=0;for(const need of deficits)if(need.missing&&need.transportable){const amount=unit.outputs.find(o=>o.typeID===need.typeID)?.quantity||0;if(amount)portions=Math.max(portions,Math.ceil(need.missing/amount));}
    return portions*unit.portionSize;
  }
  async function miningChoice(state,capacity){
    const id=state.ownerID,station=state.plan.homeStationID,ctx=await context(id,station,"mining",state);
    if(ctx.choice===null)return ctx;
    const candidates=resources.sites(station).flatMap(site=>site.ores.filter(o=>(ctx.refiner.plan.followProduction||o.typeID===ctx.refiner.plan.typeID)&&o.remainingQuantity>0&&o.unitVolume>0&&o.unitVolume<=capacity).map(ore=>({...ore,beltID:site.beltID}))).slice(0,128);
    let last=null,hasNeed=false,economic=false;
    for(const rank of ctx.ranked){
      const deficits=needs(ctx,rank);last=details(ctx,rank,deficits);
      if(!deficits.some(n=>n.missing&&n.transportable))continue;hasNeed=true;
      const choices=[];
      for(const ore of candidates){
        const unit=quote(id,station,ore.typeID);if(!unit)continue;
        const wanted=limit(unit,deficits);if(!wanted)continue;
        const carry=Math.max(0,(ctx.ore.get(ore.typeID)||0)-ctx.refiner.plan.oreReserve)%unit.portionSize;
        const quantity=Math.min(2147483647,ore.remainingQuantity,Math.floor(capacity/ore.unitVolume),Math.max(1,wanted-carry));if(quantity<1)continue;
        const full=quantity>=unit.portionSize?quote(id,station,ore.typeID,quantity):null;
        const estimate=full||{totalCost:unit.totalCost*quantity/unit.portionSize,outputs:unit.outputs.map(o=>({...o,quantity:o.quantity*quantity/unit.portionSize}))};
        const score=useful(estimate,deficits);if(!score.coverage)continue;
        if(Math.round(score.value*100)<=Math.round(score.tax*100)){economic=true;continue;}
        choices.push({...ore,quantity,...score,volume:quantity*ore.unitVolume,expectedOutputs:estimate.outputs,expectedTax:estimate.totalCost});
      }
      choices.sort(compare);if(choices.length){const chosen=choices[0];return{status:"ready",choice:chosen,priority:{...last,oreName:chosen.name,oreTypeID:chosen.typeID,beltID:chosen.beltID,quantity:chosen.quantity,expectedTax:chosen.expectedTax}};}
    }
    return hold(hasNeed?(economic?"ore_not_economical":"waiting_for_useful_ore"):"stock_target_met",last);
  }
  async function refiningChoice(state,capacity){
    const id=state.ownerID,station=state.plan.stationID,ctx=await context(id,station,"refining",state);
    if(ctx.choice===null)return ctx;
    const options=inventory.options(id,station),choicesByType=options.slice(0,32);
    let last=null,hasNeed=false,economic=false;
    for(const rank of ctx.ranked){
      const deficits=needs(ctx,rank);last=details(ctx,rank,deficits);
      if(!deficits.some(n=>n.missing&&n.transportable))continue;hasNeed=true;
      const choices=[];
      for(const unit of choicesByType){
        const quantity=limit(unit,deficits);if(!quantity)continue;
        const copy={...state,plan:{...state.plan,typeID:unit.typeID}},selection=inventory.select(copy,capacity,quantity);
        if(!selection)continue;const score=useful(selection.quote,deficits);if(!score.coverage)continue;
        if(Math.round(score.value*100)<=Math.round(score.tax*100)){economic=true;continue;}
        choices.push({typeID:unit.typeID,name:unit.name,recipe:unit,selection,...score,volume:selection.cargo.quantity*(items.getItemMetadata(unit.typeID)?.volume||1)});
      }
      choices.sort(compare);if(choices.length){const chosen=choices[0];return{status:"ready",choice:chosen,priority:{...last,oreName:chosen.name,oreTypeID:chosen.typeID,quantity:chosen.selection.quote.quantityToProcess,expectedTax:chosen.selection.quote.totalCost}};}
    }
    return hold(hasNeed?(economic?"ore_not_economical":"waiting_for_ore"):"stock_target_met",last);
  }
  function factorySupply(id,station){
    const available=new Map();
    for(const item of rows(id,station))available.set(item.typeID,(available.get(item.typeID)||0)+item.quantity);
    const buyer=buying?.(id)?.buying,purchase=buyer?.job;
    if(buyer?.stationID===station&&purchase?.phase==="buying"&&escrow.getCrewPurchaseReceipt(id)?.jobID!==purchase.jobID)
      available.set(purchase.summary.typeID,(available.get(purchase.summary.typeID)||0)+purchase.summary.quantity);
    return available;
  }
  async function courierChoice(state,capacity){
    const id=state.ownerID,route=state.standingOrder,ctx=await context(id,route.sourceStationID,"courier",state);
    if(ctx.choice===null)return ctx;
    // Source minerals and refinery output still need transport. Only factory
    // stock and accepted purchases can cover the destination's hauling gap.
    ctx.available=factorySupply(id,ctx.factory.stationID);
    const types=route.typeIDs||[route.typeID];let last=null,hasNeed=false,hasRoutedNeed=false;
    for(const phase of ["batch","buffer"])for(const rank of ctx.ranked){
      const deficits=needs(ctx,rank);last={...details(ctx,rank,deficits),phase};const choices=[];
      for(const need of deficits){
        const target=phase==="batch"?Math.min(need.target,need.batchRequirement):need.target,missing=Math.max(0,target-need.available);
        if(!missing||items.getItemMetadata(need.typeID)?.groupID!==18)continue;
        hasNeed=true;if(!need.transportable)continue;hasRoutedNeed=true;
        const cargo=courierInventory.selectSupply(id,route.sourceStationID,need.typeID,route.sourceReserve,capacity,missing);
        if(cargo)choices.push({typeID:need.typeID,quantity:cargo.quantity,target,coverage:cargo.quantity/missing,
          position:(types.indexOf(need.typeID)-(route.typeCursor||0)+types.length)%types.length});
      }
      choices.sort((a,b)=>b.coverage-a.coverage||a.position-b.position||a.typeID-b.typeID);
      if(choices.length){const choice=choices[0];return{status:"ready",choice,priority:{...last,runs:rank.order.runs,productTarget:rank.order.targetStock,mineralTypeID:choice.typeID,
        mineralName:items.getItemMetadata(choice.typeID)?.name,quantity:choice.quantity,target:choice.target}};}
    }
    return hold(hasNeed?(hasRoutedNeed?"waiting_for_stock":"waiting_for_supply_route"):"stock_target_met",last);
  }
  function recheckCourier(state,decision){
    try{
      if(!decision.choice)return decision;
      const route=state.standingOrder,factory=manufacturing(state.ownerID)?.manufacturing;
      if(!factory?.plan.enabled||factory.paused||route.destinationStationID!==factory.stationID)return hold("waiting_for_factory");
      const order=factory.plan.orders.find(o=>o.blueprintID===decision.priority.blueprintID);
      if(!order||order.runs!==decision.priority.runs||order.targetStock!==decision.priority.productTarget)return hold("waiting_for_production_plan");
      const incoming=factory.job&&factory.job.summary.productTypeID===order.recipe.productTypeID&&["installing","building","delivering"].includes(factory.job.phase)?factory.job.summary.quantity:0;
      if(total(rows(state.ownerID,factory.stationID),order.recipe.productTypeID)+incoming>=order.targetStock)return hold("waiting_for_production_plan");
      const available=factorySupply(state.ownerID,factory.stationID).get(decision.choice.typeID)||0;
      const need=decision.priority.deficits.find(m=>m.typeID===decision.choice.typeID),buyer=buying?.(state.ownerID)?.buying;
      const rule=buyer?.stationID===factory.stationID?buyer.plan.orders.find(o=>o.typeID===need.typeID):null;
      const workingTarget=Math.min(1000000,Math.max(need.batchRequirement,rule?.targetStock||need.batchRequirement*5));
      const target=Math.min(decision.choice.target,decision.priority.phase==="batch"?Math.min(workingTarget,need.batchRequirement):workingTarget);
      const quantity=Math.min(decision.choice.quantity,Math.max(0,target-available));
      if(!quantity)return hold("waiting_for_production_plan");
      return{...decision,choice:{...decision.choice,quantity},priority:{...decision.priority,quantity}};
    }catch{return hold("resource_plan_unavailable");}
  }
  const safe=fn=>async(...args)=>{try{return await fn(...args);}catch{return hold("resource_plan_unavailable");}};
  async function forecast(id,factoryStationID){
    try{
      const ref=refining(id),refiner=ref?.refining,miner=mining?.(id)?.mining;
      if(!refiner?.plan.enabled||refiner.paused||(!refiner.plan.followProduction&&!miner?.plan.followProduction))return{minerals:{}};
      const station=refiner.plan.stationID,ctx=await context(id,station,"refining",refiner);
      if(ctx.choice===null||ctx.factory.stationID!==factoryStationID)return{minerals:{}};
      const available=new Map(ctx.available);
      for(const rank of ctx.ranked){
        const deficits=needs(ctx,rank),candidates=[];
        for(const[type,held]of [...ctx.ore].slice(0,32)){
          const unit=quote(id,station,type),volume=items.getItemMetadata(type)?.volume;
          if(!unit||!volume)continue;
          const quantity=Math.floor(Math.min(Math.max(0,held-refiner.plan.oreReserve),limit(unit,deficits),Math.floor((ref.settings?.batchM3||1000)/volume))/unit.portionSize)*unit.portionSize;
          if(quantity<unit.portionSize)continue;
          const batch=quote(id,station,type,quantity),score=useful(batch,deficits);
          if(score.coverage&&Math.round(score.value*100)>Math.round(score.tax*100)&&inventory.balance(id)>=batch.totalCost)candidates.push({typeID:type,...score,volume:quantity*volume,batch});
        }
        candidates.sort(compare);
        if(candidates.length){for(const output of candidates[0].batch.outputs)if(ctx.transportable(output.typeID))available.set(output.typeID,(available.get(output.typeID)||0)+output.quantity);break;}
      }
      const actual=rows(id,factoryStationID),minerals={};
      for(const[type,quantity]of available){const incoming=Math.max(0,quantity-total(actual,type));if(incoming>0)minerals[type]=incoming;}
      return{minerals};
    }catch{return{minerals:{},unavailable:true};}
  }
  return{mining:safe(miningChoice),refining:safe(refiningChoice),courier:safe(courierChoice),recheckCourier,forecast};
}
let service;
function getDefaultResourcePlanning(){
  if(!service){
    const items=require("../inventory/itemStore"),worldData=require("../../space/worldData");
    service=createCrewResourcePlanning({items,worldData,
      inventory:require("./refiningCrewInventory").createRefiningCrewInventory({items,worldData}),
      resources:require("./miningCrewResources").createMiningCrewResources({items,worldData,sceneForSystem:id=>require("../../space/runtime").ensureScene(id)}),
      crew:id=>require("./crewRuntime").getDefaultCrewService().snapshot(id),manufacturing:id=>require("./manufacturingCrewRuntime").getDefaultManufacturingCrewService().snapshot(id),
      selling:id=>require("./sellingCrewRuntime").getDefaultSellingCrewService().snapshot(id),mining:id=>require("./miningCrewRuntime").getDefaultMiningCrewService().snapshot(id),
      refining:id=>require("./refiningCrewRuntime").getDefaultRefiningCrewService().snapshot(id),buying:id=>require("./buyingCrewRuntime").getDefaultBuyingCrewService().snapshot(id)});
  }
  return service;
}
module.exports={createCrewResourcePlanning,getDefaultResourcePlanning};
