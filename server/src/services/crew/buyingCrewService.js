"use strict";
const {createHash}=require("node:crypto"), {performance}=require("node:perf_hooks");
const {CrewError}=require("./crewService");
const progression=require("./crewProgression");
const TABLE="buyingCrewRuntime", clone=value=>JSON.parse(JSON.stringify(value));
const hash=value=>createHash("sha256").update(value).digest("hex");
const positive=n=>Number.isSafeInteger(n)&&n>0;
const money=n=>Number.isFinite(n)&&n>=0&&n<=1000000000000&&Math.abs(n*100-Math.round(n*100))<0.0001;
const round=n=>Math.round(n*100)/100;
const exact=(o,keys)=>o&&typeof o==="object"&&!Array.isArray(o)&&Object.keys(o).sort().join()===[...keys].sort().join();
const fail=(code,message,status=409)=>{throw new CrewError(code,message,status);};
function validOrder(o){
  return exact(o,["typeID","targetStock","batchSize","maximumPrice"])&&positive(o.typeID)&&positive(o.targetStock)&&o.targetStock<=1000000&&positive(o.batchSize)&&o.batchSize<=100000&&money(o.maximumPrice)&&o.maximumPrice>=0.01&&o.maximumPrice<=100000000;
}
function normalize(c){
  if(!exact(c,["commandID","expectedRevision","type","payload"])||typeof c.commandID!=="string"||!/^[A-Za-z0-9._:-]{1,128}$/.test(c.commandID)||!Number.isSafeInteger(c.expectedRevision)||c.expectedRevision<0||!["start","pause","resume","stop"].includes(c.type))fail("CREW_COMMAND_INVALID","The buying order is invalid.",400);
  if(c.type==="start"){
    const p=c.payload;
    if(!exact(p,["stationID","walletReserve","budgetISK","orders"])||!positive(p.stationID)||!money(p.walletReserve)||!money(p.budgetISK)||p.budgetISK<0.01||p.budgetISK>1000000000||!Array.isArray(p.orders)||!p.orders.length||p.orders.length>8||p.orders.some(o=>!validOrder(o))||new Set(p.orders.map(o=>o.typeID)).size!==p.orders.length)
      fail("CREW_COMMAND_INVALID","Choose up to eight production minerals, stock targets, price ceilings, a wallet reserve and a positive spending cap.",400);
  }else if(!exact(c.payload,[]))fail("CREW_COMMAND_INVALID","This order takes no options.",400);
  return{...clone(c),fingerprint:hash(JSON.stringify(c))};
}
function createBuyingCrewService({repo,market,crew,enabled=true,now=Date.now}){
  let initialized=false,cursor=0,ticking=false;
  const active=new Set(),lanes=new Map();
  function validate(s,id){
    progression.validate(s?.progression);
    if(!s||s.version!==1||s.ownerID!==id||!positive(id)||!Number.isSafeInteger(s.revision)||s.revision<0||!positive(s.nextSerial)||!market.station(s.stationID)||typeof s.paused!=="boolean"||
      !s.plan||typeof s.plan.enabled!=="boolean"||!money(s.plan.walletReserve)||!money(s.plan.budgetISK)||!money(s.plan.spent)||s.plan.spent>s.plan.budgetISK||!Array.isArray(s.plan.orders)||!s.plan.orders.length||s.plan.orders.length>8||s.plan.orders.some(o=>!validOrder(o))||!Number.isSafeInteger(s.plan.cursor)||s.plan.cursor<0||s.plan.cursor>=s.plan.orders.length||
      !Array.isArray(s.roster)||s.roster.length!==2||s.roster.some((p,i)=>p.actorID!==`buying:${id}:member:${i}`)||!s.receipts||Object.keys(s.receipts).length>1024||!Array.isArray(s.history)||s.history.length>20||!Number.isSafeInteger(s.completedPurchases)||s.completedPurchases<0||!money(s.totalSpent)||!s.purchased||Object.values(s.purchased).some(n=>!Number.isSafeInteger(n)||n<0))fail("CREW_STATE_INVALID","The saved buying crew needs recovery.",503);
    if(s.job&&(!/^[a-f0-9]{64}$/.test(s.job.jobID)||!positive(s.job.serial)||s.job.serial>=s.nextSerial||!["buying","acknowledging"].includes(s.job.phase)||s.job.saga?.buyerCharacterID!==id||s.job.saga.crewPurchase?.jobID!==s.job.jobID||s.job.saga.crewPurchase?.serial!==s.job.serial||s.job.saga.destinationStationID!==s.stationID||!positive(s.job.summary?.quantity)||!positive(s.job.summary?.typeID)||!money(s.job.summary?.cost)||s.job.summary.cost<0.01||
      (s.job.cooldownMs!==undefined&&(!Number.isSafeInteger(s.job.cooldownMs)||s.job.cooldownMs<2500||s.job.cooldownMs>5000))))fail("CREW_STATE_INVALID","The saved mineral purchase needs recovery.",503);
  }
  function check(){
    if(!enabled)fail("CREW_DISABLED","Crew buying is disabled.",503);
    if(!initialized){
      repo.ensureTable(TABLE);const root=repo.read(TABLE,"/");
      if(!root.success||!root.data||Array.isArray(root.data)||Object.keys(root.data).length>128)fail("CREW_STORE_UNAVAILABLE","Buying records are unavailable.",503);
      for(const[id,s]of Object.entries(root.data)){validate(s,Number(id));if(s.job||s.plan.enabled)active.add(Number(id));}
      initialized=true;
    }
    if(repo.flushTableSync(TABLE)?.success!==true)fail("CREW_STORE_UNAVAILABLE","Buying records are pending. Retry the same order.",503);
  }
  function load(id){
    if(!positive(id))fail("CREW_OWNER_INVALID","Select a valid pilot.",400);
    const result=repo.read(TABLE,`/${id}`);
    if(!result.success){if(result.errorMsg==="ENTRY_NOT_FOUND")return null;fail("CREW_STORE_UNAVAILABLE","Buying records are unavailable.",503);}
    validate(result.data,id);const s=clone(result.data);progression.ensure(s,"buying");return s;
  }
  function save(s){
    progression.ensure(s,"buying");
    validate(s,s.ownerID);s.revision++;
    if(repo.write(TABLE,`/${s.ownerID}`,clone(s))?.success!==true)fail("CREW_STORE_UNAVAILABLE","Buying records are pending.",503);
    if(s.job||s.plan.enabled)active.add(s.ownerID);else active.delete(s.ownerID);
    if(repo.flushTableSync(TABLE)?.success!==true)fail("CREW_STORE_UNAVAILABLE","Buying records are pending. Retry the same order.",503);
  }
  function run(id,action){
    const promise=(lanes.get(id)||Promise.resolve()).catch(()=>{}).then(action);lanes.set(id,promise);
    void promise.finally(()=>{if(lanes.get(id)===promise)lanes.delete(id);}).catch(()=>{});return promise;
  }
  function funding(s){
    const f=market.funds(s.ownerID);
    return{...f,salesAvailable:Math.max(0,round(f.salesIncome-s.totalSpent-(f.equipmentCommitted||0))),policyRemaining:Math.max(0,round(s.plan.budgetISK-s.plan.spent)),walletAvailable:Math.max(0,round(f.walletBalance-s.plan.walletReserve))};
  }
  async function progress(s,at){
    if(!s)return;
    if(!s.job){
      if(!s.plan.enabled||s.paused||at<s.nextCheckAtMs)return;
      const funds=funding(s),projected=await market.projectedSupply?.(s.ownerID,s.stationID)||{minerals:{}};s.projectedSupply=projected.minerals;
      const needed=await market.requirements(s.ownerID,s.stationID,{buyingOrders:s.plan.orders,...(market.projectedSupply?{
        projectedMinerals:projected.minerals,allowance:Math.min(funds.salesAvailable,funds.policyRemaining,funds.walletAvailable),walletBalance:funds.walletBalance}: {})});
      s.profit=needed.profit;
      s.priority=needed.priority;s.ranking=needed.ranking;
      let reason=!needed.active?needed.status||"waiting_for_factory":funds.policyRemaining<0.01?"budget_exhausted":funds.salesAvailable<0.01?"waiting_for_income":funds.walletAvailable<0.01?"wallet_reserve":needed.blocked?needed.status:null;
      if(reason){if(needed.blocked)s.availability=needed.minerals.map(m=>({typeID:m.typeID,status:reason,stock:market.stock(s.ownerID,s.stationID,m.typeID)}));s.status=reason;s.nextCheckAtMs=at+progression.duration(10000,s,"buying");save(s);return;}
      if(projected.unavailable){s.status="resource_plan_unavailable";s.nextCheckAtMs=at+progression.duration(10000,s,"buying");save(s);return;}
      const availability=[];
      const candidates=s.plan.orders.map((order,offset)=>{
        const index=(s.plan.cursor+offset)%s.plan.orders.length,rule=s.plan.orders[index];
        const required=needed.minerals.find(m=>m.typeID===rule.typeID);
        const incoming=projected.minerals[rule.typeID]||0;
        return{index,order:{...rule,targetStock:Math.max(0,rule.targetStock-incoming)},shortfall:required?Math.max(0,required.batchRequirement-market.stock(s.ownerID,s.stationID,rule.typeID)-incoming):0,incoming};
      });
      const shortages=candidates.filter(c=>c.shortfall>0&&market.stock(s.ownerID,s.stationID,c.order.typeID)<c.order.targetStock);
      // Do not spend the last sale proceeds topping up a buffer while another
      // mineral prevents a batch. First fund one batch, then rebuild buffers.
      for(const candidate of shortages.length?shortages:candidates){
        const{index}=candidate;
        const order=shortages.length?{...candidate.order,targetStock:Math.min(candidate.order.targetStock,market.stock(s.ownerID,s.stationID,candidate.order.typeID)+candidate.shortfall)}:candidate.order;
        if(!needed.minerals.some(m=>m.typeID===order.typeID)){availability.push({typeID:order.typeID,status:"not_required",stock:market.stock(s.ownerID,s.stationID,order.typeID)});continue;}
        if(candidate.incoming&&market.stock(s.ownerID,s.stationID,order.typeID)>=order.targetStock){
          const stock=market.stock(s.ownerID,s.stationID,order.typeID);
          availability.push({typeID:order.typeID,status:stock>=s.plan.orders[index].targetStock?"stock_target_met":"waiting_for_local_supply",incoming:candidate.incoming,stock});continue;
        }
        const serial=s.nextSerial,jobID=hash(`buying:${s.ownerID}:${serial}`);
        const result=await market.prepare(s.ownerID,s.stationID,order,{jobID,serial},{walletReserve:s.plan.walletReserve,allowance:Math.min(funds.salesAvailable,funds.policyRemaining,funds.walletAvailable)});
        if(!result.ready){availability.push({typeID:order.typeID,status:result.status,profit:result.profit,stock:market.stock(s.ownerID,s.stationID,order.typeID)});continue;}
        // Reinvestment may have reserved profits while the market quote awaited
        // RPC. Refresh before publishing a purchase intent; no native effect yet.
        const refreshed=funding(s);
        if(result.summary.cost>Math.min(refreshed.salesAvailable,refreshed.policyRemaining)){
          availability.push({typeID:order.typeID,status:"waiting_for_income",stock:market.stock(s.ownerID,s.stationID,order.typeID)});continue;
        }
        s.job={jobID,serial,phase:"buying",saga:result.saga,summary:result.summary,skillAtStart:progression.profile(s,"buying"),cooldownMs:progression.duration(5000,s,"buying")};s.nextSerial++;s.plan.cursor=(index+1)%s.plan.orders.length;s.status="buying";s.availability=availability;save(s);break;
      }
      if(!s.job){s.availability=availability;s.status=availability.every(a=>["stock_target_met","not_required"].includes(a.status))?"stock_target_met":availability.find(a=>!["stock_target_met","not_required"].includes(a.status))?.status||"waiting_for_factory";s.nextCheckAtMs=at+progression.duration(10000,s,"buying");save(s);return;}
    }
    const job=s.job;
    if(job.phase==="buying"){
      const result=await market.settle(job);
      if(result.deferred){s.job=null;s.profit=result.profit;s.status=result.status;s.nextCheckAtMs=at+progression.duration(10000,s,"buying");save(s);return;}
      job.result=result;
      if(!result.rejected){job.experienceGained=progression.award(s,"buying");s.completedPurchases++;s.totalSpent=round(s.totalSpent+result.cost);s.plan.spent=round(s.plan.spent+result.cost);s.purchased[result.typeID]=(s.purchased[result.typeID]||0)+result.quantity;}
      s.history.unshift({...result,name:job.summary.name,jobID:job.jobID,completedAtMs:at,experienceGained:job.experienceGained||0});s.history=s.history.slice(0,20);job.phase="acknowledging";delete job.recoveryError;save(s);
    }
    market.acknowledge(job);s.job=null;s.status=s.paused?"paused":s.plan.enabled?"ready":"stopped";s.nextCheckAtMs=at+(job.cooldownMs||5000);save(s);
  }
  function snapshot(id){
    if(!enabled)return{enabled:false,revision:0,buying:null};check();const s=load(id);
    const job=s?.job?{jobID:s.job.jobID,serial:s.job.serial,phase:s.job.phase,summary:clone(s.job.summary),recoveryError:s.job.recoveryError,skillAtStart:clone(s.job.skillAtStart||null),cooldownMs:s.job.cooldownMs}:null;
    return{enabled:true,revision:s?.revision||0,buying:s?{...s,receipts:undefined,job,station:market.station(s.stationID),funding:funding(s),skill:progression.profile(s,"buying"),timing:{cooldownMs:progression.duration(5000,s,"buying"),checkMs:progression.duration(10000,s,"buying")}}:null,commandCapacityRemaining:1024-Object.keys(s?.receipts||{}).length};
  }
  function submit(id,input){return run(id,async()=>{
    check();const c=normalize(input),key=hash(c.commandID),at=now();let s=load(id);const prior=s?.receipts[key];
    if(prior){if(prior!==c.fingerprint)fail("CREW_COMMAND_REUSED","This order ID describes another order.");return{...snapshot(id),replayed:true};}
    if((s?.revision||0)!==c.expectedRevision)fail("CREW_REVISION_CONFLICT","Buying work changed. Refresh before issuing another order.");
    if(Object.keys(s?.receipts||{}).length>=1024-(c.type==="stop"?0:1))fail("CREW_COMMAND_CAPACITY","The buying order ledger is full.");
    if(c.type==="start"){
      if(!crew(id)?.crew)fail("CREW_NOT_FOUND","Establish a crew first.",404);
      if(!market.station(c.payload.stationID))fail("CREW_STATION_INVALID","Choose an NPC factory station.",400);
      c.payload.orders.forEach(o=>market.describe(id,c.payload.stationID,o.typeID));
      if(s?.job||s?.plan.enabled)fail("CREW_BUSY","Stop the current policy and let its accepted purchase finish first.");
      if(!s){
        if(Object.keys(repo.read(TABLE,"/").data).length>=128)fail("CREW_CAPACITY","The buying registry is full.",503);
        s={version:1,ownerID:id,revision:0,nextSerial:1,receipts:{},history:[],purchased:{},completedPurchases:0,totalSpent:0,job:null,
          roster:[{actorID:`buying:${id}:member:0`,name:"Arin Sol",role:"Procurement agent"},{actorID:`buying:${id}:member:1`,name:"Keva Marr",role:"Stores coordinator"}]};
      }
      s.stationID=c.payload.stationID;s.systemID=market.station(s.stationID).solarSystemID;
      s.plan={enabled:true,cursor:0,orders:c.payload.orders,walletReserve:c.payload.walletReserve,budgetISK:c.payload.budgetISK,spent:0};s.paused=false;s.status="ready";s.nextCheckAtMs=at;
    }else{
      if(!s?.plan.enabled)fail("CREW_NOT_FOUND","There is no active buying policy.",404);
      if(c.type==="pause"){if(s.paused)fail("CREW_ALREADY_PAUSED","New purchases are already paused.");s.paused=true;}
      else{if(c.type==="resume"&&!s.paused)fail("CREW_NOT_PAUSED","Buying is not paused.");if(c.type==="stop")s.plan.enabled=false;s.paused=false;s.nextCheckAtMs=at;}
      if(!s.job)s.status=s.paused?"paused":s.plan.enabled?"ready":"stopped";
    }
    s.receipts[key]=c.fingerprint;save(s);
    try{await progress(s,at);}catch{const fresh=load(id);if(fresh.job)fresh.job.recoveryError="Purchase confirmation is pending. The saved purchase will retry.";else{fresh.status="market_unavailable";fresh.nextCheckAtMs=at+progression.duration(15000,fresh,"buying");}save(fresh);}
    return{...snapshot(id),replayed:false};
  });}
  async function tick({budgetMs=4}={}){
    if(!enabled||ticking)return{processed:0,errors:[]};ticking=true;
    try{
      check();const ids=[...active],errors=[],started=performance.now();let processed=0;
      for(let i=0;i<Math.min(ids.length,8);i++){
        if(i&&performance.now()-started>=budgetMs)break;const id=ids[(cursor+i)%ids.length];
        if(!lanes.has(id))try{await run(id,()=>progress(load(id),now()));}catch(e){
          errors.push({ownerID:id,code:e.code||"CREW_PURCHASE_PENDING"});
          try{const s=load(id);if(s.job)s.job.recoveryError="Purchase confirmation is pending. The saved purchase will retry.";else{s.status="market_unavailable";s.nextCheckAtMs=now()+progression.duration(15000,s,"buying");}save(s);}catch{/* retain durable intent */}
        }
        processed++;
      }
      cursor=ids.length?(cursor+processed)%ids.length:0;return{processed,errors};
    }finally{ticking=false;}
  }
  function universeFacts({ownerID}={}){
    if(!enabled)return{actors:[],recentEvents:[]};check();const rows=ownerID?[load(ownerID)].filter(Boolean):Object.values(repo.read(TABLE,"/").data);
    return{actors:rows.flatMap(s=>s.roster.map(p=>({...p,ownerID:s.ownerID,kind:"crew_member",source:"buying_crews",crewID:`buying:${s.ownerID}`,crewName:"Buying crew",stationID:s.stationID,systemID:s.systemID,activity:s.job?.recoveryError?"awaiting_confirmation":s.job?"buying":s.paused?"paused":s.status,representation:"virtual",physicalEntityID:null,skill:progression.profile(s,"buying")}))),
      recentEvents:rows.flatMap(s=>s.history.filter(h=>!h.rejected).map(h=>({eventID:`buying:${h.jobID}:completed`,type:"minerals_purchased",source:"buying_crews",ownerID:s.ownerID,crewID:`buying:${s.ownerID}`,stationID:s.stationID,occurredAtMs:h.completedAtMs,typeID:h.typeID,quantity:h.quantity,cost:h.cost})))};
  }
  return{enabled,snapshot,submit,tick,universeFacts,catalog(id,stationID){check();if(!crew(id)?.crew)fail("CREW_NOT_FOUND","Establish a crew first.",404);return market.catalog(id,stationID);},drain:()=>Promise.allSettled([...lanes.values()])};
}
module.exports={TABLE,createBuyingCrewService};
