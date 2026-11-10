"use strict";

// Preserve the 1.1.9 layouts and encounter keys for accepted attempts while
// ordinary Security bindings admit new attempts using their current scenes.
const scenes = require("./capturedSecurityLegacyScenes.json");

function getLegacyTemplateID(templateID) {
  return Object.hasOwn(scenes, templateID) ? templateID + ":legacy-1.1.9" : null;
}

function resolveSavedTemplateID(templateID, instance) {
  const scene = Object.hasOwn(scenes, templateID) && scenes[templateID];
  if (!scene || instance.runtimeFlags?.missionRuntime !== true ||
      instance.sourceDungeonID !== scene.sourceDungeonID) return templateID;
  const gates = instance.gateStatesByKey || {};
  // The captured layouts use gate:<object ID>. Earlier generated layouts use
  // client-gate:<object ID>, including before the pilot has visited the site.
  if (scene.siteSceneProfile.gateProfiles.some(gate => Object.hasOwn(gates, gate.gateKey))) {
    return getLegacyTemplateID(templateID);
  }
  return templateID;
}

function buildLegacyTemplate(template) {
  const templateID = getLegacyTemplateID(template.templateID);
  if (!templateID) return null;
  const scene = scenes[template.templateID];
  if (template.sourceDungeonID !== scene.sourceDungeonID) return null;
  const legacy = { ...template, ...scene, templateID };
  delete legacy.securityMissionBinding;
  delete legacy.retailCapture;
  return legacy;
}

module.exports = { buildLegacyTemplate, getLegacyTemplateID, resolveSavedTemplateID };
