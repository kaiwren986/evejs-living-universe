"use strict";

const {
  ABYSSAL_CONTENT_AUTHORITY,
  ABYSSAL_CONTENT_VALIDATION_AUTHORITY,
  ABYSSAL_CONTENT_COMPLETENESS_STATUS,
  ABYSSAL_CONTENT_COMPLETENESS_POLICY,
  compareAbyssalContentCompletenessLevels,
  validateAbyssalContentCompletenessLevel,
} = require("../catalog/abyssalContentAuthority");

const PRODUCTION_POLICIES = new Set([
  ABYSSAL_CONTENT_COMPLETENESS_POLICY.SUPPORTED,
  ABYSSAL_CONTENT_COMPLETENESS_POLICY.RETAIL_PARITY,
]);
const KNOWN_AUTHORITIES = new Set([
  ...Object.values(ABYSSAL_CONTENT_AUTHORITY),
  ...Object.values(ABYSSAL_CONTENT_VALIDATION_AUTHORITY),
]);
const KNOWN_STATUSES = new Set(
  Object.values(ABYSSAL_CONTENT_COMPLETENESS_STATUS),
);

function normalizeText(value) {
  return String(value == null ? "" : value).trim();
}

function normalizeInteger(value, fallback = null) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function isProductionPolicy(value) {
  return PRODUCTION_POLICIES.has(normalizeText(value).toLowerCase());
}

function buildAbyssalCompletenessAuditIdentity(record = {}) {
  const identity = {
    filamentTypeID: normalizeInteger(record.filamentTypeID),
    definitionID: normalizeText(record.definitionID),
    tier: normalizeInteger(record.tier),
    weather: normalizeText(record.weather ?? record.weatherType).toLowerCase(),
    hullMode: normalizeText(record.hullMode).toLowerCase(),
  };
  return {
    ...identity,
    key: JSON.stringify([
      identity.filamentTypeID,
      identity.definitionID,
      identity.tier,
      identity.weather,
      identity.hullMode,
    ]),
  };
}

function describeIdentity(identity) {
  return [
    `typeID=${identity.filamentTypeID ?? "missing"}`,
    `definitionID=${identity.definitionID || "missing"}`,
    `tier=${identity.tier ?? "missing"}`,
    `weather=${identity.weather || "missing"}`,
    `hull=${identity.hullMode || "missing"}`,
  ].join(" ");
}

function pushError(errors, code, record = {}, details = {}) {
  const identity = buildAbyssalCompletenessAuditIdentity(record);
  errors.push({
    code,
    identity,
    message: `${code} ${describeIdentity(identity)}`,
    ...details,
  });
}

function validateIdentity(errors, record, source) {
  const identity = buildAbyssalCompletenessAuditIdentity(record);
  if (
    !Number.isInteger(identity.filamentTypeID) ||
    identity.filamentTypeID <= 0 ||
    !identity.definitionID ||
    !Number.isInteger(identity.tier) ||
    identity.tier < 0 ||
    !identity.weather ||
    !identity.hullMode
  ) {
    pushError(
      errors,
      "ABYSSAL_COMPLETENESS_INVALID_IDENTITY",
      record,
      { source },
    );
  }
  return identity;
}

function validateDeclaredLevel(errors, definition) {
  if (
    !Object.hasOwn(definition, "declaredCompletenessLevel") ||
    !normalizeText(definition.declaredCompletenessLevel)
  ) {
    pushError(
      errors,
      "ABYSSAL_COMPLETENESS_DECLARATION_MISSING",
      definition,
    );
    return null;
  }
  try {
    return validateAbyssalContentCompletenessLevel(
      definition.declaredCompletenessLevel,
      `Production Abyssal filament ${normalizeText(definition.definitionID)}`,
    );
  } catch (error) {
    pushError(
      errors,
      "ABYSSAL_COMPLETENESS_DECLARATION_UNKNOWN",
      definition,
      {
        declaredCompletenessLevel: normalizeText(
          definition.declaredCompletenessLevel,
        ),
        reason: error.message,
      },
    );
    return null;
  }
}

function validateAuditEnums(errors, entry) {
  if (!Array.isArray(entry.components)) {
    pushError(
      errors,
      "ABYSSAL_CONTENT_AUDIT_COMPONENTS_MISSING",
      entry,
    );
    return;
  }
  for (const component of entry.components) {
    const authority = normalizeText(component && component.authority);
    const status = normalizeText(component && component.completeness).toUpperCase();
    if (authority && !KNOWN_AUTHORITIES.has(authority)) {
      pushError(
        errors,
        "ABYSSAL_CONTENT_AUTHORITY_UNKNOWN",
        entry,
        {
          component: normalizeText(component && component.path) ||
            normalizeText(component && component.component),
          authority,
        },
      );
    }
    if (!KNOWN_STATUSES.has(status)) {
      pushError(
        errors,
        "ABYSSAL_CONTENT_STATUS_UNKNOWN",
        entry,
        {
          component: normalizeText(component && component.path) ||
            normalizeText(component && component.component),
          status: status || null,
        },
      );
    }
  }
}

function indexUniqueRecords(errors, records, source) {
  const indexed = new Map();
  for (const record of records) {
    const identity = validateIdentity(errors, record, source);
    if (indexed.has(identity.key)) {
      pushError(
        errors,
        "ABYSSAL_COMPLETENESS_DUPLICATE_IDENTITY",
        record,
        { source },
      );
      continue;
    }
    indexed.set(identity.key, record);
  }
  return indexed;
}

function evaluateAbyssalContentCompletenessCiGate({
  productionDefinitions = [],
  auditResult = null,
} = {}) {
  const errors = [];
  const definitions = Array.isArray(productionDefinitions)
    ? productionDefinitions
    : [];
  const auditEntries = Array.isArray(auditResult && auditResult.entries)
    ? auditResult.entries
    : [];
  const productionAuditEntries = auditEntries.filter((entry) =>
    isProductionPolicy(entry && entry.policy)
  );

  if (!Array.isArray(productionDefinitions)) {
    errors.push({
      code: "ABYSSAL_CONTENT_PRODUCTION_ENUMERATION_FAILURE",
      message: "ABYSSAL_CONTENT_PRODUCTION_ENUMERATION_FAILURE definitions are not an array",
    });
  }
  if (!auditResult || !Array.isArray(auditResult.entries)) {
    errors.push({
      code: "ABYSSAL_CONTENT_AUDIT_EXECUTION_FAILURE",
      message: "ABYSSAL_CONTENT_AUDIT_EXECUTION_FAILURE audit entries are unavailable",
    });
  } else if (auditResult.complete !== true) {
    errors.push({
      code: "ABYSSAL_CONTENT_AUDIT_INCOMPLETE",
      message: "ABYSSAL_CONTENT_AUDIT_INCOMPLETE aggregate audit did not complete successfully",
    });
  }

  const productionByIdentity = indexUniqueRecords(
    errors,
    definitions,
    "production",
  );
  const auditByIdentity = indexUniqueRecords(
    errors,
    productionAuditEntries,
    "audit",
  );
  const declarationsByIdentity = new Map();

  for (const [identityKey, definition] of productionByIdentity) {
    const declaredLevel = validateDeclaredLevel(errors, definition);
    declarationsByIdentity.set(identityKey, declaredLevel);
    if (!auditByIdentity.has(identityKey)) {
      pushError(
        errors,
        "ABYSSAL_CONTENT_AUDIT_COVERAGE_FAILURE",
        definition,
        { coverage: "PRODUCTION_FILAMENT_NOT_AUDITED" },
      );
    }
  }

  for (const [identityKey, entry] of auditByIdentity) {
    validateAuditedProductionDeclaration(errors, productionByIdentity, declarationsByIdentity, identityKey, entry);
  }

  const promotionCount = productionAuditEntries.filter((entry) => {
    try {
      return compareAbyssalContentCompletenessLevels(
        entry.achievedCompletenessLevel,
        entry.declaredCompletenessLevel,
      ) > 0;
    } catch {
      // ignored: an unknown completeness level is not a promotion (false)
      return false;
    }
  }).length;

  return {
    success: errors.length === 0,
    errorCode: errors.length === 0
      ? null
      : "ABYSSAL_CONTENT_COMPLETENESS_CI_FAILURE",
    productionDefinitionCount: productionByIdentity.size,
    auditedProductionDefinitionCount: auditByIdentity.size,
    promotionOpportunityCount: promotionCount,
    errors,
    productionIdentities: [...productionByIdentity.keys()].sort(),
    auditedProductionIdentities: [...auditByIdentity.keys()].sort(),
  };
}

function validateAuditedProductionDeclaration(errors, productionByIdentity, declarationsByIdentity, identityKey, entry) {

  if (!productionByIdentity.has(identityKey)) {
    pushError(
      errors,
      "ABYSSAL_CONTENT_AUDIT_COVERAGE_FAILURE",
      entry,
      { coverage: "UNEXPECTED_PRODUCTION_AUDIT_RESULT" },
    );
    return;
  }

  if (entry.complete !== true) {
    pushError(
      errors,
      "ABYSSAL_CONTENT_AUDIT_ENTRY_INCOMPLETE",
      entry,
      { reason: normalizeText(entry.errorCode) || "RESOLUTION_INCOMPLETE" },
    );
  }

  validateAuditEnums(errors, entry);
  const declaredLevel = declarationsByIdentity.get(identityKey);
  let auditedDeclaration = null;
  let achievedLevel = null;
  try {
    auditedDeclaration = validateAbyssalContentCompletenessLevel(
      entry.declaredCompletenessLevel,
      `Audited Abyssal filament ${normalizeText(entry.definitionID)}`,
    );
  } catch (error) {
    pushError(
      errors,
      "ABYSSAL_COMPLETENESS_DECLARATION_UNKNOWN",
      entry,
      { reason: error.message },
    );
  }
  try {
    achievedLevel = validateAbyssalContentCompletenessLevel(
      entry.achievedCompletenessLevel,
      `Audited Abyssal filament ${normalizeText(entry.definitionID)}`,
    );
  } catch (error) {
    pushError(
      errors,
      "ABYSSAL_COMPLETENESS_ACHIEVED_LEVEL_UNKNOWN",
      entry,
      { reason: error.message },
    );
  }

  if (
    declaredLevel &&
    auditedDeclaration &&
    declaredLevel !== auditedDeclaration
  ) {
    pushError(
      errors,
      "ABYSSAL_COMPLETENESS_DECLARATION_MISMATCH",
      entry,
      {
        productionDeclaration: declaredLevel,
        auditDeclaration: auditedDeclaration,
      },
    );
  }

  if (declaredLevel && achievedLevel) {
    const comparison = compareAbyssalContentCompletenessLevels(
      achievedLevel,
      declaredLevel,
    );
    if (comparison < 0) {
      pushError(
        errors,
        "ABYSSAL_CONTENT_COMPLETENESS_REGRESSION",
        entry,
        {
          declaredCompletenessLevel: declaredLevel,
          achievedCompletenessLevel: achievedLevel,
          blockers: Array.isArray(entry.declaredLevelBlockers)
            ? entry.declaredLevelBlockers
            : Array.isArray(entry.nextLevelBlockers)
              ? entry.nextLevelBlockers
              : [],
        },
      );
    }
    const expectedRegression = comparison < 0;
    if ((entry.regression === true) !== expectedRegression) {
      pushError(
        errors,
        "ABYSSAL_COMPLETENESS_REGRESSION_FLAG_MISMATCH",
        entry,
        {
          expectedRegression,
          reportedRegression: entry.regression === true,
        },
      );
    }
  }
}

function formatAbyssalContentCompletenessCiFailure(report) {
  const lines = [
    "ABYSSAL_CONTENT_COMPLETENESS_CI_FAILURE",
    `Production definitions: ${report.productionDefinitionCount}`,
    `Audited production definitions: ${report.auditedProductionDefinitionCount}`,
  ];
  for (const error of report.errors || []) {
    lines.push("", error.code, error.message || "");
    if (error.declaredCompletenessLevel || error.achievedCompletenessLevel) {
      lines.push(
        `Declared: ${error.declaredCompletenessLevel || "unknown"}`,
        `Achieved: ${error.achievedCompletenessLevel || "unknown"}`,
      );
    }
    for (const blocker of (error.blockers || []).slice(0, 20)) {
      lines.push(
        `Blocker: ${blocker.path || blocker.component || "unknown"} ` +
        `${blocker.reason || "UNKNOWN"}`,
      );
    }
  }
  return lines.filter((line, index, all) =>
    line !== "" || all[index - 1] !== ""
  ).join("\n");
}

function assertAbyssalContentCompletenessCiGate(input = {}) {
  const report = evaluateAbyssalContentCompletenessCiGate(input);
  if (report.success) {
    return report;
  }
  const error = new Error(formatAbyssalContentCompletenessCiFailure(report));
  error.code = report.errorCode;
  error.report = report;
  throw error;
}

function runAbyssalContentCompletenessCiGate({
  loadProductionDefinitions,
  runAudit,
} = {}) {
  let productionDefinitions;
  try {
    productionDefinitions = loadProductionDefinitions();
  } catch (cause) {
    const error = new Error(
      `ABYSSAL_CONTENT_PRODUCTION_ENUMERATION_FAILURE ${cause.message}`,
      { cause },
    );
    error.code = "ABYSSAL_CONTENT_PRODUCTION_ENUMERATION_FAILURE";
    throw error;
  }
  let auditResult;
  try {
    auditResult = runAudit();
  } catch (cause) {
    const error = new Error(
      `ABYSSAL_CONTENT_AUDIT_EXECUTION_FAILURE ${cause.message}`,
      { cause },
    );
    error.code = "ABYSSAL_CONTENT_AUDIT_EXECUTION_FAILURE";
    throw error;
  }
  return assertAbyssalContentCompletenessCiGate({
    productionDefinitions,
    auditResult,
  });
}

module.exports = {
  assertAbyssalContentCompletenessCiGate,
  buildAbyssalCompletenessAuditIdentity,
  evaluateAbyssalContentCompletenessCiGate,
  formatAbyssalContentCompletenessCiFailure,
  isProductionPolicy,
  runAbyssalContentCompletenessCiGate,
};
