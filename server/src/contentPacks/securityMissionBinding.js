"use strict";

const { createHash } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { productionMissionPolicy, isDisabledMissionIdentifier } = require("../config/productionMissionPolicy");

const CAPABILITY = "dungeon.templates.security-mission";
const BASIC_KILL = "agent.missionTemplatizedContent_BasicKillMission";
const trustedMarkers = new WeakSet();
const knownRequirements = new Set([
  CAPABILITY, "pack-security-mission-alias-support", "security-mission-admission-bindings",
  "security-mission-fetch-acquisition",
  "security-mission-room-arrival-objective-v1",
  "security-mission-recon-hazards-v1",
  "security-mission-rescue-objective-v1",
  "security-mission-native-containers-v1",
  "security-mission-native-object-lifecycle-v1",
  "security-mission-group-prerequisites-v1",
  "security-mission-native-npc-behavior-v1",
]);

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function positive(value) { return Number.isSafeInteger(value) && value > 0; }
function restriction(value) { return value == null || value === 0 || positive(value); }
function normalizedRestriction(value) { return value == null ? 0 : value; }
function isSecurityMissionAlias(template, id = template && template.templateID) {
  return String(id || "").startsWith("security-mission:") ||
    Boolean(template && (Object.hasOwn(template, "securityMission") || Object.hasOwn(template, "securityMissionBinding")));
}

// Optional, explicit policy on the installed alias. Empty encounters or saved
// population hints never opt a mission into arrival completion.
function getSecurityMissionRoomArrivalObjective(template) {
  const hints = template && template.populationHints;
  if (!object(hints) || !Object.hasOwn(hints, "reachRoomObjective")) return null;
  const policy = hints.reachRoomObjective;
  const fail = () => { throw new Error("invalid Security room arrival objective"); };
  if (!object(policy) || policy.version !== 1 || policy.kind !== "reach_room" ||
      policy.requireMissionOwner !== true || !/^room:[1-9]\d*$/.test(policy.roomKey)) fail();
  const completion = hints.completion;
  if (!object(completion) || completion.objectiveMode !== "reach_room" ||
      completion.roomKey !== policy.roomKey || completion.completeOnEncounterClear !== false ||
      completion.completeObjectiveOnEncounterClear !== false) fail();
  const roomID = Number(policy.roomKey.slice(5));
  const profiles = template.siteSceneProfile && template.siteSceneProfile.roomProfiles;
  const nativeRooms = template.clientDungeonContent && template.clientDungeonContent.rawDungeonRecord &&
    template.clientDungeonContent.rawDungeonRecord.rooms;
  if (!positive(roomID) || !Array.isArray(profiles) ||
      !profiles.some((room) => object(room) && room.roomKey === policy.roomKey && room.roomID === roomID) ||
      !object(nativeRooms) || !object(nativeRooms[roomID]) ||
      Object.hasOwn(nativeRooms[roomID], "roomID") && nativeRooms[roomID].roomID !== roomID) fail();
  const ref = typeof policy.validationTODORef === "string" &&
    /^\/securityMission\/validationTODOs\/(0|[1-9]\d*)$/.exec(policy.validationTODORef);
  const todo = ref && template.securityMission && template.securityMission.validationTODOs &&
    template.securityMission.validationTODOs[Number(ref[1])];
  if (!object(todo) || typeof todo.validationTODO !== "string" || !todo.validationTODO.startsWith("TODO:")) fail();
  return policy;
}

function getSecurityMissionRescueObjective(template) {
  const hints = template && template.populationHints;
  if (!object(hints) || !Object.hasOwn(hints, "rescueObjective")) return null;
  const policy = hints.rescueObjective;
  const fail = () => { throw new Error("invalid Security rescue objective"); };
  if (!object(policy) || policy.version !== 1 || policy.kind !== "container_transfer_then_combat" ||
      !positive(policy.sourceObjectID) || !positive(policy.destinationObjectID) ||
      policy.sourceObjectID === policy.destinationObjectID || !positive(policy.typeID) ||
      !positive(policy.quantity) || !Number.isFinite(policy.approachRangeMeters) || policy.approachRangeMeters <= 0 ||
      !Array.isArray(policy.encounterKeys) || !policy.encounterKeys.length ||
      new Set(policy.encounterKeys).size !== policy.encounterKeys.length) fail();
  if (policy.popups !== undefined && (!object(policy.popups) || Object.entries(policy.popups).some(([stage, popup]) =>
    !["approachedAtMs", "pickedUpAtMs", "deliveredAtMs", "completedAtMs"].includes(stage) ||
    !object(popup) || !positive(popup.titleID) || !positive(popup.textID)))) fail();
  const containers = hints.containers;
  const source = Array.isArray(containers) && containers.find((row) => row.dunObjectID === policy.sourceObjectID);
  const destination = Array.isArray(containers) && containers.find((row) => row.dunObjectID === policy.destinationObjectID);
  if (!source || !destination || source.count !== 1 || destination.count !== 1 ||
      !source.explicitLoot?.some((row) => row.typeID === policy.typeID && row.quantity === policy.quantity) ||
      !Array.isArray(destination.explicitLoot) || destination.explicitLoot.length !== 0 || destination.lootProfile) fail();
  const nativeRooms = template.clientDungeonContent?.rawDungeonRecord?.rooms || {};
  for (const container of [source, destination]) {
    const native = Object.values(nativeRooms).flatMap((room) => Object.values(room.objects || {}))
      .find((row) => row.objectID === container.dunObjectID);
    if (!native || native.typeID !== container.typeID) fail();
  }
  const plans = hints.encounters || [];
  if (!policy.encounterKeys.every((key) => typeof key === "string" && plans.some((row) => row.key === key)) ||
      !plans.some((row) => row.trigger === "mission_rescue_pickup") ||
      !plans.some((row) => row.trigger === "mission_rescue_delivery") ||
      hints.completion?.completeOnEncounterClear !== false ||
      hints.completion?.completeObjectiveOnEncounterClear !== false ||
      !template.requiresMechanics?.includes("security-mission-rescue-objective-v1")) fail();
  return policy;
}

function validateNativeObjectLifecycle(template) {
  const policy = template.populationHints?.nativeObjectLifecycle;
  if (policy === undefined) return;
  const fail = () => { throw new Error("invalid Security native object lifecycle"); };
  if (!object(policy) || policy.version !== 1 || !Array.isArray(policy.unresolvedActivationObjectIDs) ||
      !policy.unresolvedActivationObjectIDs.every(positive) ||
      !template.requiresMechanics?.includes("security-mission-native-object-lifecycle-v1")) fail();
  const props = template.populationHints.environmentProps || [];
  const native = Object.values(template.clientDungeonContent.rawDungeonRecord.rooms || {})
    .flatMap((room) => Object.values(room.objects || {}));
  for (const id of policy.unresolvedActivationObjectIDs) {
    const prop = props.find((row) => row.dunObjectID === id && row.objectTriggerSpawn === true);
    const source = native.find((row) => row.objectID === id);
    if (!prop || !source || Number(source.guardCommand?.objectTriggerSpawn) !== 1 || prop.typeID !== source.typeID) fail();
  }
}

function validateNativeFetchContainers(template) {
  const hints = template.populationHints || {};
  const containers = (hints.containers || []).filter((row) => row.role === "mission_fetch");
  if (!containers.length) return;
  const goal = template.securityMission.nativeMission.killMission;
  const acquisition = hints.fetchObjective;
  const fail = () => { throw new Error("invalid Security native fetch container"); };
  if (containers.length !== 1 || !template.requiresMechanics?.includes("security-mission-native-containers-v1") ||
      !positive(goal.objectiveTypeID) || !positive(goal.objectiveQuantity) ||
      acquisition?.mechanic !== "loot_container" || acquisition.objectiveTypeID !== goal.objectiveTypeID ||
      acquisition.objectiveQuantity !== goal.objectiveQuantity) fail();
  const container = containers[0];
  const nativeRooms = template.clientDungeonContent.rawDungeonRecord.rooms || {};
  const roomEntry = Object.entries(nativeRooms).find(([, row]) => Object.values(row.objects || {})
    .some((object) => object.objectID === container.dunObjectID));
  const room = roomEntry?.[1];
  const native = Object.values(room?.objects || {}).find((object) => object.objectID === container.dunObjectID);
  if (!native || native.typeID !== container.typeID || Number(native.guardCommand?.objectTriggerSpawn) === 1 ||
      container.roomKey !== `room:${room.roomID || roomEntry[0]}` || container.count !== 1 ||
      acquisition.triggerEntity?.dunObjectID !== container.dunObjectID ||
      !isDeepStrictEqual(container.explicitLoot, [{ typeID: goal.objectiveTypeID, quantity: goal.objectiveQuantity }]) ||
      container.lootProfile || (hints.environmentProps || []).some((row) => row.dunObjectID === container.dunObjectID)) fail();
}

// Pure semantic validation. The JSON safety/depth check remains the pack owner's.
// This validates evidence, not the historical accuracy of provisional estimates.
function validateSecurityMissionBinding(template, templateID = template && template.templateID) {
  const fail = (message) => { throw new Error(`invalid Security mission binding ${templateID}: ${message}`); };
  if (!object(template) || !object(template.securityMission)) fail("securityMission must be an object");
  const mission = template.securityMission;
  const native = mission.nativeMission;
  if (!positive(mission.missionID) || templateID !== `security-mission:${mission.missionID}` || template.templateID !== templateID) fail("alias identity mismatch");
  if (isDisabledMissionIdentifier(mission.missionID) ||
    productionMissionPolicy.goldenSecurityMissions.some((row) => row.missionID === mission.missionID) ||
    productionMissionPolicy.goldenMissionChains.some((chain) => chain.missionIDs.includes(mission.missionID))) fail("production policy owns this mission");
  if (!positive(mission.dungeonID) || template.sourceDungeonID !== mission.dungeonID) fail("native dungeon identity mismatch");
  if (!["combat", "mission"].includes(template.siteFamily)) fail("unsupported alias family");
  if (!Number.isInteger(mission.agentLevel) || mission.agentLevel < 1 || mission.agentLevel > 5 || template.missionLevel !== mission.agentLevel) fail("agentLevel must match missionLevel in 1..5");
  if (!object(native) || native.contentTemplate !== BASIC_KILL || !object(native.killMission) || native.killMission.dungeonID !== mission.dungeonID) fail("native BasicKill mission is required");
  if (Object.hasOwn(native, "missionID") && native.missionID !== mission.missionID) fail("native missionID mismatch");
  for (const field of ["factionID", "corporationID", "agentTypeID"]) if (!restriction(native[field])) fail(`invalid native ${field}`);
  if (!Object.hasOwn(mission, "agentFactionID") || !restriction(mission.agentFactionID) || normalizedRestriction(mission.agentFactionID) !== normalizedRestriction(native.factionID)) fail("native agent faction mismatch");
  const goal = native.killMission;
  const hasType = Object.hasOwn(goal, "objectiveTypeID"), hasQuantity = Object.hasOwn(goal, "objectiveQuantity");
  const noItemGoal = !hasType && !hasQuantity ||
    (goal.objectiveTypeID == null || goal.objectiveTypeID === 0) && goal.objectiveQuantity === 0;
  const fetchGoal = positive(goal.objectiveTypeID) && positive(goal.objectiveQuantity);
  if (!noItemGoal && !fetchGoal) fail("invalid native objective pair");
  if (!object(mission.objective) || !isDeepStrictEqual(mission.objective.native, goal)) fail("objective differs from native killMission");
  const content = template.clientDungeonContent;
  if (!object(content) || content.dungeonID !== mission.dungeonID || !object(content.rawDungeonRecord) || !Object.keys(content.rawDungeonRecord).length) fail("native dungeon content is missing");
  if (Object.hasOwn(content.rawDungeonRecord, "dungeonID") && content.rawDungeonRecord.dungeonID !== mission.dungeonID) fail("raw dungeon identity mismatch");
  if (typeof mission.localizedName !== "string" && mission.localizedName !== null) fail("invalid localizedName");
  if (!object(mission.localizedBriefings)) fail("invalid localizedBriefings");
  for (const entry of Object.values(mission.localizedBriefings)) {
    if (!object(entry) || !positive(entry.messageID) || typeof entry.text !== "string" && entry.text !== null) fail("invalid localized briefing");
  }
  if (!object(mission.rewards) || !object(mission.standings)) fail("reward and standing metadata are required");
  for (const field of ["isk", "bonusISK", "baseLP", "bonusMinutes"]) {
    const value = mission.rewards[field];
    if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER)) fail(`invalid reward ${field}`);
  }
  if (Object.hasOwn(mission.rewards, "nativeMissionRewards") &&
      !isDeepStrictEqual(mission.rewards.nativeMissionRewards, native.missionRewards ?? null)) {
    fail("invalid native mission reward evidence");
  }
  if (mission.rewards.nativeFixedLPFields !== undefined) {
    if (!object(mission.rewards.nativeFixedLPFields)) fail("invalid nativeFixedLPFields");
    for (const [key, value] of Object.entries(mission.rewards.nativeFixedLPFields)) {
      if (!["fixedLpRewardAlpha", "fixedLpRewardOmega"].includes(key) || !Number.isSafeInteger(value) || value < 0 || value !== native[key]) fail("invalid native fixed LP evidence");
    }
  }
  if (mission.standings.unit !== "raw_fraction") fail("standing unit must be raw_fraction");
  for (const field of ["corpRaw", "agentRaw", "factionRaw"]) {
    const value = mission.standings[field];
    if (value !== undefined && (!Number.isFinite(value) || Math.abs(value) > 1)) fail(`invalid standing ${field}`);
  }
  if (mission.evidenceClass !== "provisional" || !Array.isArray(mission.validationTODOs)) fail("provisional evidence and TODOs are required");
  for (const todo of mission.validationTODOs) {
    if (!object(todo) || typeof todo.fieldPath !== "string" || !todo.fieldPath.startsWith("/") || typeof todo.evidenceClass !== "string" || !todo.evidenceClass || !Array.isArray(todo.sourceRefs) || !todo.sourceRefs.every(object) || !Object.hasOwn(todo, "value") || typeof todo.validationTODO !== "string" || !todo.validationTODO.startsWith("TODO:")) fail("invalid validation TODO");
  }
  getSecurityMissionRoomArrivalObjective(template);
  getSecurityMissionRescueObjective(template);
  validateNativeObjectLifecycle(template);
  validateNativeFetchContainers(template);
  if (!Array.isArray(template.requiresMechanics) || !template.requiresMechanics.includes(CAPABILITY) || !Array.isArray(template.unsupportedMechanics)) fail("explicit mechanics accounting is required");
  for (const requirement of template.requiresMechanics) {
    if (typeof requirement !== "string" || !knownRequirements.has(requirement) && !template.unsupportedMechanics.some((item) => item && (item.kind === requirement || (item.requiredCapabilities || []).includes(requirement)))) fail("unaccounted required mechanic");
  }
  return mission;
}

function signature(template) {
  const { securityMissionBinding: _marker, ...content } = template;
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

// A pack's JSON cannot mint this process-local receipt, even with a forged
// _contentPack or securityMissionBinding field. Copying is explicit at rebuild.
function markInstalledSecurityMissionBinding(template) {
  validateSecurityMissionBinding(template);
  const marker = Object.freeze({ signature: signature(template) });
  trustedMarkers.add(marker);
  template.securityMissionBinding = marker;
}
function isInstalledSecurityMissionBinding(template) {
  const marker = template && template.securityMissionBinding;
  return Boolean(marker && trustedMarkers.has(marker) && object(template._contentPack) &&
    /^[a-f0-9]{64}$/.test(template._contentPack.packSha256 || "") &&
    /^[a-f0-9]{64}$/.test(template._contentPack.payloadSha256 || "") && marker.signature === signature(template));
}
function copyInstalledSecurityMissionMarker(source, target) {
  if (isInstalledSecurityMissionBinding(source)) target.securityMissionBinding = source.securityMissionBinding;
}

function matchesCanonicalMission(binding, record) {
  if (!binding || !record || record.contentTemplate !== BASIC_KILL || record.missionID !== binding.missionID || !isDeepStrictEqual(record.killMission, binding.nativeKillMission)) return false;
  return ["factionID", "corporationID", "agentTypeID"].every((key) =>
    normalizedRestriction(record[key]) === binding[key]);
}

module.exports = { CAPABILITY, isSecurityMissionAlias, validateSecurityMissionBinding,
  getSecurityMissionRoomArrivalObjective,
  getSecurityMissionRescueObjective,
  markInstalledSecurityMissionBinding, isInstalledSecurityMissionBinding,
  copyInstalledSecurityMissionMarker, matchesCanonicalMission };
