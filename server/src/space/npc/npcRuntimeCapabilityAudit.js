"use strict";

const {
  toInt,
} = require("../../common/numbers");

const path = require("path");

const {
  listSdeNpcTypes,
  resolveNpcSdeCapabilities,
  getSdeNpcEnumerationAudit,
} = require(path.join(__dirname, "./npcSdeCapabilityResolver"));
const {
  NPC_RUNTIME_CAPABILITY_REGISTRY,
  buildRuntimeSnapshot,
  resolveNpcRuntimeCapabilitySupport,
} = require(path.join(__dirname, "./npcRuntimeCapabilityRegistry"));
const {
  validateNpcHardwareDefinition,
} = require(path.join(__dirname, "./npcHardwareCatalog"));

const NPC_RUNTIME_SUPPORT_STATUS = Object.freeze({
  SUPPORTED: "SUPPORTED",
  PARTIALLY_SUPPORTED: "PARTIALLY_SUPPORTED",
  UNSUPPORTED: "UNSUPPORTED",
  UNKNOWN: "UNKNOWN",
});

function normalizeCapabilities(value) {
  return [...new Set(
    (Array.isArray(value) ? value : [])
      .map((entry) => String(entry || "").trim())
      .filter(Boolean),
  )].sort();
}

function summarizeEvidence(entry = {}) {
  return {
    capabilityID: String(entry.capabilityID || ""),
    source: String(entry.source || ""),
    effectID: toInt(entry.effectID, 0),
    effectName: String(entry.effectName || ""),
    effectGuid: String(entry.effectGuid || ""),
    family: String(entry.family || ""),
    activationChance: Number(entry.activationChance) || 0,
    rangeMeters: Number(entry.rangeMeters) || 0,
    durationMs: Number(entry.durationMs) || 0,
  };
}

function resolveDefinitionValidation(options = {}) {
  if (options.definition && typeof options.definition === "object") {
    const hardware = validateNpcHardwareDefinition(options.definition);
    const behaviorProfile = options.definition.behaviorProfile;
    return {
      hardwareValidationStatus: hardware && hardware.success === true
        ? "VALID"
        : String(hardware && hardware.errorMsg || "INVALID"),
      combatControllerSupported: Boolean(
        behaviorProfile &&
        String(behaviorProfile.behaviorProfileID || "").trim(),
      ),
      profileValidationEvaluated: true,
    };
  }

  const hardwareValidationStatus = String(
    options.hardwareValidationStatus || "NOT_EVALUATED",
  );
  const combatControllerSupported = typeof options.combatControllerSupported === "boolean"
    ? options.combatControllerSupported
    : null;
  return {
    hardwareValidationStatus,
    combatControllerSupported,
    profileValidationEvaluated:
      hardwareValidationStatus !== "NOT_EVALUATED" ||
      combatControllerSupported !== null,
  };
}

function determineStatus({
  supportedCapabilities,
  unsupportedCapabilities,
  unknownCapabilities,
  definitionValidation,
}) {
  if (unknownCapabilities.length > 0) {
    return NPC_RUNTIME_SUPPORT_STATUS.UNKNOWN;
  }
  const definitionUnsupported = Boolean(
    definitionValidation.profileValidationEvaluated && (
      definitionValidation.hardwareValidationStatus !== "VALID" ||
      definitionValidation.combatControllerSupported !== true
    ),
  );
  if (unsupportedCapabilities.length <= 0 && !definitionUnsupported) {
    return NPC_RUNTIME_SUPPORT_STATUS.SUPPORTED;
  }
  return supportedCapabilities.length > 0
    ? NPC_RUNTIME_SUPPORT_STATUS.PARTIALLY_SUPPORTED
    : NPC_RUNTIME_SUPPORT_STATUS.UNSUPPORTED;
}

function auditNpcRuntimeSupport(typeID, options = {}) {
  const sde = resolveNpcSdeCapabilities(typeID, options.sde || options);
  const registry = options.runtimeCapabilityRegistry ||
    NPC_RUNTIME_CAPABILITY_REGISTRY;
  const runtimeSnapshot = options.runtimeSnapshot ||
    buildRuntimeSnapshot(sde.typeID);
  const evidenceByCapability = new Map();
  for (const evidence of sde.capabilityEvidence) {
    if (!evidenceByCapability.has(evidence.capabilityID)) {
      evidenceByCapability.set(evidence.capabilityID, []);
    }
    evidenceByCapability.get(evidence.capabilityID).push(evidence);
  }

  const runtimeCapabilityResults = [];
  const supportedCapabilities = [];
  const runtimeUnsupportedCapabilities = [];
  for (const capabilityID of sde.detectedCapabilities) {
    const evidenceEntries = evidenceByCapability.get(capabilityID) || [];
    const evidenceResults = evidenceEntries.map((evidence) => ({
      evidence: summarizeEvidence(evidence),
      support: resolveNpcRuntimeCapabilitySupport(
        capabilityID,
        evidence,
        {
          registry,
          typeID: sde.typeID,
          runtimeSnapshot,
        },
      ),
    }));
    const unsupportedEvidence = evidenceResults.filter(
      (entry) => entry.support.supported !== true,
    );
    const supported = evidenceResults.length > 0 && unsupportedEvidence.length === 0;
    const result = {
      capabilityID,
      supported,
      runtime: evidenceResults
        .map((entry) => String(entry.support.runtime || ""))
        .find(Boolean) || "",
      reasons: [...new Set(
        unsupportedEvidence
          .map((entry) => String(entry.support.reason || ""))
          .filter(Boolean),
      )],
      evidence: evidenceResults.map((entry) => ({
        ...entry.evidence,
        runtimeSupported: entry.support.supported === true,
        runtime: String(entry.support.runtime || ""),
        reason: String(entry.support.reason || ""),
      })),
    };
    runtimeCapabilityResults.push(result);
    if (supported) {
      supportedCapabilities.push(capabilityID);
    } else {
      runtimeUnsupportedCapabilities.push({
        capabilityID,
        reason: result.reasons[0] || "NO_RUNTIME_IMPLEMENTATION",
        reasons: result.reasons,
        evidence: result.evidence,
      });
    }
  }

  const declaredCapabilityIDs = options.declaredCapabilityIDs === undefined &&
    options.profileCapabilities === undefined
    ? null
    : normalizeCapabilities(
      options.declaredCapabilityIDs ?? options.profileCapabilities,
    );
  const profileOmissions = declaredCapabilityIDs === null
    ? []
    : supportedCapabilities
      .filter((capabilityID) => !declaredCapabilityIDs.includes(capabilityID))
      .map((capabilityID) => ({
        capabilityID,
        reason: "PROFILE_MAPPING_OMISSION",
        evidence: (evidenceByCapability.get(capabilityID) || []).map(summarizeEvidence),
      }));
  const profileOverclaims = declaredCapabilityIDs === null
    ? []
    : declaredCapabilityIDs
      .filter((capabilityID) => !sde.detectedCapabilities.includes(capabilityID))
      .map((capabilityID) => ({
        capabilityID,
        reason: "PROFILE_CAPABILITY_NOT_REQUIRED_BY_SDE",
      }));
  const unsupportedCapabilities = [
    ...runtimeUnsupportedCapabilities,
    ...profileOmissions,
  ];
  const unknownCapabilities = sde.unknownMechanics.map((entry) => ({
    capabilityID: "unknown_sde_mechanic",
    ...entry,
  }));
  const definitionValidation = resolveDefinitionValidation(options);
  const status = !sde.typeExists
    ? NPC_RUNTIME_SUPPORT_STATUS.UNKNOWN
    : determineStatus({
      supportedCapabilities,
      unsupportedCapabilities,
      unknownCapabilities,
      definitionValidation,
    });

  return {
    typeID: sde.typeID,
    typeName: sde.typeName,
    groupID: sde.groupID,
    groupName: sde.groupName,
    categoryID: sde.categoryID,
    typeExists: sde.typeExists,
    dogmaAvailable: sde.dogmaAvailable,
    detectedCapabilities: [...sde.detectedCapabilities],
    supportedCapabilities,
    unsupportedCapabilities,
    runtimeUnsupportedCapabilities,
    unknownCapabilities,
    declaredCapabilityIDs,
    profileOmissions,
    profileOverclaims,
    hardwareValidationStatus: definitionValidation.hardwareValidationStatus,
    combatControllerSupported: definitionValidation.combatControllerSupported,
    status,
    capabilityResults: runtimeCapabilityResults,
    evidence: sde.capabilityEvidence.map(summarizeEvidence),
    excludedMechanics: (sde.excludedMechanics || []).map((entry) => ({
      ...entry,
    })),
  };
}

function auditAllSdeNpcRuntimeSupport(options = {}) {
  const types = listSdeNpcTypes(options);
  const results = types.map((typeRecord) => auditNpcRuntimeSupport(
    typeRecord.typeID,
    options,
  ));
  const statusCounts = Object.fromEntries(
    Object.values(NPC_RUNTIME_SUPPORT_STATUS).map((status) => [status, 0]),
  );
  const unsupportedCapabilityCounts = new Map();
  const unknownMechanicCounts = new Map();
  for (const result of results) {
    statusCounts[result.status] += 1;
    for (const entry of result.runtimeUnsupportedCapabilities) {
      unsupportedCapabilityCounts.set(
        entry.capabilityID,
        (unsupportedCapabilityCounts.get(entry.capabilityID) || 0) + 1,
      );
    }
    for (const entry of result.unknownCapabilities) {
      const key = String(entry.effectName || entry.reason || "unknown_sde_mechanic");
      unknownMechanicCounts.set(key, (unknownMechanicCounts.get(key) || 0) + 1);
    }
  }
  const countEntries = (counts) => [...counts.entries()]
    .map(([capabilityID, npcCount]) => ({ capabilityID, npcCount }))
    .sort((left, right) => (
      right.npcCount - left.npcCount ||
      left.capabilityID.localeCompare(right.capabilityID)
    ));
  return {
    generatedAt: new Date().toISOString(),
    enumeration: getSdeNpcEnumerationAudit(),
    summary: {
      npcsExamined: results.length,
      fullySupported: statusCounts.SUPPORTED,
      partiallySupported: statusCounts.PARTIALLY_SUPPORTED,
      unsupported: statusCounts.UNSUPPORTED,
      unknown: statusCounts.UNKNOWN,
    },
    unsupportedCapabilityFamilies: countEntries(unsupportedCapabilityCounts),
    unknownMechanicFamilies: countEntries(unknownMechanicCounts),
    results,
  };
}

function formatCapabilityList(entries = []) {
  if (entries.length <= 0) return "  none";
  return entries.map((entry) => {
    if (typeof entry === "string") return `  ${entry}`;
    return `  ${entry.capabilityID}: ${entry.reason || "unsupported"}`;
  }).join("\n");
}

function formatNpcAuditFailure(audit = {}, options = {}) {
  const affected = Array.isArray(options.affectedAbyssalProfileIDs)
    ? options.affectedAbyssalProfileIDs
    : [];
  const evidence = (Array.isArray(audit.evidence) ? audit.evidence : [])
    .map((entry) => (
      `  effectID=${entry.effectID || 0} effectName=${entry.effectName || "<attributes>"}` +
      ` source=${entry.source || "unknown"} capability=${entry.capabilityID || "unknown"}`
    ))
    .join("\n") || "  none";
  return [
    "NPC_RUNTIME_CAPABILITY_UNSUPPORTED",
    "",
    `typeID: ${audit.typeID || 0}`,
    `NPC name: ${audit.typeName || ""}`,
    `groupID: ${audit.groupID || 0}`,
    `status: ${audit.status || "UNKNOWN"}`,
    "",
    "supported capabilities",
    formatCapabilityList(audit.supportedCapabilities || []),
    "",
    "unsupported capabilities",
    formatCapabilityList(audit.unsupportedCapabilities || []),
    "",
    "unknown capabilities",
    formatCapabilityList(audit.unknownCapabilities || []),
    "",
    "relevant SDE evidence",
    evidence,
    ...(affected.length > 0
      ? ["", `affected Abyssal profiles: ${affected.join(", ")}`]
      : []),
  ].join("\n");
}

function formatFullSdeNpcRuntimeAuditReport(report = {}) {
  const summary = report.summary || {};
  const lines = [
    "SDE NPC Runtime Capability Audit",
    "",
    `NPCs examined:        ${summary.npcsExamined || 0}`,
    `Fully supported:      ${summary.fullySupported || 0}`,
    `Partially supported:  ${summary.partiallySupported || 0}`,
    `Unsupported:          ${summary.unsupported || 0}`,
    `Unknown:              ${summary.unknown || 0}`,
    "",
    "Unsupported capability families",
    "",
    ...(report.unsupportedCapabilityFamilies || []).map((entry) => (
      `${String(entry.capabilityID).padEnd(32)} ${entry.npcCount} NPCs`
    )),
    "",
    "Unknown/unclassified mechanic families",
    "",
    ...(report.unknownMechanicFamilies || []).map((entry) => (
      `${String(entry.capabilityID).padEnd(32)} ${entry.npcCount} NPCs`
    )),
  ];
  const incomplete = (report.results || []).filter(
    (entry) => entry.status !== NPC_RUNTIME_SUPPORT_STATUS.SUPPORTED,
  );
  if (incomplete.length > 0) {
    lines.push("", "Per-NPC gaps", "");
    for (const entry of incomplete) {
      lines.push(
        `${entry.typeID} ${entry.typeName || "<unnamed>"} [${entry.status}]`,
      );
      for (const gap of entry.unsupportedCapabilities || []) {
        lines.push(`  UNSUPPORTED ${gap.capabilityID}: ${gap.reason}`);
      }
      for (const gap of entry.unknownCapabilities || []) {
        lines.push(
          `  UNKNOWN ${gap.effectName || gap.reason}` +
          `${gap.effectID ? ` effectID=${gap.effectID}` : ""}`,
        );
      }
    }
  }
  return lines.join("\n");
}

module.exports = {
  NPC_RUNTIME_SUPPORT_STATUS,
  auditNpcRuntimeSupport,
  auditAllSdeNpcRuntimeSupport,
  formatNpcAuditFailure,
  formatFullSdeNpcRuntimeAuditReport,
};
