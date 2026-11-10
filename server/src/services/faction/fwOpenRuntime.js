"use strict";
const { getWallclockNowMs } = require("../../space/runtime/runtimeClock");
const model=require("./fwOpenModel");
const rewards=require("./fwOpenRewards");
const campaign=require("../seasons/campaignTrailCatalog");
const dungeon=()=>require("../dungeon/dungeonRuntime");
const service=()=>require("../dungeon/dungeonUniverseSiteService");
const ticks=new Map();
const notices=new Map();
const isSite=i=>Boolean(i?.templateID?.startsWith("evejs-fw:open:"));
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
function restoreTag(entity) {
  const match=/^fw-open:(500004|500001):([01])$/.exec(entity?.dungeonEncounterKey||"");
  if(match) Object.assign(entity,{fwOpenFaction:Number(match[1]),fwOpenSlot:`${match[1]}:${match[2]}`});
  return entity;
}
function faction(entity) {
  restoreTag(entity);
  if(entity?.fwOpenFaction) return entity.fwOpenFaction;
  const id=Number(entity?.session?.characterID||entity?.characterID||entity?.ownerID);
  return id&&require("../corporation/fwCharacterEnlistmentMgrService").getPersistedEnlistmentFactionID(id)||0;
}
function players(scene,instance) {
  const unique=new Map();
  const root=scene.getEntityByID(instance.metadata?.siteID);
  if(!root || Number(instance.solarSystemID)!==Number(scene.systemID)) return [];
  for(const e of scene.dynamicEntities.values()) {
    const id=Number(e.session?.characterID||e.session?.charid);
    if(!id||e.kind!=="ship"||e.nativeNpc||e.destroyed||e.session?._characterControlDisconnected===true||
      e.session?.socket?.destroyed===true||e.session?._space?.shipID!==e.itemID||
      scene.sessions.get(e.session.clientID??id)!==e.session||!require("../../space/destiny/identity/interactionScope").canEntitiesInteractLocally(root,e)||
      [29,328].includes(Number(e.groupID))||
      require("../../space/destiny/simulation/warpPhase").isEntityInActiveWarp(e)||
      require("../../space/runtime/shipCloak").isEntityCloaked(e)||distance(e.position,instance.position)>model.RADIUS) continue;
    if([model.GALLENTE,model.CALDARI].includes(faction(e))) unique.set(id,e);
  }
  return [...unique.values()];
}
function save(instance,state) {dungeon().mergeSpawnState(instance.instanceID,{fwOpen:state},{durable:true});}
function entities(scene,instance) {return service().listMaterializedUniverseSiteContentEntities(scene,{instanceID:instance.instanceID}).map(restoreTag).filter(e=>e.fwOpenFaction);}
function notify(ships,text) {
  for(const e of ships) e.session?.sendNotification?.("OnRemoteMessage","clientID",["CustomNotify",require("../_shared/serviceHelpers").buildDict([["notify",{type:"wstring",value:text}]])]);
}
function destroy(scene,entity,options={}) {
  restoreTag(entity);
  if(!entity.fwOpenFaction) return null;
  const instance=dungeon().getInstance(entity.dungeonSiteInstanceID);
  if(!isSite(instance)) return null;
  const state=instance.spawnState.fwOpen||{progress:0,killed:{}};
  const now=options.destructionNowMs??getWallclockNowMs();
  save(instance,{...state,killed:{...state.killed,[entity.fwOpenSlot]:now+180000}});
  return service().fwOpenPorts.remove(scene,entity,{terminalDestructionEffectID:1})||{success:true};
}
function cloakBlocked(scene,entity) {
  return dungeon().listActiveInstancesBySystem(scene.systemID,{full:true}).some(i=>isSite(i)&&distance(entity.position,i.position)<=model.RADIUS&&!rewards.getReceipt(i));
}
function tick(scene,instance,now) {
  if(!isSite(instance)) return;
  const root=scene.getEntityByID(instance.metadata.siteID);
  if(!root) return;
  const committed=rewards.getReceipt(instance);
  if(committed) {
    rewards.settle(committed,[...scene.sessions.values()]);
    if(!instance.spawnState.fwOpen?.completedAtMs) save(instance,{...instance.spawnState.fwOpen,completedAtMs:committed.completedAtMs});
    for(const npc of entities(scene,instance)) service().fwOpenPorts.remove(scene,npc);
    ticks.delete(instance.instanceID);
    // Keep the settled source until the replacement delay; no second capture.
    if(now>=committed.completedAtMs+1800000 && !service().fwOpenPorts.occupied(scene,root))
      dungeon().setLifecycleState(instance.instanceID,"completed",{reason:"fw_capture_settled",completedAtMs:now});
    return;
  }
  if(!campaign.isEnabled()) {ticks.delete(instance.instanceID);return;}
  let state=instance.spawnState.fwOpen||{progress:0,killed:{}};
  let npcs=entities(scene,instance);
  // Authored two battlecruisers per side; both sides contest and fight.
  for(const side of [model.GALLENTE,model.CALDARI]) for(let index=0;index<2;index++) {
    const key=`${side}:${index}`, deadline=state.killed[key]||0;
    const existing=npcs.find(e=>e.fwOpenSlot===key);
    if(deadline>now) {if(existing) service().fwOpenPorts.remove(scene,existing);continue;}
    if(!existing) service().fwOpenPorts.npc(scene,instance,root,{key,faction:side,index,typeID:side===model.GALLENTE?32973:32972});
  }
  npcs=entities(scene,instance);
  const ships=players(scene,instance), sides=[...new Set(ships.map(faction))];
  const side=sides.length===1?sides[0]:0;
  const blocked=side&&npcs.some(e=>e.fwOpenFaction!==side&&distance(e.position,instance.position)<=model.RADIUS);
  const active=side&&!blocked?side:0;
  const previous=ticks.get(instance.instanceID);
  // Never count downtime, scene absence, or the interval before arrival/unblocking.
  const elapsed=previous&&previous.scene===scene&&previous.root===root&&previous.active===active&&now>=previous.now&&now-previous.now<=5000 ? now-previous.now:0;
  const progress=model.advance(state.progress,active,elapsed);
  const finished=Math.abs(progress)>=model.CAPTURE_MS&&active;
  if(progress!==state.progress) {
    state={...state,progress};
    // Completion and its recipient snapshot are the same durable mutation.
    // Never persist a finished timer without its reward receipt.
    if(!finished) save(instance,state);
  }
  ticks.set(instance.instanceID,{now,active,scene,root});
  const notice=`${active}:${sides.length}:${Boolean(blocked)}:${Math.ceil((model.CAPTURE_MS-(side===model.CALDARI?-1:1)*progress)/30000)}`;
  if(ships.length&&notices.get(instance.instanceID)!==notice) {
    notices.set(instance.instanceID,notice);
    notify(ships,active ? `FW capture: ${Math.ceil((model.CAPTURE_MS-(side===model.GALLENTE?1:-1)*progress)/1000)} seconds remaining. Stay within 30 km.` : "FW capture paused: clear opposing militia ships and NPCs within 30 km.");
  }
  if(finished) {
    const receipt=rewards.commit(instance,active,ships.map(e=>Number(e.session.characterID||e.session.charid)),now);
    rewards.settle(receipt,[...scene.sessions.values()]);
    save(instance,{...state,completedAtMs:receipt.completedAtMs});
    notify(ships,`FW ${receipt.mode} complete. ${receipt.participants[0].lp.toLocaleString()} militia LP per eligible pilot. Gallente completions count toward your active election challenge.`);
  }
}
module.exports={isSite,faction,players,tick,destroy,cloakBlocked,_testing:{reset(){ticks.clear();notices.clear();}}};
