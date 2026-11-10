"use strict";
const { getWallclockNowMs } = require("../../space/runtime/runtimeClock");
const model = require("./fabricatorModel");
const campaign = require("./campaignTrailCatalog");
const combat = require("./gallenteCombatCatalog");
const PREFIX = "evejs-election:fabricator:";
const isFabricator = instance => Boolean(instance?.templateID?.startsWith(PREFIX));
const dungeon = () => require("../dungeon/dungeonRuntime");
const service = () => require("../dungeon/dungeonUniverseSiteService");
function save(instance,state) {
  dungeon().mergeSpawnState(instance.instanceID,{fabricator:state},{durable:true});
}
function rewardTier(systemID) {
  const c = require("../exploration/wormholes/wormholeAuthority").getSystemClassID(systemID);
  if (c >= 1 && c <= 3) return 0;
  if (c === 5 || c === 6) return 2;
  return 1;
}
function eligibleSystem(systemID) {
  const system = require("../../space/worldData").getSolarSystemByID(systemID);
  if (!system) return false;
  const c = require("../exploration/wormholes/wormholeAuthority").getSystemClassID(systemID);
  if (Number(systemID) >= 31000000) return c >= 1 && c <= 6;
  if (Number(system.regionID) === 10000070) return true;
  const sec = Number(system.securityStatus ?? system.security);
  return Number(system.regionID) !== 10000019 && sec >= 0 && sec < 0.45;
}
function entities(scene,instance) {
  return service().listMaterializedUniverseSiteContentEntities(scene,{instanceID:instance.instanceID});
}
function distance(a,b) {
  return Math.hypot(a?.x-b?.x,a?.y-b?.y,a?.z-b?.z);
}
function participants(scene,root) {
  return [...scene.dynamicEntities.values()].filter(e => e.session && e.kind === "ship" &&
    e.mode !== "WARP" && !require("../../space/runtime/shipCloak").isEntityCloaked(e) &&
    model.rampancy(e) && distance(e.position,root.position) <= 50000);
}
function notify(ships,text) {
  for (const ship of ships) ship.session?.sendNotification?.("OnRemoteMessage","clientID",["CustomNotify",require("../_shared/serviceHelpers").buildDict([["notify",{type:"wstring",value:text}]])]);
}
function reconcileProgress(session,state) {
  const trail = require("./campaignTrailRuntime");
  const characterID = trail.getCharacterID(session);
  for (const [id,pending] of Object.entries(state.fabricatorPending || {})) {
    const instance = dungeon().getInstance(pending.instanceID);
    const receipt = instance?.spawnState?.fabricator?.kills?.[pending.key];
    if (receipt?.characterID === characterID && !state.fabricatorReceipts?.[id]) {
      const step = combat.getActiveStep(state);
      const eligible = step && !state.combat?.readyAtMs && step.index === receipt.index && state.candidateKey === receipt.candidateKey;
      if (eligible) {
        state.combat = {...state.combat,count:Math.min(step.count,(state.combat?.count || 0)+1)};
        if (state.combat.count === step.count) state.combat.readyAtMs = receipt.atMs;
      }
      state.fabricatorReceipts = {...state.fabricatorReceipts,[id]:true};
      trail.saveProgress(characterID,state);
      if (eligible) {
        session.sendNotification?.("OnChallengeProgressUpdate","charid",[step.challengeID,state.combat.count]);
        if (state.combat.readyAtMs) session.sendNotification?.("OnChallengeRewardsGranted","charid",[step.challengeID]);
      }
    }
    if (receipt?.characterID === characterID && !receipt.acknowledged) {
      const latest = dungeon().getInstance(instance.instanceID).spawnState.fabricator;
      save(instance,{...latest,kills:{...latest.kills,[pending.key]:{...receipt,acknowledged:true}}});
    }
    state.fabricatorPending = {...state.fabricatorPending};
    delete state.fabricatorPending[id];
    trail.saveProgress(characterID,state);
  }
}
function beforePurge(instance) {
  if (!isFabricator(instance)) return;
  const trail = require("./campaignTrailRuntime");
  for (const receipt of Object.values(instance.spawnState?.fabricator?.kills || {})) {
    if (!receipt.acknowledged && receipt.characterID) reconcileProgress({characterID:receipt.characterID},trail.getProgress(receipt.characterID));
  }
  const latest = dungeon().getInstance(instance.instanceID);
  if (Object.values(latest?.spawnState?.fabricator?.kills || {}).some(r => !r.acknowledged)) throw new Error("Fabricator cleanup deferred: unsettled kill credit");
}
function ownerSession(scene,attacker) {
  if (!attacker || attacker.nativeNpc) return null;
  if (attacker.session) return attacker.session;
  // Drones and fighters have a character owner rather than a pilot session.
  const id = Number(attacker.pilotCharacterID || attacker.characterID || attacker.ownerID);
  return [...scene.sessions.values()].find(s => Number(s.characterID || s.charid) === id) || null;
}
function destroy(scene,entity,options = {}) {
  const instance = dungeon().getInstance(entity.dungeonSiteInstanceID);
  if (!isFabricator(instance) || !entity.fabricatorRole) return null;
  let state = instance.spawnState.fabricator;
  const now = options.destructionNowMs ?? getWallclockNowMs();
  const session = ownerSession(scene,options.attackerEntity);
  if (entity.fabricatorRole === "core") {
    const next = model.cashOut(state,now);
    if (next === state) return {success:false,errorMsg:"FABRICATOR_INVULNERABLE"};
    save(instance,{...next,coreCondition:entity.conditionState});
  } else if (entity.fabricatorRole === "npc") {
    const trail = require("./campaignTrailRuntime");
    const key = entity.fabricatorSlot;
    if (!state.kills[key]) {
      const characterID = session && trail.getCharacterID(session);
      const progress = characterID ? trail.getProgress(characterID) : null;
      if (progress) reconcileProgress(session,progress);
      const step = progress && combat.getActiveStep(progress);
      const eligible = campaign.isEnabled() && step && !progress.combat?.readyAtMs;
      if (eligible) {
        progress.fabricatorPending = {...progress.fabricatorPending,[`${instance.instanceID}:${key}`]:{instanceID:instance.instanceID,key}};
        trail.saveProgress(characterID,progress);
      }
      const receipt = {characterID:characterID || 0,index:eligible ? step.index : null,
        candidateKey:progress?.candidateKey,atMs:now,acknowledged:!eligible};
      state = model.kill(dungeon().getInstance(instance.instanceID).spawnState.fabricator,key,receipt,now);
      save(instance,state);
      if (state.phase === "break") notify(participants(scene,{position:instance.position}),`Wave ${state.wave} cleared. ${state.loot} Rampancy Data Dumps accumulated. Destroy the Fabricator ${state.wave === 100 ? "to collect your rewards" : "within 20 seconds to cash out, or continue fighting"}.`);
      if (eligible) reconcileProgress(session,progress);
    }
  } else if (entity.fabricatorRole === "bonus") {
    if (state.phase !== "wave" || !state.bonus || state.bonus.chosen) return {success:false,errorMsg:"FABRICATOR_INVULNERABLE"};
    const ships = participants(scene,{position:instance.position});
    const buffs = {...state.buffs};
    for (const ship of ships) buffs[ship.itemID] = {...buffs[ship.itemID],[entity.fabricatorBonus]:true};
    save(instance,{...state,buffs,bonus:{...state.bonus,chosen:entity.fabricatorBonus}});
    notify(ships,`${entity.itemName}: site bonus activated.`);
  } else if (entity.fabricatorRole === "wreck") {
    save(instance,{...state,wreckDestroyed:true});
  }
  const result = service().fabricatorPorts.remove(scene,entity,{terminalDestructionEffectID:1});
  return result || {success:true};
}
function tag(entity,role,extra={}) { Object.assign(entity,{fabricatorRole:role,...extra}); return entity; }
function tick(scene,instance,now) {
  if (!isFabricator(instance)) return;
  const root = scene.getEntityByID(instance.metadata.siteID);
  if (!root) return;
  const ports = service().fabricatorPorts;
  let state = instance.spawnState?.fabricator || model.initial(rewardTier(scene.systemID));
  const ships = participants(scene,root);
  const next = campaign.isEnabled() ? model.advance(state,ships,now) : {...state,phase:"failed",loot:0,hybrids:{}};
  if (JSON.stringify(next) !== JSON.stringify(state) || !instance.spawnState?.fabricator) {
    save(instance,next);
    if (state.wave !== next.wave) notify(ships,`Fabricator wave ${next.wave}. Rampancy ${next.rampancy}${next.capital ? " — capital escalation" : ""}.`);
    if (state.unstableAt === null && next.unstableAt !== null) notify([...scene.dynamicEntities.values()].filter(e=>e.session && distance(e.position,root.position)<250000),"Fabricator unstable: return an eligible uncloaked combat ship within 50 km in 30 seconds or lose the site rewards.");
    state = next;
  }
  updateBuffs(scene,instance,state,ships);
  let live = entities(scene,instance);
  for (const e of live) {
    if ((e.fabricatorRole === "npc" && (state.kills[e.fabricatorSlot] || ["failed","cashed"].includes(state.phase))) ||
        (e.fabricatorRole === "bonus" && (!state.bonus || state.bonus.chosen)) ||
        (e.fabricatorRole === "core" && ["failed","cashed"].includes(state.phase))) ports.remove(scene,e);
  }
  if (state.phase === "failed") {
    beforePurge(dungeon().getInstance(instance.instanceID));
    dungeon().setLifecycleState(instance.instanceID,"completed",{nowMs:now});
    return;
  }
  if (state.phase === "cashed") {
    if (!state.wreckDestroyed) {
      const container = ports.cashout(scene,dungeon().getInstance(instance.instanceID),root,state.loot,now);
      if (container) tag(container,"wreck");
    }
    if (!ports.occupied(scene,instance,root.itemID)) {
      beforePurge(dungeon().getInstance(instance.instanceID));
      dungeon().setLifecycleState(instance.instanceID,"completed",{nowMs:now});
    }
    return;
  }
  let core = live.find(e=>e.fabricatorRole === "core");
  if (!core) core = ports.structure(scene,instance,root,{key:"fabricator",typeID:91774,label:"Rampant Fabricator",positionOffset:{x:0,y:0,z:0}});
  if (core) {
    tag(core,"core");
    if (state.coreCondition && !core.fabricatorHealthRestored) core.conditionState = structuredClone(state.coreCondition);
    core.fabricatorHealthRestored = true;
    if (JSON.stringify(state.coreCondition) !== JSON.stringify(core.conditionState)) {
      state = {...state,coreCondition:structuredClone(core.conditionState)}; save(instance,state);
    }
  }
  if (state.phase === "wave") {
    for (const slot of state.slots) {
      if (state.kills[slot.key] || live.some(e=>e.fabricatorSlot === slot.key)) continue;
      const spawned = ports.npc(scene,instance,root,slot);
      if (spawned) tag(spawned,"npc",{fabricatorSlot:slot.key});
    }
    if (state.bonus && !state.bonus.chosen) {
      for (const [index,name] of require("./fabricatorBonuses").choices(state.wave).entries()) {
        if (live.some(e=>e.fabricatorRole === "bonus" && e.fabricatorBonus === name)) continue;
        const e = ports.structure(scene,instance,root,{key:`bonus:${state.wave}:${name}`,typeID:ports.bonusType(name),label:`${name} Nanoswarm`,positionOffset:{x:index ? -15000:15000,y:0,z:0}});
        if (e) tag(e,"bonus",{fabricatorBonus:name});
      }
    }
  }
}
function updateBuffs(scene,instance,state,ships) {
  for (const ship of scene.dynamicEntities.values()) {
    if (!ship.session) continue;
    const buffs = !["failed","cashed"].includes(state.phase) && ships.includes(ship) ? state.buffs[ship.itemID] || {} : {};
    if (ship.fabricatorBuffInstance && ship.fabricatorBuffInstance !== instance.instanceID) continue;
    if (JSON.stringify(ship.fabricatorBuffs || {}) !== JSON.stringify(buffs)) {
      ship.fabricatorBuffs = buffs;
      ship.fabricatorBuffInstance = Object.keys(buffs).length ? instance.instanceID : null;
      scene.refreshShipEntityDerivedState?.(ship);
    }
  }
}
function damageMultiplier(scene,attacker,target,options={},now=getWallclockNowMs()) {
  const targetInstance = target?.fabricatorRole && dungeon().getInstance(target.dungeonSiteInstanceID);
  const s = targetInstance?.spawnState?.fabricator;
  if (s) {
    if (target.fabricatorRole === "core" && !(s.phase === "break" && (s.wave === 100 || now<s.deadline))) return 0;
    if (target.fabricatorRole === "npc" && s.kills[target.fabricatorSlot]) return 0;
    if (target.fabricatorRole === "bonus" && (s.phase !== "wave" || !s.bonus || s.bonus.chosen)) return 0;
  }
  if (s && ["core","npc","bonus"].includes(target.fabricatorRole) && ["smartbomb","bomb","vorton"].includes(options.fabricatorDamageKind) && distance(target.position,targetInstance.position)<=50000) return 0.05;
  const sourceInstance = attacker?.fabricatorRole === "npc" && dungeon().getInstance(attacker.dungeonSiteInstanceID);
  if (sourceInstance?.spawnState?.fabricator) {
    if (target?.kind === "fighter") return 0;
    return model.damageScale(sourceInstance.spawnState.fabricator,target?.groupID);
  }
  return 1;
}
function disruption(scene,ship) {
  return [...(scene.dynamicEntities?.values() || [])].some(e=>e.fabricatorRole === "wreck" && distance(e.position,ship.position)<20000);
}
function refreshDepartedBonuses(scene) {
  for (const ship of scene.dynamicEntities.values()) {
    if (!ship.fabricatorBuffInstance) continue;
    const instance = dungeon().getInstance(ship.fabricatorBuffInstance);
    const state = instance?.spawnState?.fabricator;
    if (campaign.isEnabled() && state && !["failed","cashed"].includes(state.phase) &&
        distance(ship.position,instance.position)<=50000 && ship.mode !== "WARP" &&
        !require("../../space/runtime/shipCloak").isEntityCloaked(ship)) continue;
    ship.fabricatorBuffs = {};
    ship.fabricatorBuffInstance = null;
    scene.refreshShipEntityDerivedState?.(ship);
  }
}
module.exports = { isFabricator,eligibleSystem,rewardTier,tick,destroy,reconcileProgress,beforePurge,damageMultiplier,disruption,ownerSession,refreshDepartedBonuses };
