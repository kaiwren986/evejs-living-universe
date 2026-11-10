"use strict";

const { getGroupReward, CATALOG_IDENTITY } = require("../rewards/groupRewardCatalog");
const model = require("./incursionEncounterModel");
const TEMPLATE_ID = "evejs-incursion-vanguard:nation-commander-outpost";
const CAPABILITY = "incursion-vanguard-v1";
const positive = value => Number.isSafeInteger(value) && value > 0;
const clone = value => structuredClone(value);
function fail(code) { const error = new Error(code); error.code = code; throw error; }

function isTemplate(template) {
  if (require("./incursionSiteAdmission").isTemplate(template)) return true;
  return template?.templateID === TEMPLATE_ID && Number(template.sourceDungeonID) === 5166 &&
    template.requiresMechanics?.includes(CAPABILITY) && template.populationHints?.incursionPolicy?.version === 1;
}
function isSharedTemplate(template) {
  if (require("./incursionSiteAdmission").isTemplate(template)) {
    try { require("./incursionSiteAdmission").validatePresentation(template.populationHints.incursionPolicy, template); return true; }
    catch (_) { return false; }
  }
  return isTemplate(template) && template.requiresMechanics.includes("incursion-vanguard-entry-presentation-v1") &&
    template.populationHints.incursionPolicy.presentation?.version === 1;
}

function freezePopulationHints(template, options = {}) {
  if (require("./incursionSiteAdmission").isTemplate(template)) return require("./incursionSiteAdmission").freezePopulationHints(template, options);
  if (!isTemplate(template)) fail("INCURSION_TEMPLATE_INVALID");
  const admission = options.metadata?.incursionAdmission;
  if (options.runtimeFlags?.incursionRuntime !== true || !["controlled-phase7", "tale-slot"].includes(admission?.placement) ||
      !positive(admission.poolGroupID) || !positive(admission.taleID) ||
      !["high", "low", "null"].includes(admission.securityBand)) fail("INCURSION_ADMISSION_REQUIRED");
  if (admission.placement === "tale-slot") {
    if (!isSharedTemplate(template)) fail("INCURSION_SITE_ENTRY_PRESENTATION_REQUIRED");
    const { slot } = require("./incursionLifecycle").siteAdmission({ ...admission, solarSystemID: options.solarSystemID }, options.nowMs);
    if (options.durable !== true || fingerprintPosition(options.position) !== fingerprintPosition(slot.position)) fail("INCURSION_SITE_ADMISSION_REQUIRED");
  }
  if (Object.hasOwn(options.spawnState || {}, "populationHints")) fail("INCURSION_NEW_ADMISSION_REQUIRES_CURRENT_POLICY");
  const hints = clone(template.populationHints), policy = hints.incursionPolicy;
  const reward = getGroupReward(policy.rewardGroupID);
  if (!reward) fail("INCURSION_REWARD_UNAVAILABLE");
  policy.rewardDefinition = clone(reward);
  policy.catalogIdentity = clone(CATALOG_IDENTITY);
  policy.participation = require("./incursionParticipation").policy();
  model.validatePolicy(policy);
  return hints;
}

function admittedPolicy(instance) {
  const policy = instance?.spawnState?.populationHints?.incursionPolicy;
  if (policy?.schema === "evejs.incursion-site-policy.v2") return require("./incursionSiteAdmission").admittedPolicy(instance);
  if (instance?.runtimeFlags?.incursionRuntime !== true || instance.templateID !== TEMPLATE_ID ||
      Number(instance.sourceDungeonID) !== 5166 || policy?.schema !== "evejs.incursion-vanguard-policy.v1") return null;
  return model.validatePolicy(policy);
}

function operationIdentity(instance) {
  if (instance?.spawnState?.populationHints?.incursionPolicy?.schema === "evejs.incursion-site-policy.v2") {
    return require("./incursionSiteAdmission").operationIdentity(instance);
  }
  const policy = admittedPolicy(instance), admission = instance.metadata?.incursionAdmission;
  if (!policy || !positive(admission?.poolGroupID) || !positive(admission?.taleID)) fail("INCURSION_ADMISSION_REQUIRED");
  return { instanceID: instance.instanceID, operationID: `vanguard-v1:${instance.instanceID}`,
    poolGroupID: admission.poolGroupID, taleID: admission.taleID, solarSystemID: instance.solarSystemID,
    rewardID: policy.rewardGroupID, dungeonName: "Nation Commander Outpost", securityBand: admission.securityBand,
    ...(admission.placement === "tale-slot" ? { placement: admission.placement, generation: admission.generation,
      slotID: admission.slotID, slotOperationID: admission.slotOperationID, incarnation: admission.incarnation } : {}) };
}
function fingerprintPosition(position) { return JSON.stringify([position?.x, position?.y, position?.z]); }

function controlledPlacement(siteID, solarSystemID) {
  if (!positive(siteID) || !positive(solarSystemID)) fail("INCURSION_ADMISSION_REQUIRED");
  const system = require("../../space/worldData").getSolarSystemByID(solarSystemID);
  const security = Number(system?.security ?? system?.securityStatus);
  if (!system || !Number.isFinite(security)) fail("INCURSION_SECURITY_CONTEXT_MISSING");
  // The existing dungeon owner allocates this globally unique, durable manual
  // site identity. Each controlled placement has a separate LP pool/tale; these
  // dynamic identities are unrelated to native reward catalog group 1.
  return { placement: "controlled-phase7", poolGroupID: siteID, taleID: siteID,
    securityBand: security >= 0.45 ? "high" : security > 0 ? "low" : "null" };
}

module.exports = { TEMPLATE_ID, CAPABILITY, isTemplate, isSharedTemplate, freezePopulationHints, admittedPolicy, operationIdentity, controlledPlacement };
