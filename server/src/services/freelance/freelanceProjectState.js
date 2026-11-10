"use strict";
// Native normalization mined from the John reference; persistence and funded
// settlement are owned by EveJS and never use the donor database adapters.
const { EventEmitter } = require("node:events");
const { randomUUID: createUuidString } = require("node:crypto");
const { createTableRepository } = require("../../gameStore/tableRepository");
const { getCharacterRecord } = require("../character/characterState");
const cloneValue = structuredClone;
const currentTimestampMs = () => Date.now();
const DAY_MS = 86400000, FILETIME_EPOCH_OFFSET = 116444736000000000n, HUNDRED_NS_PER_MS = 10000n;
const FREELANCE_PROJECTS_TABLE = "freelanceProjects";
const PROJECT_STATE = Object.freeze({UNSPECIFIED:0,ACTIVE:1,CLOSED:2,COMPLETED:3,EXPIRED:4});
const PARTICIPATION_STATE = Object.freeze({UNSPECIFIED:0,COMMITTED:1,KICKED:2,RESIGNED:3});
const DEFAULT_PROJECT_LIMITS = {maxActiveProjectsPerCorporation:100,maxActiveProjectsBroadcastPerSystem:20,maxActiveProjectsPerParticipant:3,maxCommittedParticipantsPerProject:100000};
const events = new EventEmitter();
const repository = createTableRepository("service:freelance");
let lane = Promise.resolve();
function runSerialized(fn) { const next=lane.catch(()=>{}).then(fn); lane=next; return next; }
function check(r) { if(!r?.success) throw new Error(r?.errorMsg||"FREELANCE_WRITE_FAILED"); return r.data; }
function readRoot() { repository.ensureTable(FREELANCE_PROJECTS_TABLE); return {version:1,projects:{},deliveries:{},...structuredClone(check(repository.read(FREELANCE_PROJECTS_TABLE,"/"))||{})}; }
function writeRoot(root) { const previous=readRoot(); check(repository.write(FREELANCE_PROJECTS_TABLE,"/",root)); try {check(repository.flushTableSync(FREELANCE_PROJECTS_TABLE));} catch(e) {repository.write(FREELANCE_PROJECTS_TABLE,"/",previous,{force:true});throw e;} return true; }
function fail(errorMsg) {return {success:false,errorMsg};}
function canManage(actor,corp) {
 const character=getCharacterRecord(actor); if(!character||Number(character.corporationID)!==Number(corp)) return false;
 const {getCorporationMemberRoleMask,CORP_ROLE_DIRECTOR,CORP_ROLE_PROJECT_MANAGER}=require("../corporation/corporationRuntimeState");
 const roles=getCorporationMemberRoleMask(corp,actor);return Boolean(roles&(CORP_ROLE_DIRECTOR|CORP_ROLE_PROJECT_MANAGER));
}
function getProject(root,id) {return root.projects[normalizeUuid(id)]||null;}
function isProjectActive(p,now=Date.now()){return p?.state===1&&p.deadlineMs>now;}
function toInteger(value, fallback = 0) {
  if (value && typeof value.toNumber === "function") {
    const numericLong = value.toNumber();
    return Number.isFinite(numericLong) ? Math.trunc(numericLong) : fallback;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}


function toPositiveInteger(value, fallback = 0) {
  const numeric = toInteger(value, fallback);
  return numeric > 0 ? numeric : fallback;
}


function toNumber(value, fallback = 0) {
  if (value && typeof value.toNumber === "function") {
    const numericLong = value.toNumber();
    return Number.isFinite(numericLong) ? numericLong : fallback;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}


function normalizeText(value, fallback = "") {
  if (value === undefined || value === null) {
    return fallback;
  }
  return String(value);
}


function normalizeUuid(value) {
  const text = String(value || "").trim().toLowerCase();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(text)) {
    return text;
  }
  const compact = text.replace(/-/g, "");
  if (/^[0-9a-f]{32}$/.test(compact)) {
    return [
      compact.slice(0, 8),
      compact.slice(8, 12),
      compact.slice(12, 16),
      compact.slice(16, 20),
      compact.slice(20, 32),
    ].join("-");
  }
  return null;
}


function fileTimeToMs(value) { try { const n=BigInt(String(value||0)); return n>0n?Number((n-FILETIME_EPOCH_OFFSET)/HUNDRED_NS_PER_MS):0; } catch { return 0; } }
function characterAgeDays(characterID, nowMs = currentTimestampMs()) {
  const record = getCharacterRecord(characterID);
  if (!record) {
    return 0;
  }
  const createdMs = fileTimeToMs(record.createDateTime || record.startDateTime);
  if (!createdMs) {
    return 0;
  }
  return Math.max(0, Math.floor((nowMs - createdMs) / DAY_MS));
}


function normalizeConfiguration(configuration) {
  const source = configuration && typeof configuration === "object" ? configuration : {};
  const contributionMethod =
    source.contribution_method && typeof source.contribution_method === "object"
      ? source.contribution_method
      : {};
  const version = source.version && typeof source.version === "object" ? source.version : {};
  return {
    contribution_method: {
      name: normalizeText(contributionMethod.name, "MineOre"),
    },
    version: {
      major: toInteger(version.major, 1),
      minor: toInteger(version.minor, 2),
      patch: toInteger(version.patch, 3),
      prerelease_tags: Array.isArray(version.prerelease_tags)
        ? version.prerelease_tags.map((tag) => normalizeText(tag))
        : [],
      build_tags: Array.isArray(version.build_tags)
        ? version.build_tags.map((tag) => normalizeText(tag))
        : [],
    },
    parameters: Array.isArray(source.parameters)
      ? source.parameters.map(normalizeParameterConfiguration)
      : [],
  };
}


function normalizeMatcherConfiguration(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    values: Array.isArray(source.values)
      ? source.values.map((entry) => ({
          value_type: normalizeText(entry && entry.value_type),
          values: Array.isArray(entry && entry.values)
            ? entry.values.map((raw) => normalizeText(raw)).filter(Boolean)
            : [],
        }))
      : [],
  };
}


function normalizeParameterConfiguration(parameter) {
  const source = parameter && typeof parameter === "object" ? parameter : {};
  const result = {
    key: normalizeText(source.key),
  };
  if (source.matcher) {
    result.matcher = normalizeMatcherConfiguration(source.matcher);
  } else if (source.options) {
    result.options = {
      selected: Array.isArray(source.options.selected)
        ? source.options.selected.map((entry) => normalizeText(entry)).filter(Boolean)
        : [],
    };
  } else if (source.boolean) {
    result.boolean = {
      value: Boolean(source.boolean.value),
    };
  } else if (source.corporation_item_delivery) {
    result.corporation_item_delivery = {
      item_type: normalizeMatcherConfiguration(
        source.corporation_item_delivery.item_type,
      ),
      corporation_office_location: normalizeMatcherConfiguration(
        source.corporation_item_delivery.corporation_office_location,
      ),
    };
  }
  return result;
}


function normalizeModifiers(modifiers) {
  const source = modifiers && typeof modifiers === "object" ? modifiers : {};
  const participantLimit = toInteger(
    source.contributionsPerParticipantLimit ??
      source.contributions_per_participant_limit,
    0,
  );
  const contributionLimit = toInteger(
    source.progressPerContributionLimit ?? source.progress_per_contribution_limit,
    0,
  );
  const multiplier = toNumber(source.scalarMultiplier ?? source.scalar_multiplier, 0);
  return {
    contributionsPerParticipantLimit: participantLimit > 0 ? participantLimit : null,
    progressPerContributionLimit: contributionLimit > 0 ? contributionLimit : null,
    scalarMultiplier: multiplier > 0 ? multiplier : 1,
  };
}


function normalizeRestrictions(restrictions) {
  const source = restrictions && typeof restrictions === "object" ? restrictions : {};
  const ageRestriction =
    source.age_restriction && typeof source.age_restriction === "object"
      ? source.age_restriction
      : {};
  const minAge = toInteger(ageRestriction.min_age, 0);
  const maxAge = toInteger(ageRestriction.max_age, 0);
  return {
    maxCommittedParticipants: Math.max(
      1,
      toInteger(source.maxCommittedParticipants ?? source.max_committed_participants, 1000),
    ),
    minCharacterAgeDays:
      toInteger(source.minCharacterAgeDays, 0) > 0
        ? toInteger(source.minCharacterAgeDays, 0)
        : minAge > 0
          ? minAge
          : null,
    maxCharacterAgeDays:
      toInteger(source.maxCharacterAgeDays, 0) > 0
        ? toInteger(source.maxCharacterAgeDays, 0)
        : maxAge > 0
          ? maxAge
          : null,
  };
}


function normalizeBroadcastSolarSystemIDs(ids) {
  return [
    ...new Set(
      (Array.isArray(ids) ? ids : [])
        .map((id) => toPositiveInteger(id, 0))
        .filter((id) => id > 0),
    ),
  ];
}


function normalizeProjectRecord(rawProject, projectID = null) {
  const source = rawProject && typeof rawProject === "object" ? rawProject : {};
  const id = normalizeUuid(source.projectID || source.id || projectID) || createUuidString();
  const modifiers = normalizeModifiers(source.contributionModifiers || {});
  const restrictions = normalizeRestrictions(source.participationRestrictions || {});
  return {
    projectID: id,
    ownerCorporationID: toPositiveInteger(source.ownerCorporationID, 0),
    creatorCharacterID: toPositiveInteger(source.creatorCharacterID, 0),
    state: toInteger(source.state, PROJECT_STATE.ACTIVE),
    name: normalizeText(source.name, "Freelance Project").slice(0, 80),
    description: normalizeText(source.description, "").slice(0, 1000),
    career: toInteger(source.career, 0),
    createdMs: toInteger(source.createdMs, currentTimestampMs()),
    deadlineMs: toInteger(source.deadlineMs, currentTimestampMs() + DAY_MS),
    finishTimeMs: toInteger(source.finishTimeMs, 0) || null,
    targetProgress: Math.max(1, toInteger(source.targetProgress, 1)),
    currentProgress: Math.max(0, toInteger(source.currentProgress, 0)),
    contributionModifiers: modifiers,
    participationRestrictions: restrictions,
    broadcastSolarSystemIDs: normalizeBroadcastSolarSystemIDs(
      source.broadcastSolarSystemIDs,
    ),
    reward: {
      payoutPerUnit: Math.max(
        0,
        toNumber(source.reward && source.reward.payoutPerUnit, 0),
      ),
    },
    expectedCost:
      source.expectedCost && typeof source.expectedCost === "object"
        ? cloneValue(source.expectedCost)
        : {},
    accessListID: toPositiveInteger(source.accessListID, 0) || null,
    noAccessList:
      source.noAccessList === false
        ? false
        : !toPositiveInteger(source.accessListID, 0),
    configuration: normalizeConfiguration(source.configuration),
    participants:
      source.participants && typeof source.participants === "object"
        ? normalizeParticipants(source.participants)
        : {},
    createdBy: normalizeText(source.createdBy || "api"),
    updatedMs: toInteger(source.updatedMs, currentTimestampMs()),
  };
}


function normalizeParticipants(sourceParticipants) {
  const result = {};
  for (const [key, value] of Object.entries(sourceParticipants || {})) {
    const characterID = toPositiveInteger(
      value && value.characterID ? value.characterID : key,
      0,
    );
    if (!characterID) {
      continue;
    }
    result[String(characterID)] = normalizeParticipantRecord(value, characterID);
  }
  return result;
}


function normalizeParticipantRecord(rawParticipant, characterID) {
  const source =
    rawParticipant && typeof rawParticipant === "object" ? rawParticipant : {};
  return {
    characterID: toPositiveInteger(source.characterID || characterID, characterID),
    state: toInteger(source.state, PARTICIPATION_STATE.UNSPECIFIED),
    progress: Math.max(0, toInteger(source.progress, 0)),
    unitsUnredeemed: Math.max(0, toInteger(source.unitsUnredeemed, 0)),
    redeemedUnits: Math.max(0, toInteger(source.redeemedUnits, 0)),
    contributionsCount: Math.max(0, toInteger(source.contributionsCount, 0)),
    committedAtMs: toInteger(source.committedAtMs, 0) || null,
    leftAtMs: toInteger(source.leftAtMs, 0) || null,
    lastContributionAtMs: toInteger(source.lastContributionAtMs, 0) || null,
  };
}


function getCommittedParticipantCount(project) {
  return Object.values(project.participants || {}).filter(
    (participant) => participant.state === PARTICIPATION_STATE.COMMITTED,
  ).length;
}


function getTotalParticipantCount(project) {
  return Object.keys(project.participants || {}).length;
}


function getTotalContributorCount(project) {
  return Object.values(project.participants || {}).filter(
    (participant) => toInteger(participant.progress, 0) > 0,
  ).length;
}


function getParticipant(project, characterID) {
  const numericCharacterID = toPositiveInteger(characterID, 0);
  if (!numericCharacterID) {
    return null;
  }
  const key = String(numericCharacterID);
  if (!project.participants || !project.participants[key]) {
    return null;
  }
  return { ...project.participants[key], ...normalizeParticipantRecord(project.participants[key], numericCharacterID) };
}


function getOrCreateParticipant(project, characterID) {
  const numericCharacterID = toPositiveInteger(characterID, 0);
  if (!project.participants[String(numericCharacterID)]) {
    project.participants[String(numericCharacterID)] =
      normalizeParticipantRecord({}, numericCharacterID);
  }
  return project.participants[String(numericCharacterID)];
}


function getRemainingParticipantProgress(project, participant) {
  const totalLimit =
    project.contributionModifiers.contributionsPerParticipantLimit;
  if (totalLimit === null || totalLimit === undefined) {
    return Number.MAX_SAFE_INTEGER;
  }
  return Math.max(0, toInteger(totalLimit, 0) - toInteger(participant.progress, 0));
}


function getContributionMaxQuantity(project, participant) {
  const projectRemaining = Math.max(
    0,
    toInteger(project.targetProgress, 0) - toInteger(project.currentProgress, 0),
  );
  const participantRemaining = getRemainingParticipantProgress(project, participant);
  const perContributionLimit =
    project.contributionModifiers.progressPerContributionLimit;
  const perContributionRemaining =
    perContributionLimit === null || perContributionLimit === undefined
      ? Number.MAX_SAFE_INTEGER
      : Math.max(0, toInteger(perContributionLimit, 0));
  return Math.max(
    0,
    Math.min(projectRemaining, participantRemaining, perContributionRemaining),
  );
}


function settleOwner() {return require("./freelanceSettlement").createFreelanceSettlement({readRoot,writeRoot,events});}
function deliveryOwner() {return require("./freelanceDelivery").createFreelanceDelivery({readRoot,writeRoot,runSerialized,events,getContributionMaxQuantity});}
function currencyCents(value) {
 try {const units=BigInt(value?.units||0),nanos=Number(value?.nanos||0);if(units<0n||!Number.isInteger(nanos)||nanos<0||nanos>=1000000000||nanos%10000000!==0)return null;return units*100n+BigInt(nanos/10000000);}catch{return null;}
}
function validDeliveryConfiguration(configuration) {
 const parameters=configuration?.parameters;
 if(!Array.isArray(parameters)||parameters.length!==1)return false;
 const parameter=parameters[0],delivery=parameter?.corporation_item_delivery;
 if(parameter.key!=="corporation_item_delivery"||!delivery||parameter.matcher||parameter.options||parameter.boolean)return false;
 const validMatcher=(matcher,allowed)=>matcher===undefined||matcher&&typeof matcher==="object"&&Array.isArray(matcher.values)&&matcher.values.length<=10&&matcher.values.every(entry=>allowed.includes(entry?.value_type)&&Array.isArray(entry.values)&&entry.values.length<=10&&entry.values.every(value=>/^\d+$/.test(String(value))&&Number.isSafeInteger(Number(value))&&Number(value)>0));
 return validMatcher(delivery.item_type,["item_type","item_group"])&&validMatcher(delivery.corporation_office_location,["station"]);
}
function canFund(actor,corp) {
 const {getCorporationMemberRoleMask,getCorporationWalletDivisionTakeRole,CORP_ROLE_DIRECTOR}=require("../corporation/corporationRuntimeState");
 const roles=getCorporationMemberRoleMask(corp,actor),take=getCorporationWalletDivisionTakeRole(1000);
 return Boolean(roles&CORP_ROLE_DIRECTOR)||Boolean(take!==null&&roles&take);
}
async function createProject(input={},limits=DEFAULT_PROJECT_LIMITS) {return runSerialized(async()=>{
 const actor=Number(input.creatorCharacterID),corp=Number(input.ownerCorporationID);
 if(!canManage(actor,corp)||!canFund(actor,corp))return fail("ACCESS_DENIED");
 if(input.accessListID||input.noAccessList===false)return fail("UNSUPPORTED_ACCESS_LIST");
 if(input.configuration?.contribution_method?.name!=="DeliverItem")return fail("UNSUPPORTED_CONTRIBUTION_METHOD");
 if(!validDeliveryConfiguration(input.configuration))return fail("INVALID_DELIVERY_CONFIGURATION");
 const modifiers=input.contributionModifiers||{};
 if(modifiers.scalarMultiplier!==undefined&&Number(modifiers.scalarMultiplier)!==1||[modifiers.contributionsPerParticipantLimit,modifiers.progressPerContributionLimit].some(value=>value!==null&&value!==undefined&&(!Number.isSafeInteger(Number(value))||Number(value)<=0)))return fail("UNSUPPORTED_PROJECT_LIMITS");
 const target=Number(input.targetProgress),now=Date.now(),deadline=Number(input.deadlineMs);
 let payout=Number(input.payoutPerUnit);
 if(input.payoutCurrency) {try { const units=BigInt(input.payoutCurrency.units||0),nanos=Number(input.payoutCurrency.nanos||0); if(units<0n||!Number.isInteger(nanos)||nanos<0||nanos>=1000000000||nanos%10000000!==0)return fail("INVALID_PAYOUT");const c=units*100n+BigInt(nanos/10000000); if(c>BigInt(Number.MAX_SAFE_INTEGER))return fail("INVALID_PAYOUT");payout=Number(c)/100;}catch{return fail("INVALID_PAYOUT");} }

 const priceCents=Math.round(payout*100),escrowCents=target*priceCents;
 if(!Number.isSafeInteger(target)||target<1||!Number.isFinite(payout)||payout<0||Math.abs(payout*100-priceCents)>1e-6||!Number.isSafeInteger(escrowCents)||escrowCents>1e14||deadline<=now||deadline>now+31536000000||!Number.isSafeInteger(deadline))return fail("INVALID_PROJECT_CONFIGURATION");
 const p=normalizeProjectRecord({...input,projectID:createUuidString(),state:0,createdMs:now,deadlineMs:deadline,targetProgress:target,currentProgress:0,reward:{payoutPerUnit:payout},participants:{}});
 if(p.contributionModifiers.scalarMultiplier!==1||p.broadcastSolarSystemIDs.length>20||p.participationRestrictions.maxCommittedParticipants>100000)return fail("UNSUPPORTED_PROJECT_LIMITS");
 const root=readRoot();
 if(input.requestID) { const prior=Object.values(root.projects).find(p=>p.creatorCharacterID===actor&&p.requestID===String(input.requestID)); if(prior){ if(prior.creationFingerprint!==JSON.stringify(input))return fail("REQUEST_CONFLICT");const result=await settleOwner().fundProject(prior.projectID);await require("./freelanceRuntime").scheduleProject(readRoot().projects[prior.projectID]);return result?.success===false?result:{success:true,data:{project:readRoot().projects[prior.projectID]}};}}
 const active=Object.values(root.projects).filter(p=>p.state===0||isProjectActive(p));
 if(active.filter(p=>p.ownerCorporationID===corp).length>=Math.min(limits.maxActiveProjectsPerCorporation||100,100))return fail("MAX_ACTIVE_PROJECTS_PER_CORPORATION");
 if(p.broadcastSolarSystemIDs.some(id=>active.filter(p=>p.broadcastSolarSystemIDs.includes(id)).length>=20))return fail("MAX_ACTIVE_PROJECTS_BROADCAST_PER_SYSTEM");
 const days=Math.max(1,Math.ceil(Math.floor((deadline-now)/1000)/86400));
 const baseCents=days*75000*100,broadcastCents=days*100000*p.broadcastSolarSystemIDs.length*100;
 const feeCents=baseCents+broadcastCents;
 if(input.expectedCost&&Object.keys(input.expectedCost).length) {
  const expected={base_fee:baseCents,broadcasting_fee:broadcastCents,reward_deposit:escrowCents,total_cost:feeCents+escrowCents};
  if(Object.entries(expected).some(([key,value])=>!input.expectedCost[key]||currencyCents(input.expectedCost[key])!==BigInt(value)))return fail("OUTDATED_PROJECT_COST");
 }
 p.reward.payoutPerUnitCents=priceCents;
 p.funding={state:"pending",cents:escrowCents,escrowCents,totalCents:escrowCents+feeCents,feeCents,payerCorporationID:corp,accountKey:1000};
 p.requestID=String(input.requestID||p.projectID);p.creationFingerprint=JSON.stringify(input);
 root.projects[p.projectID]=p;writeRoot(root);
 await require("./freelanceRuntime").scheduleProject(p);
 const result=await settleOwner().fundProject(p.projectID);
 if(result?.success===false)return result;
 const project=readRoot().projects[p.projectID];return {success:true,data:{project}};
});}
function getProjectDetails(id,actor,options={}) {
 const project=getProject(readRoot(),id);if(!project||project.state===0)return fail("PROJECT_NOT_FOUND");
 if(!getCharacterRecord(actor)||options.managerOnly&&!canManage(actor,project.ownerCorporationID))return fail("ACCESS_DENIED");
 return {success:true,data:{project,participant:getParticipant(project,actor)}};
}
function commitProject(id,actor,limits=DEFAULT_PROJECT_LIMITS){return runSerialized(async()=>{
 const root=readRoot(),p=getProject(root,id);if(!p)return fail("PROJECT_NOT_FOUND");if(!getCharacterRecord(actor))return fail("INVALID_CHARACTER");
 if(!isProjectActive(p))return fail("INVALID_PROJECT_STATE");
 const old=getParticipant(p,actor);if(old?.state===1)return {success:true,data:{project:p,participant:old}};
 if(old?.state===2)return fail("ACCESS_DENIED");
 if(getCommittedParticipantCount(p)>=p.participationRestrictions.maxCommittedParticipants)return fail("MAX_COMMITTED_PARTICIPANTS_PER_PROJECT");
 if(Object.values(root.projects).filter(p=>isProjectActive(p)&&p.participants[actor]?.state===1).length>=Math.min(limits.maxActiveProjectsPerParticipant||3,3))return fail("MAX_PROJECTS_COMMITTED_PER_PARTICIPANT");
 const age=characterAgeDays(actor),r=p.participationRestrictions;if(r.minCharacterAgeDays!==null&&age<r.minCharacterAgeDays||r.maxCharacterAgeDays!==null&&age>r.maxCharacterAgeDays)return fail("INVALID_CHARACTER_AGE");
 const participant=getOrCreateParticipant(p,actor);participant.state=1;participant.committedAtMs=Date.now();participant.leftAtMs=null;writeRoot(root);
 events.emit("participant-added",{project:p,characterID:actor,committedParticipants:getCommittedParticipantCount(p),totalParticipants:getTotalParticipantCount(p)});return {success:true,data:{project:p,participant}};
});}
function pendingDelivery(root,id){return Object.values(root.deliveries).some(d=>d.projectID===id&&!['completed','succeeded','failed'].includes(d.state||d.status));}
function leave(id,actor,target,state){return runSerialized(async()=>{
 const root=readRoot(),p=getProject(root,id);if(!p)return fail("PROJECT_NOT_FOUND");
 if(state===2&&!canManage(actor,p.ownerCorporationID))return fail("ACCESS_DENIED");
 if(pendingDelivery(root,id))return fail("DELIVERY_PENDING");
 const participant=getParticipant(p,target);if(!participant||participant.state!==1)return fail("INVALID_PARTICIPATION_STATE");
 participant.state=state;participant.leftAtMs=Date.now();p.participants[target]=participant;writeRoot(root);
 if(state===2)events.emit("participant-kicked",{project:p,characterID:target});events.emit("participant-removed",{project:p,characterID:target,committedParticipants:getCommittedParticipantCount(p)});
 return {success:true,data:{project:p,participant}};
});}
const resignProject=(id,actor)=>leave(id,actor,actor,3);
const kickParticipant=(id,target,actor)=>leave(id,actor,target,2);
function closeProject(id,actor){return runSerialized(async()=>{
 const root=readRoot(),p=getProject(root,id);if(!p)return fail("PROJECT_NOT_FOUND");if(!canManage(actor,p.ownerCorporationID))return fail("ACCESS_DENIED");if(pendingDelivery(root,id))return fail("DELIVERY_PENDING");
 if(p.state===1){p.state=2;p.finishTimeMs=Date.now();writeRoot(root);events.emit("project-closed",{project:p,characterID:actor});}
 if(p.state===0)return fail("FUNDING_PENDING");
 const refund=await settleOwner().refundProject(id);await require("./freelanceRuntime").scheduleProject(readRoot().projects[id]);if(!refund?.success)return refund;return {success:true,data:{project:readRoot().projects[id]}};
});}
function all(actor){return getCharacterRecord(actor)?Object.values(readRoot().projects).filter(p=>p.state!==0):[];}
const listActiveForCorporation=(corp,actor)=>all(actor).filter(p=>p.ownerCorporationID===Number(corp)&&isProjectActive(p));
const listActiveManaged=(corp,actor)=>canManage(actor,corp)?listActiveForCorporation(corp,actor):[];
const listCommitted=actor=>all(actor).filter(p=>isProjectActive(p)&&p.participants[actor]?.state===1);
const listUnredeemed=actor=>all(actor).filter(p=>p.participants[actor]?.unitsUnredeemed>0);
function listBroadcasted(ids,actor){return Object.fromEntries(ids.map(id=>[id,all(actor).filter(p=>isProjectActive(p)&&p.broadcastSolarSystemIDs.includes(Number(id)))]));}
const listInactive=(start,duration,corp,actor)=>all(actor).filter(p=>p.state>1&&p.ownerCorporationID===Number(corp)&&(!start||p.finishTimeMs>=start)&&(!duration||p.finishTimeMs<=start+duration));
function getParticipants(id,actor){const r=getProjectDetails(id,actor,{managerOnly:true});return r.success?{success:true,data:{project:r.data.project,participants:Object.values(r.data.project.participants)}}:r;}
function getStats(ids,actor){const projects=all(actor);return {stats:projects.filter(p=>ids.includes(p.projectID)).map(project=>({project,currentProgress:project.currentProgress,committedParticipants:getCommittedParticipantCount(project),totalParticipants:getTotalParticipantCount(project),totalContributors:getTotalContributorCount(project)})),missing:ids.filter(id=>!projects.some(p=>p.projectID===id))};}
module.exports={FREELANCE_PROJECTS_TABLE,DEFAULT_PROJECT_LIMITS,PROJECT_STATE,PARTICIPATION_STATE,events,readRoot,writeRoot,runSerialized,canManage,
createProject,commitProject,closeProject,resignProject,kickParticipant,getProjectDetails,getParticipants,getStats,listActiveForCorporation,listActiveManaged,listCommitted,listUnredeemed,listBroadcasted,listInactive,getContributionMaxQuantity,getCommittedParticipantCount,getTotalParticipantCount,getTotalContributorCount,
redeemRewards:(id,actor)=>runSerialized(async()=>{const result=await settleOwner().redeemRewards(id,actor);const p=readRoot().projects[id];if(p)await require("./freelanceRuntime").scheduleProject(p);return result;}),
deliverItem:async input=>{const result=await deliveryOwner().deliverItem(input);const p=readRoot().projects[input.projectID];if(p)await require("./freelanceRuntime").scheduleProject(p);return result;},getDeliveryStatus:(id,actor)=>deliveryOwner().getDeliveryStatus(id,actor)};
