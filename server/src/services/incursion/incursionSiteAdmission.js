"use strict";

const model = require("./incursionSiteModel");
const { SITES, fingerprint, fail } = require("./incursionLifecycleContract");
const { getGroupReward, CATALOG_IDENTITY } = require("../rewards/groupRewardCatalog");
const CAPABILITY = "incursion-sites-v2";
const ARCHETYPE = Object.freeze({ scout: 60, vanguard: 61, assault: 62, headquarters: 63, boss: 64 });
const SCENE = Object.freeze({ scout: 4, vanguard: 3, assault: 2, headquarters: 1, boss: 1 });
const definition = dungeonID => SITES.find(row => row.dungeonID === Number(dungeonID) && row.dungeonID !== 5166) || null;
const templateID = dungeonID => `evejs-incursion-sites:${dungeonID}`;
const positive = value => Number.isSafeInteger(value) && value > 0;
function isTemplate(template) {
  const native = definition(template?.sourceDungeonID), policy = template?.populationHints?.incursionPolicy;
  return Boolean(native && template.templateID === templateID(native.dungeonID) && template.archetypeID === ARCHETYPE[native.role] &&
    template.factionID === native.factionID && template.requiresMechanics?.includes(CAPABILITY) &&
    policy?.schema === model.SCHEMA && policy.version === 2 && policy.dungeonID === native.dungeonID &&
    policy.rewardGroupID === native.rewardGroupID);
}
function validatePresentation(policy, instanceOrTemplate) {
  const entry = policy.presentation?.entry;
  if (policy.presentation?.version !== 2 || policy.presentation.physicalObjectiveMarkers !== false ||
      !positive(entry?.objectID) || !positive(entry.typeID) || typeof entry.roomKey !== "string" ||
      ![entry.positionOffset?.x, entry.positionOffset?.y, entry.positionOffset?.z].every(Number.isFinite) ||
      instanceOrTemplate.entryObjectTypeID !== entry.typeID || !Array.isArray(policy.roomKeys) ||
      !policy.roomKeys.length || new Set(policy.roomKeys).size !== policy.roomKeys.length ||
      policy.stages.some(stage => !policy.roomKeys.includes(stage.roomKey))) fail("INCURSION_SITE_PRESENTATION_INVALID");
  return entry;
}
function freezePopulationHints(template, options = {}) {
  if (!isTemplate(template)) fail("INCURSION_TEMPLATE_INVALID");
  const id = options.metadata?.incursionAdmission;
  if (options.runtimeFlags?.incursionRuntime !== true || !["tale-slot", "tale-final"].includes(id?.placement) ||
      !positive(id.taleID) || !positive(id.poolGroupID) || options.durable !== true ||
      Object.hasOwn(options.spawnState || {}, "populationHints")) fail("INCURSION_ADMISSION_REQUIRED");
  const lifecycle = require("./incursionLifecycle");
  const approved = id.placement === "tale-final" ? lifecycle.finalAdmission({ ...id, solarSystemID: options.solarSystemID }, options.nowMs)
    : lifecycle.siteAdmission({ ...id, solarSystemID: options.solarSystemID }, options.nowMs);
  const binding = approved.slot || approved.boss;
  if (binding.dungeonID !== template.sourceDungeonID || fingerprint(binding.position) !== fingerprint(options.position)) {
    fail("INCURSION_SITE_ADMISSION_REQUIRED");
  }
  const hints = structuredClone(template.populationHints), policy = hints.incursionPolicy;
  validatePresentation(policy, template);
  const reward = getGroupReward(policy.rewardGroupID);
  if (!reward) fail("INCURSION_REWARD_UNAVAILABLE");
  policy.rewardDefinition = structuredClone(reward);
  policy.catalogIdentity = structuredClone(CATALOG_IDENTITY);
  policy.participation = require("./incursionParticipation").policy();
  require("./incursionSiteMechanics").validatePolicy(policy);
  return hints;
}
function admittedPolicy(instance) {
  const policy = instance?.spawnState?.populationHints?.incursionPolicy, native = definition(instance?.sourceDungeonID);
  if (!native || instance?.runtimeFlags?.incursionRuntime !== true || instance.templateID !== templateID(native.dungeonID) ||
      policy?.schema !== model.SCHEMA || policy.version !== 2) return null;
  if (policy.dungeonID !== native.dungeonID || policy.rewardGroupID !== native.rewardGroupID) fail("INCURSION_SITE_POLICY_INVALID");
  validatePresentation(policy, instance);
  return require("./incursionSiteMechanics").validatePolicy(policy);
}
function operationIdentity(instance) {
  const policy = admittedPolicy(instance), id = instance?.metadata?.incursionAdmission;
  if (!policy || !id || !positive(id.poolGroupID) || !positive(id.taleID) ||
      !["tale-slot", "tale-final"].includes(id.placement)) fail("INCURSION_ADMISSION_REQUIRED");
  return { instanceID: instance.instanceID, operationID: `incursion-v2:${instance.instanceID}`,
    poolGroupID: id.poolGroupID, taleID: id.taleID, solarSystemID: instance.solarSystemID,
    rewardID: policy.rewardGroupID, dungeonID: policy.dungeonID,
    dungeonName: instance.metadata?.label || policy.name, securityBand: id.securityBand,
    placement: id.placement, generation: id.generation, slotID: id.slotID,
    slotOperationID: id.slotOperationID, incarnation: id.incarnation };
}
module.exports = { CAPABILITY, ARCHETYPE, SCENE, definition, templateID, isTemplate,
  freezePopulationHints, admittedPolicy, operationIdentity, validatePresentation };
