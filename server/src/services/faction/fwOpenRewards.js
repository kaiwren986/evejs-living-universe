"use strict";
const db=require("../../gameStore");
const model=require("./fwOpenModel");
const campaign=require("../seasons/campaignTrailCatalog");
const catalog=require("../seasons/gallenteFwCatalog");
const authority=require("./factionWarfareAuthority");
const trail=()=>require("../seasons/campaignTrailRuntime");
const wallet=()=>require("../corporation/lpWalletState");
const read=authority.readState;
const write=authority.writeState;
const systemState=authority.systemState;
function receiptID(instance) {return `fw-open-v1:${instance.instanceID}`;}
function getReceipt(instance) {return read().receipts[receiptID(instance)]||null;}
function commit(instance,faction,characterIDs,now) {
  const state=read(), id=receiptID(instance);
  const ids=[...new Set(characterIDs)].filter(id=>Number.isSafeInteger(id)&&id>0);
  if(state.receipts[id]) {
    const existing=state.receipts[id];
    if(existing.systemID!==instance.solarSystemID || existing.faction!==faction ||
       JSON.stringify(existing.participants.map(p=>p.characterID).sort((a,b)=>a-b))!==JSON.stringify([...ids].sort((a,b)=>a-b)))
      throw new Error("FW completion identity conflict");
    return existing;
  }
  const system=systemState(instance.solarSystemID,state);
  const before=authority.getSystem(instance.solarSystemID,state);
  if(!system||!ids.length||!model.ISSUERS[faction]) throw new Error("Invalid FW completion");
  const lp=model.reward(faction,system,ids.length);
  const participants=ids.map(characterID=>{
    const progress=trail().getProgress(characterID), step=catalog.getActiveStep(progress);
    const election=campaign.isEnabled()&&faction===model.GALLENTE&&step&&!progress.fw?.readyAtMs
      ? {seasonID:campaign.SEASON_ID,candidateKey:progress.candidateKey,index:step.index}:null;
    state.pending[characterID]={...state.pending[characterID],[id]:true};
    return {characterID,lp,issuerID:model.ISSUERS[faction],election};
  });
  const receipt={id,instanceID:instance.instanceID,systemID:instance.solarSystemID,faction,completedAtMs:now,
    mode:faction===system.occupier ? "defence":"capture",participants};
  state.receipts[id]=receipt;
  // Victory points and the immutable completion/outbox commit together.
  state.systems[instance.solarSystemID]={...system,score:Math.max(0,Math.min(system.threshold,system.score+(faction===system.occupier ? -350:350)))};
  write(state);
  try {require("./fwQueryPayloads").publishSystemChange(before,authority.getSystem(instance.solarSystemID,state));}
  catch(error) {require("../../utils/logger").warn(`[FW] Committed state awaits client refresh: ${error.message}`);}
  return receipt;
}
function reconcileProgress(session,progress) {
  const characterID=trail().getCharacterID(session);
  for(const id of Object.keys(read().pending[characterID]||{})) {
    const receipt=read().receipts[id], participant=receipt?.participants.find(p=>p.characterID===characterID);
    if(!participant) throw new Error("FW pending receipt missing");
    const result=wallet().adjustCharacterWalletLPBalance(characterID,participant.issuerID,participant.lp,{idempotencyKey:id+":"+characterID,changeType:"earned"});
    if(!result.success) throw new Error(`FW LP settlement failed: ${result.errorMsg}`);
    const flushed=db.flushTableSync("lpWallets");
    if(!flushed.success) throw new Error(`FW LP flush failed: ${flushed.errorMsg}`);
    // The completion receipt, rather than LP changes or a finished timer,
    // proves participation. Keep this outbox entry until progression is durable.
    const achievement=require("../achievement/achievementRuntime").recordFwComplexCompletion(characterID,{
      receiptID:receipt.id,solarSystemID:receipt.systemID,
    });
    if(!achievement?.success) throw new Error(`FW achievement settlement failed: ${achievement?.errorMsg||"WRITE_ERROR"}`);
    if(!progress.fwReceipts?.[id]) {
      const step=catalog.getActiveStep(progress), e=participant.election;
      const eligible=e&&e.seasonID===campaign.SEASON_ID&&step&&step.index===e.index&&progress.candidateKey===e.candidateKey&&!progress.fw?.readyAtMs;
      if(eligible) {
        progress.fw={...progress.fw,count:Math.min(step.count,(progress.fw?.count||0)+1)};
        if(progress.fw.count===step.count) progress.fw.readyAtMs=receipt.completedAtMs;
      }
      progress.fwReceipts={...progress.fwReceipts,[id]:true};
      trail().saveProgress(characterID,progress);
      if(eligible) {
        session.sendNotification?.("OnChallengeProgressUpdate","charid",[step.challengeID,progress.fw.count]);
        if(progress.fw.readyAtMs) session.sendNotification?.("OnChallengeRewardsGranted","charid",[step.challengeID]);
      }
    }
    // Also fence an already-visible marker on replay: a previous campaign
    // flush may have thrown after its tentative write reached the cache.
    const progressFlushed=db.flushTableSync("campaignTrailProgress");
    if(!progressFlushed?.success) throw new Error(`FW progression flush failed: ${progressFlushed?.errorMsg||"WRITE_ERROR"}`);
    const state=read(); delete state.pending[characterID]?.[id];
    if(!Object.keys(state.pending[characterID]||{}).length) delete state.pending[characterID];
    write(state);
  }
}
function settle(receipt,sessions=[]) {
  for(const p of receipt.participants) {
    const session=sessions.find(s=>trail().getCharacterID(s)===p.characterID)||{characterID:p.characterID};
    reconcileProgress(session,trail().getProgress(p.characterID));
  }
}
function recoverPending() {
  for(const id of Object.keys(read().pending)) {
    try {reconcileProgress({characterID:Number(id)},trail().getProgress(Number(id)));}
    catch(error) {require("../../utils/logger").warn(`[FWOpen] Settlement for ${id} remains pending: ${error.message}`);}
  }
}
module.exports={read,systemState,getReceipt,commit,reconcileProgress,settle,recoverPending};
