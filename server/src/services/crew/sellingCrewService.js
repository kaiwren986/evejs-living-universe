"use strict";
const { createHash } = require("node:crypto"), { performance } = require("node:perf_hooks");
const { CrewError } = require("./crewService");
const progression = require("./crewProgression");
const TABLE = "sellingCrewRuntime", clone = v => JSON.parse(JSON.stringify(v));
const hash = v => createHash("sha256").update(v).digest("hex"), positive = n => Number.isSafeInteger(n) && n > 0;
const exact = (o, keys) => o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).sort().join() === [...keys].sort().join();
const fail = (code, message, status = 409) => { throw new CrewError(code, message, status); };
function validOrder(o) { return exact(o, ["typeID", "reserve", "batchSize", "minimumPrice"]) && positive(o.typeID) && Number.isSafeInteger(o.reserve) && o.reserve >= 0 && o.reserve <= 1000000000 &&
  positive(o.batchSize) && o.batchSize <= 10000 && Number.isFinite(o.minimumPrice) && o.minimumPrice >= 0.01 && o.minimumPrice <= 100000000 && Math.abs(o.minimumPrice*100-Math.round(o.minimumPrice*100)) < 0.0001; }
function normalize(c) {
  if (!exact(c,["commandID","expectedRevision","type","payload"]) || typeof c.commandID !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(c.commandID) || !Number.isSafeInteger(c.expectedRevision) || c.expectedRevision < 0 ||
      !["start","pause","resume","stop"].includes(c.type)) fail("CREW_COMMAND_INVALID", "The selling order is invalid.",400);
  if (c.type === "start" ? !exact(c.payload,["stationID","orders"]) || !positive(c.payload.stationID) || !Array.isArray(c.payload.orders) || !c.payload.orders.length || c.payload.orders.length > 8 || c.payload.orders.some(o=>!validOrder(o)) || new Set(c.payload.orders.map(o=>o.typeID)).size !== c.payload.orders.length : !exact(c.payload,[]))
    fail("CREW_COMMAND_INVALID", "Choose up to eight ammo/module products, a reserve, batch size and positive minimum price with two decimal places.",400);
  return { ...clone(c), fingerprint:hash(JSON.stringify(c)) };
}
function createSellingCrewService({repo,market,crew,enabled=true,now=Date.now}) {
  let initialized=false,cursor=0,ticking=false; const active=new Set(),lanes=new Map();
  function validate(s,id) {
    progression.validate(s?.progression);
    if (!s || s.version!==1 || s.ownerID!==id || !positive(id) || !Number.isSafeInteger(s.revision) || s.revision<0 || !positive(s.nextSerial) || !market.station(s.stationID) ||
        typeof s.paused!=="boolean" || !s.plan || typeof s.plan.enabled!=="boolean" || !Array.isArray(s.plan.orders) || !s.plan.orders.length || s.plan.orders.length>8 ||
        !Number.isSafeInteger(s.plan.cursor) || s.plan.cursor<0 || s.plan.cursor>=s.plan.orders.length || s.plan.orders.some(o=>!validOrder(o)) ||
        !Array.isArray(s.roster) || s.roster.length!==2 || s.roster.some((p,i)=>p.actorID!==`selling:${id}:member:${i}`) || !s.receipts || Object.keys(s.receipts).length>1024 || !Array.isArray(s.history) || s.history.length>20 ||
        !Number.isSafeInteger(s.completedSales) || s.completedSales<0 || [s.grossRevenue,s.taxPaid,s.netRevenue].some(n=>!Number.isFinite(n)||n<0)) fail("CREW_STATE_INVALID","The saved selling crew needs recovery.",503);
    if (s.job && (!/^[a-f0-9]{64}$/.test(s.job.jobID) || !positive(s.job.serial) || s.job.serial>=s.nextSerial || !["selling","acknowledging"].includes(s.job.phase) ||
        s.job.saga?.sellerCharacterID!==id || s.job.saga.crewSale?.jobID!==s.job.jobID || s.job.saga.crewSale?.serial!==s.job.serial || s.job.saga.crewSale?.stationID!==s.stationID ||
        !positive(s.job.summary?.quantity) || !positive(s.job.summary?.typeID) ||
        (s.job.cooldownMs!==undefined&&(!Number.isSafeInteger(s.job.cooldownMs)||s.job.cooldownMs<2500||s.job.cooldownMs>5000)))) fail("CREW_STATE_INVALID","The saved sale needs recovery.",503);
  }
  function check() {
    if (!enabled) fail("CREW_DISABLED","Crew selling is disabled.",503);
    if(!initialized){repo.ensureTable(TABLE);const root=repo.read(TABLE,"/");if(!root.success||!root.data||Array.isArray(root.data)||Object.keys(root.data).length>128)fail("CREW_STORE_UNAVAILABLE","Selling records are unavailable.",503);
      for(const[id,s]of Object.entries(root.data)){validate(s,Number(id));if(s.job||s.plan.enabled)active.add(Number(id));}initialized=true;}
    if(repo.flushTableSync(TABLE)?.success!==true)fail("CREW_STORE_UNAVAILABLE","Selling records are pending. Retry the same order.",503);
  }
  function load(id){if(!positive(id))fail("CREW_OWNER_INVALID","Select a valid pilot.",400);const r=repo.read(TABLE,`/${id}`);if(!r.success){if(r.errorMsg==="ENTRY_NOT_FOUND")return null;fail("CREW_STORE_UNAVAILABLE","Selling records are unavailable.",503);}validate(r.data,id);const s=clone(r.data);progression.ensure(s,"selling");return s;}
  function save(s){progression.ensure(s,"selling");validate(s,s.ownerID);s.revision++;if(repo.write(TABLE,`/${s.ownerID}`,clone(s))?.success!==true)fail("CREW_STORE_UNAVAILABLE","Selling records are pending.",503);
    if(s.job||s.plan.enabled)active.add(s.ownerID);else active.delete(s.ownerID);if(repo.flushTableSync(TABLE)?.success!==true)fail("CREW_STORE_UNAVAILABLE","Selling records are pending. Retry the same order.",503);}
  function run(id,fn){const p=(lanes.get(id)||Promise.resolve()).catch(()=>{}).then(fn);lanes.set(id,p);void p.finally(()=>{if(lanes.get(id)===p)lanes.delete(id);}).catch(()=>{});return p;}
  async function progress(s,at){
    if(!s)return;
    if(!s.job){if(!s.plan.enabled||s.paused||at<s.nextCheckAtMs)return;const availability=[];
      for(let offset=0;offset<s.plan.orders.length;offset++){
        const index=(s.plan.cursor+offset)%s.plan.orders.length,o=s.plan.orders[index],serial=s.nextSerial,jobID=hash(`selling:${s.ownerID}:${serial}`);
        const result=await market.prepare(s.ownerID,s.stationID,o,{jobID,serial});
        if(!result.ready){availability.push({typeID:o.typeID,status:result.status,stock:market.stock(s.ownerID,s.stationID,o.typeID)});continue;}
        s.job={jobID,serial,phase:"selling",saga:result.saga,summary:result.summary,skillAtStart:progression.profile(s,"selling"),cooldownMs:progression.duration(5000,s,"selling")};s.nextSerial++;s.plan.cursor=(index+1)%s.plan.orders.length;s.status="selling";s.availability=availability;save(s);break;
      }
      if(!s.job){s.availability=availability;s.status=availability.every(a=>a.status==="reserve_met")?"reserve_met":"waiting_for_buyers";s.nextCheckAtMs=at+progression.duration(10000,s,"selling");save(s);return;}
    }
    const job=s.job;
    if(job.phase==="selling"){
      const result=await market.settle(job);job.result=result;
      if(!result.rejected){job.experienceGained=progression.award(s,"selling");s.completedSales++;for(const[key,value]of [["grossRevenue",result.gross],["taxPaid",result.tax],["netRevenue",result.net]])s[key]=Math.round((s[key]+value)*100)/100;
        s.sold[result.typeID]=(s.sold[result.typeID]||0)+result.quantity;}
      s.history.unshift({...result,name:job.summary.name,jobID:job.jobID,completedAtMs:at,experienceGained:job.experienceGained||0});s.history=s.history.slice(0,20);job.phase="acknowledging";delete job.recoveryError;save(s);
    }
    market.acknowledge(job);s.job=null;s.status=s.paused?"paused":s.plan.enabled?"ready":"stopped";s.nextCheckAtMs=at+(job.cooldownMs||5000);save(s);
  }
  function snapshot(id){if(!enabled)return{enabled:false,revision:0,selling:null};check();const s=load(id),job=s?.job?{jobID:s.job.jobID,serial:s.job.serial,phase:s.job.phase,summary:clone(s.job.summary),recoveryError:s.job.recoveryError,skillAtStart:clone(s.job.skillAtStart||null),cooldownMs:s.job.cooldownMs}:null;
    return{enabled:true,revision:s?.revision||0,selling:s?{...s,receipts:undefined,job,station:market.station(s.stationID),skill:progression.profile(s,"selling"),timing:{cooldownMs:progression.duration(5000,s,"selling"),checkMs:progression.duration(10000,s,"selling")}}:null,commandCapacityRemaining:1024-Object.keys(s?.receipts||{}).length};}
  function submit(id,input){return run(id,async()=>{check();const c=normalize(input),key=hash(c.commandID),at=now();let s=load(id);const prior=s?.receipts[key];if(prior){if(prior!==c.fingerprint)fail("CREW_COMMAND_REUSED","This order ID describes another order.");return{...snapshot(id),replayed:true};}
    if((s?.revision||0)!==c.expectedRevision)fail("CREW_REVISION_CONFLICT","Selling work changed. Refresh before issuing another order.");
    if(Object.keys(s?.receipts||{}).length>=1024-(c.type==="stop"?0:1))fail("CREW_COMMAND_CAPACITY","The selling order ledger is full.");
    if(c.type==="start"){
      if(!crew(id)?.crew)fail("CREW_NOT_FOUND","Establish a crew first.",404);if(!market.station(c.payload.stationID))fail("CREW_STATION_INVALID","Choose an NPC market station.",400);
      c.payload.orders.forEach(o=>market.describe(o.typeID));if(s?.job||s?.plan.enabled)fail("CREW_BUSY","Stop the current policy and let its accepted sale finish first.");
      if(!s){if(Object.keys(repo.read(TABLE,"/").data).length>=128)fail("CREW_CAPACITY","The selling registry is full.",503);
        s={version:1,ownerID:id,revision:0,nextSerial:1,stationID:c.payload.stationID,receipts:{},history:[],sold:{},completedSales:0,grossRevenue:0,taxPaid:0,netRevenue:0,job:null,
          roster:[{actorID:`selling:${id}:member:0`,name:"Lysa Rell",role:"Market agent"},{actorID:`selling:${id}:member:1`,name:"Torin Voss",role:"Trade clerk"}]};}
      s.stationID=c.payload.stationID;s.systemID=market.station(s.stationID).solarSystemID;s.plan={enabled:true,cursor:0,orders:c.payload.orders};s.paused=false;s.status="ready";s.nextCheckAtMs=at;
    }else{if(!s?.plan.enabled)fail("CREW_NOT_FOUND","There is no active selling policy.",404);
      if(c.type==="pause"){if(s.paused)fail("CREW_ALREADY_PAUSED","New sales are already paused.");s.paused=true;}
      else{if(c.type==="resume"&&!s.paused)fail("CREW_NOT_PAUSED","Selling is not paused.");if(c.type==="stop")s.plan.enabled=false;s.paused=false;s.nextCheckAtMs=at;}
      if(!s.job)s.status=s.paused?"paused":s.plan.enabled?"ready":"stopped";
    }
    s.receipts[key]=c.fingerprint;save(s);
    // Acceptance is durable even if the market is offline. The tick retries it.
    try{await progress(s,at);}catch{const fresh=load(id);if(fresh.job)fresh.job.recoveryError="Sale confirmation is pending. The saved sale will retry.";else{fresh.status="market_unavailable";fresh.nextCheckAtMs=at+progression.duration(15000,fresh,"selling");}save(fresh);}
    return{...snapshot(id),replayed:false};
  });}
  async function tick({budgetMs=4}={}){if(!enabled||ticking)return{processed:0,errors:[]};ticking=true;try{check();const ids=[...active],errors=[],start=performance.now();let processed=0;
    for(let i=0;i<Math.min(ids.length,8);i++){if(i&&performance.now()-start>=budgetMs)break;const id=ids[(cursor+i)%ids.length];if(!lanes.has(id))try{await run(id,()=>progress(load(id),now()));}catch(e){errors.push({ownerID:id,code:e.code||"CREW_MARKET_PENDING"});try{const s=load(id);if(s.job)s.job.recoveryError="Sale confirmation is pending. The saved sale will retry.";else{s.status="market_unavailable";s.nextCheckAtMs=now()+progression.duration(15000,s,"selling");}save(s);}catch{/* retain intent */}}processed++;}
    cursor=ids.length?(cursor+processed)%ids.length:0;return{processed,errors};}finally{ticking=false;}}
  function universeFacts({ownerID}={}){if(!enabled)return{actors:[],recentEvents:[]};check();const rows=ownerID?[load(ownerID)].filter(Boolean):Object.values(repo.read(TABLE,"/").data);
    return{actors:rows.flatMap(s=>s.roster.map(p=>({...p,ownerID:s.ownerID,kind:"crew_member",source:"selling_crews",crewID:`selling:${s.ownerID}`,crewName:"Selling crew",stationID:s.stationID,systemID:s.systemID,activity:s.job?.recoveryError?"awaiting_confirmation":s.job?"selling":s.paused?"paused":s.status,representation:"virtual",physicalEntityID:null,skill:progression.profile(s,"selling")}))),
      recentEvents:rows.flatMap(s=>s.history.filter(h=>!h.rejected).map(h=>({eventID:`selling:${h.jobID}:completed`,type:"goods_sold",source:"selling_crews",ownerID:s.ownerID,crewID:`selling:${s.ownerID}`,stationID:s.stationID,occurredAtMs:h.completedAtMs,typeID:h.typeID,quantity:h.quantity,net:h.net})))};}
  return{enabled,snapshot,submit,tick,universeFacts,catalog(id,stationID){check();if(!crew(id)?.crew)fail("CREW_NOT_FOUND","Establish a crew first.",404);return market.catalog(id,stationID);},drain:()=>Promise.allSettled([...lanes.values()])};
}
module.exports={TABLE,createSellingCrewService};
