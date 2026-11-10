"use strict";

// Offline presentation repair only. A reference site's rocks and room keys
// differ from its client counterpart, so its template identity must survive.
const ACTIVE_STATES = new Set(["seeded", "active", "paused"]);

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveID(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function normalizeName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function getSovProspectingRepairTemplateName(template) {
  return normalizeName(template && (template.resolvedName || template.name));
}

function isValidSovProspectingClientNameTemplate(template) {
  return record(template) && template.siteFamily === "ore" && template.siteKind === "anomaly" &&
    positiveID(template.sourceDungeonID) && positiveID(template.dungeonNameID) &&
    template.templateID === `client-dungeon:${template.sourceDungeonID}` &&
    Boolean(getSovProspectingRepairTemplateName(template));
}

function buildSovProspectingNameRepair(state, templates, options = {}) {
  if (!record(state) || !record(state.instancesByID)) {
    throw new Error("dungeonRuntimeState.instancesByID must be an object");
  }
  if (!Array.isArray(templates)) throw new Error("Dungeon templates must be an array");
  if (options.systemID != null && !positiveID(options.systemID)) {
    throw new Error("systemID must be a positive integer");
  }
  const byID = new Map(templates.filter(record).map((template) => [template.templateID, template]));
  const clientsByName = new Map();
  for (const template of byID.values()) {
    if (!isValidSovProspectingClientNameTemplate(template)) continue;
    const name = getSovProspectingRepairTemplateName(template);
    if (!clientsByName.has(name)) clientsByName.set(name, []);
    clientsByName.get(name).push(template);
  }
  const patches = [];
  const skipped = [];
  let eligibleCount = 0;
  for (const [instanceKey, instance] of Object.entries(state.instancesByID)) {
    if (!record(instance) || instance.siteOrigin !== "sov_hub" ||
      instance.siteFamily !== "ore" || instance.siteKind !== "anomaly" ||
      !ACTIVE_STATES.has(instance.lifecycleState) ||
      (options.systemID != null && instance.solarSystemID !== options.systemID)) continue;
    const metadata = record(instance.metadata) ? instance.metadata : {};
    const spawnState = record(instance.spawnState) ? instance.spawnState : {};
    const families = [metadata.spawnFamilyKey, spawnState.spawnFamilyKey].filter((value) => value != null);
    if (!families.length || families.some((value) => value !== "sov_prospecting")) continue;
    if (positiveID(instance.dungeonNameID)) continue;
    eligibleCount += 1;
    const summary = {
      instanceID: instance.instanceID,
      solarSystemID: instance.solarSystemID,
      templateID: instance.templateID,
    };
    const skip = (reason) => skipped.push({ ...summary, reason });
    if (!positiveID(instance.instanceID) || String(instance.instanceID) !== instanceKey ||
      !positiveID(instance.solarSystemID) || (instance.metadata != null && !record(instance.metadata))) {
      skip("invalid_instance_identity_or_metadata");
      continue;
    }
    const hub = record(metadata.sovHub) ? metadata.sovHub : {};
    if (metadata.spawnFamilyKey !== "sov_prospecting" ||
      !record(instance.runtimeFlags) || instance.runtimeFlags.universeSeeded !== true ||
      typeof instance.siteKey !== "string" || !instance.siteKey.trim() ||
      typeof metadata.definitionHash !== "string" || !metadata.definitionHash.trim() ||
      ["sourceHubID", "sourceSystemID", "targetSystemID", "upgradeTypeID", "upgradeTier"]
        .some((field) => !positiveID(hub[field])) ||
      hub.sourceSystemID !== instance.solarSystemID || hub.targetSystemID !== instance.solarSystemID ||
      hub.upgradeCategory !== "prospecting" || !normalizeName(hub.mineral)) {
      // A name-only patch is safe only when startup can retain this exact
      // instance. Do not report a repair that reconciliation would replace.
      skip("missing_reconciliation_identity");
      continue;
    }
    if (instance.dungeonNameID != null && instance.dungeonNameID !== 0) {
      skip("invalid_existing_name_id");
      continue;
    }
    // Require an installed reference definition; do not guess from a label or
    // from the legacy template-ID slug when its originating pack is absent.
    const source = byID.get(instance.templateID);
    const name = getSovProspectingRepairTemplateName(source);
    if (!source || source.siteFamily !== "ore" || source.siteKind !== "anomaly" ||
      !String(instance.templateID).startsWith("eve-university:") || !name) {
      skip("missing_reference_template");
      continue;
    }
    const labels = [spawnState.label, metadata.label].filter((value) => normalizeName(value));
    if (labels.some((label) => normalizeName(label) !== name)) {
      skip("conflicting_display_names");
      continue;
    }
    const candidates = clientsByName.get(name) || [];
    if (candidates.length !== 1) {
      skip(candidates.length ? "ambiguous_client_name" : "no_exact_client_name");
      continue;
    }
    const client = candidates[0];
    if (metadata.sovProspectingNameRepair != null) {
      skip("existing_repair_marker");
      continue;
    }
    const marker = { version: 1, clientTemplateID: client.templateID, dungeonNameID: client.dungeonNameID };
    patches.push({
      ...summary,
      instanceKey,
      name: source.resolvedName || source.name,
      clientTemplateID: client.templateID,
      dungeonNameID: client.dungeonNameID,
      marker,
    });
  }
  return {
    patches,
    report: { eligibleCount, repairCount: patches.length, skippedCount: skipped.length, repairs: patches, skipped },
  };
}

function applySovProspectingNamePatch(instance, patch) {
  return {
    ...instance,
    dungeonNameID: patch.dungeonNameID,
    metadata: { ...instance.metadata, sovProspectingNameRepair: { ...patch.marker } },
  };
}

module.exports = {
  applySovProspectingNamePatch,
  buildSovProspectingNameRepair,
  getSovProspectingRepairTemplateName,
  isValidSovProspectingClientNameTemplate,
};
