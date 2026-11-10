"use strict";

// Adapted from ciefa/evejs-ciefa-fork 831e412ae393c46b43bfb73388270faf31dc6070.
// The source owns an immutable snapshot, replaced whenever its inputs change.
// Applicability depends only on static system/region/constellation/class data;
// enable overrides and dynamic gate rules stay outside this index.
function createStartupRuleIndex(listRules, appliesToSystem) {
  let source = null;
  let bySystem = new Map();
  return (systemID) => {
    const rules = listRules();
    if (rules !== source) {
      source = rules;
      bySystem = new Map();
    }
    if (!bySystem.has(systemID)) {
      bySystem.set(systemID, Object.freeze(rules.filter((rule) => appliesToSystem(rule, systemID))));
    }
    return bySystem.get(systemID);
  };
}

function freezeDeep(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeDeep(child);
  }
  return value;
}

function positiveInt(value) {
  const number = Math.trunc(Number(value) || 0);
  return number > 0 ? number : 0;
}

// Capture keys for one synchronous pass, without freezing the live controllers.
// A subsequent pass must build a new index: callers can mutate live aliases.
function indexStartupControllers(controllers) {
  const bySystem = new Map();
  for (const controller of controllers) {
    const systemID = positiveInt(controller && controller.systemID);
    const ruleID = String(controller && controller.startupRuleID || "").trim();
    const anchorID = positiveInt(controller && controller.anchorID);
    if (!bySystem.has(systemID)) bySystem.set(systemID, new Map());
    const byRule = bySystem.get(systemID);
    if (!byRule.has(ruleID)) byRule.set(ruleID, new Map());
    const byAnchor = byRule.get(ruleID);
    if (!byAnchor.has(anchorID)) byAnchor.set(anchorID, []);
    byAnchor.get(anchorID).push(controller);
  }
  return (systemID, ruleID, anchorID) =>
    bySystem.get(positiveInt(systemID))?.get(String(ruleID || "").trim())?.get(positiveInt(anchorID)) || [];
}

function createStartupControllerPass(source) {
  let registryIndex = null;
  let registryRevision = null;
  const nativeIndexes = new Map();
  return {
    registryForAnchor(systemID, ruleID, anchorID) {
      if (!registryIndex || registryRevision !== source.registryRevision()) {
        // listControllers also repairs externally moved system IDs. Always read
        // it on the first query of a new pass, regardless of the revision.
        registryIndex = indexStartupControllers(source.listControllers());
        registryRevision = source.registryRevision();
      }
      return registryIndex(systemID, ruleID, anchorID);
    },
    nativeForAnchor(systemID, ruleID, anchorID) {
      const rows = source.listNativeControllersForSystem(systemID);
      let cached = nativeIndexes.get(systemID);
      if (!cached || cached.rows !== rows) {
        cached = { rows, index: indexStartupControllers(rows) };
        nativeIndexes.set(systemID, cached);
      }
      return cached.index(systemID, ruleID, anchorID);
    },
  };
}

module.exports = { createStartupRuleIndex, createStartupControllerPass, freezeDeep };
