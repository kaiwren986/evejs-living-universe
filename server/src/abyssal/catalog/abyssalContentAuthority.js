"use strict";

const ABYSSAL_CONTENT_AUTHORITY = Object.freeze({
  CAPTURED_RETAIL: "captured_retail",
  OBSERVED_EMPIRICAL: "observed_empirical",
  PROJECT_AUTHORED: "project_authored",
  PROVISIONAL: "provisional",
  DEBUG_PLACEHOLDER: "debug_placeholder",
});

const ABYSSAL_CONTENT_AUTHORITY_SEMANTICS = Object.freeze({
  [ABYSSAL_CONTENT_AUTHORITY.CAPTURED_RETAIL]:
    "Content directly supported by explicit captured retail evidence.",
  [ABYSSAL_CONTENT_AUTHORITY.OBSERVED_EMPIRICAL]:
    "Content supported by observation or telemetry without an exact captured implementation claim.",
  [ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED]:
    "Intentional EveJS-authored content with no captured-retail claim.",
  [ABYSSAL_CONTENT_AUTHORITY.PROVISIONAL]:
    "Temporary development content that is not a final production baseline.",
  [ABYSSAL_CONTENT_AUTHORITY.DEBUG_PLACEHOLDER]:
    "Development or test scaffolding that production content may use only when explicitly permitted.",
});

const ABYSSAL_CONTENT_VALIDATION_AUTHORITY = Object.freeze({
  SDE_RUNTIME_AUDITED: "sde_runtime_audited",
});

const ABYSSAL_CONTENT_COMPLETENESS_STATUS = Object.freeze({
  COMPLETE: "COMPLETE",
  INCOMPLETE: "INCOMPLETE",
  MISSING: "MISSING",
  UNSUPPORTED: "UNSUPPORTED",
  UNKNOWN: "UNKNOWN",
});

const ABYSSAL_CONTENT_COMPLETENESS_STATUS_SEMANTICS = Object.freeze({
  [ABYSSAL_CONTENT_COMPLETENESS_STATUS.COMPLETE]:
    "The component exists and its required runtime validation succeeded.",
  [ABYSSAL_CONTENT_COMPLETENESS_STATUS.INCOMPLETE]:
    "The component exists but lacks required content or validation detail.",
  [ABYSSAL_CONTENT_COMPLETENESS_STATUS.MISSING]:
    "No resolved component/profile exists for this slot.",
  [ABYSSAL_CONTENT_COMPLETENESS_STATUS.UNSUPPORTED]:
    "The component exists but the required EveJS runtime mechanism is unsupported.",
  [ABYSSAL_CONTENT_COMPLETENESS_STATUS.UNKNOWN]:
    "Authority or runtime support cannot be established and therefore fails closed.",
});

const ABYSSAL_CONTENT_COMPLETENESS_LEVEL = Object.freeze({
  INCOMPLETE: "INCOMPLETE",
  PLAYABLE: "PLAYABLE",
  BASELINE_COMPLETE: "BASELINE_COMPLETE",
  OBSERVED_COMPLETE: "OBSERVED_COMPLETE",
  CAPTURED_RETAIL_COMPLETE: "CAPTURED_RETAIL_COMPLETE",
});

const ABYSSAL_CONTENT_COMPLETENESS_LEVEL_SEMANTICS = Object.freeze({
  [ABYSSAL_CONTENT_COMPLETENESS_LEVEL.INCOMPLETE]:
    "One or more PLAYABLE requirements are missing, unsupported, unknown, or forbidden.",
  [ABYSSAL_CONTENT_COMPLETENESS_LEVEL.PLAYABLE]:
    "The end-to-end run is executable with no missing or unsupported gameplay requirement.",
  [ABYSSAL_CONTENT_COMPLETENESS_LEVEL.BASELINE_COMPLETE]:
    "All major gameplay families are intentional project-authored content or stronger, with no forbidden placeholder or unapproved fallback.",
  [ABYSSAL_CONTENT_COMPLETENESS_LEVEL.OBSERVED_COMPLETE]:
    "All required evidence-bearing components are observed empirical content or stronger.",
  [ABYSSAL_CONTENT_COMPLETENESS_LEVEL.CAPTURED_RETAIL_COMPLETE]:
    "All required evidence-bearing components carry explicit captured-retail authority.",
});

const ABYSSAL_CONTENT_COMPLETENESS_LEVEL_RANK = Object.freeze({
  [ABYSSAL_CONTENT_COMPLETENESS_LEVEL.INCOMPLETE]: -1,
  [ABYSSAL_CONTENT_COMPLETENESS_LEVEL.PLAYABLE]: 0,
  [ABYSSAL_CONTENT_COMPLETENESS_LEVEL.BASELINE_COMPLETE]: 1,
  [ABYSSAL_CONTENT_COMPLETENESS_LEVEL.OBSERVED_COMPLETE]: 2,
  [ABYSSAL_CONTENT_COMPLETENESS_LEVEL.CAPTURED_RETAIL_COMPLETE]: 3,
});

const ABYSSAL_CONTENT_COMPLETENESS_LEVELS = Object.freeze([
  ABYSSAL_CONTENT_COMPLETENESS_LEVEL.PLAYABLE,
  ABYSSAL_CONTENT_COMPLETENESS_LEVEL.BASELINE_COMPLETE,
  ABYSSAL_CONTENT_COMPLETENESS_LEVEL.OBSERVED_COMPLETE,
  ABYSSAL_CONTENT_COMPLETENESS_LEVEL.CAPTURED_RETAIL_COMPLETE,
]);

const ABYSSAL_CONTENT_COMPLETENESS_POLICY = Object.freeze({
  DEVELOPMENT: "development",
  SUPPORTED: "supported",
  RETAIL_PARITY: "retail_parity",
});

const ABYSSAL_CONTENT_COMPLETENESS_POLICY_SEMANTICS = Object.freeze({
  [ABYSSAL_CONTENT_COMPLETENESS_POLICY.DEVELOPMENT]:
    "Development content may use any declared content authority, including explicit debug placeholders.",
  [ABYSSAL_CONTENT_COMPLETENESS_POLICY.SUPPORTED]:
    "Supported content rejects debug placeholders; its declared completeness level separately governs release evidence quality.",
  [ABYSSAL_CONTENT_COMPLETENESS_POLICY.RETAIL_PARITY]:
    "Every required evidence-bearing component and authority facet must satisfy CAPTURED_RETAIL_COMPLETE; SDE runtime audits validate capability but do not claim content evidence.",
});

const ABYSSAL_CONTENT_COMPONENT_REQUIREMENT = Object.freeze({
  REQUIRED: "required",
  OPTIONAL: "optional",
  DIAGNOSTIC_ONLY: "diagnostic_only",
  NOT_APPLICABLE: "not_applicable",
});

const AUTHORITY_VALUES = Object.freeze(Object.values(ABYSSAL_CONTENT_AUTHORITY));
const COMPLETENESS_POLICY_VALUES = Object.freeze(
  Object.values(ABYSSAL_CONTENT_COMPLETENESS_POLICY),
);
const COMPONENT_REQUIREMENT_VALUES = Object.freeze(
  Object.values(ABYSSAL_CONTENT_COMPONENT_REQUIREMENT),
);

const ACCEPTED_AUTHORITIES_BY_POLICY = Object.freeze({
  [ABYSSAL_CONTENT_COMPLETENESS_POLICY.DEVELOPMENT]: new Set(AUTHORITY_VALUES),
  [ABYSSAL_CONTENT_COMPLETENESS_POLICY.SUPPORTED]: new Set([
    ABYSSAL_CONTENT_AUTHORITY.CAPTURED_RETAIL,
    ABYSSAL_CONTENT_AUTHORITY.OBSERVED_EMPIRICAL,
    ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
    ABYSSAL_CONTENT_AUTHORITY.PROVISIONAL,
  ]),
  [ABYSSAL_CONTENT_COMPLETENESS_POLICY.RETAIL_PARITY]: new Set([
    ABYSSAL_CONTENT_AUTHORITY.CAPTURED_RETAIL,
  ]),
});

function normalizeValue(value) {
  return String(value == null ? "" : value).trim().toLowerCase();
}

function isAbyssalContentAuthority(value) {
  return AUTHORITY_VALUES.includes(normalizeValue(value));
}

function validateAbyssalContentAuthority(value, context = "Abyssal content") {
  const normalized = normalizeValue(value);
  if (!AUTHORITY_VALUES.includes(normalized)) {
    throw new TypeError(`${context} has unknown content authority: ${String(value)}`);
  }
  return normalized;
}

function validateAbyssalContentCompletenessPolicy(
  value,
  context = "Abyssal content",
) {
  const normalized = normalizeValue(value);
  if (!COMPLETENESS_POLICY_VALUES.includes(normalized)) {
    throw new TypeError(`${context} has unknown completeness policy: ${String(value)}`);
  }
  return normalized;
}

function validateAbyssalContentComponentRequirement(
  value,
  context = "Abyssal content component",
) {
  const normalized = normalizeValue(value);
  if (!COMPONENT_REQUIREMENT_VALUES.includes(normalized)) {
    throw new TypeError(`${context} has unknown requirement: ${String(value)}`);
  }
  return normalized;
}

function validateAbyssalContentCompletenessLevel(
  value,
  context = "Abyssal content",
) {
  const normalized = String(value == null ? "" : value).trim().toUpperCase();
  if (!Object.hasOwn(ABYSSAL_CONTENT_COMPLETENESS_LEVEL_RANK, normalized)) {
    throw new TypeError(
      `${context} has unknown completeness level: ${String(value)}`,
    );
  }
  return normalized;
}

function compareAbyssalContentCompletenessLevels(left, right) {
  const leftLevel = validateAbyssalContentCompletenessLevel(left);
  const rightLevel = validateAbyssalContentCompletenessLevel(right);
  return ABYSSAL_CONTENT_COMPLETENESS_LEVEL_RANK[leftLevel] -
    ABYSSAL_CONTENT_COMPLETENESS_LEVEL_RANK[rightLevel];
}

function normalizeStringArray(value) {
  return [...new Set(
    (Array.isArray(value) ? value : [])
      .map((entry) => String(entry == null ? "" : entry).trim())
      .filter(Boolean),
  )];
}

function normalizeProvenance(value, fallback = {}) {
  const source = value && typeof value === "object" ? value : {};
  return {
    sourceID: String(source.sourceID || fallback.sourceID || "").trim(),
    sourceType: String(source.sourceType || fallback.sourceType || "").trim(),
    evidenceRefs: normalizeStringArray(
      source.evidenceRefs || fallback.evidenceRefs,
    ),
  };
}

function normalizeCompletenessStatus(value, runtimeValid, resolvedProfileID) {
  const normalized = String(value == null ? "" : value).trim().toUpperCase();
  if (Object.values(ABYSSAL_CONTENT_COMPLETENESS_STATUS).includes(normalized)) {
    return normalized;
  }
  if (normalized) {
    return ABYSSAL_CONTENT_COMPLETENESS_STATUS.UNKNOWN;
  }
  if (!resolvedProfileID) {
    return ABYSSAL_CONTENT_COMPLETENESS_STATUS.MISSING;
  }
  if (runtimeValid === false) {
    return ABYSSAL_CONTENT_COMPLETENESS_STATUS.UNSUPPORTED;
  }
  if (runtimeValid === true) {
    return ABYSSAL_CONTENT_COMPLETENESS_STATUS.COMPLETE;
  }
  return ABYSSAL_CONTENT_COMPLETENESS_STATUS.UNKNOWN;
}

function normalizeAbyssalContentComponent(component = {}, index = 0) {
  const resolvedProfileID = String(
    component.resolvedProfileID || component.profileID || "",
  ).trim();
  const rawAuthority = normalizeValue(
    component.authority || component.resolvedAuthority,
  );
  const validationAuthority = Object.values(
    ABYSSAL_CONTENT_VALIDATION_AUTHORITY,
  ).includes(rawAuthority);
  const contentAuthority = AUTHORITY_VALUES.includes(rawAuthority);
  const requirementValue = normalizeValue(
    component.requirement || ABYSSAL_CONTENT_COMPONENT_REQUIREMENT.REQUIRED,
  );
  const requirement = COMPONENT_REQUIREMENT_VALUES.includes(requirementValue)
    ? requirementValue
    : ABYSSAL_CONTENT_COMPONENT_REQUIREMENT.REQUIRED;
  const requiredFromLevel = validateAbyssalContentCompletenessLevel(
    component.requiredFromLevel || ABYSSAL_CONTENT_COMPLETENESS_LEVEL.PLAYABLE,
    `Abyssal content component ${String(component.component || index)}`,
  );
  let completeness = normalizeCompletenessStatus(
    component.completeness,
    component.runtimeValid,
    resolvedProfileID,
  );
  if (!validationAuthority && !contentAuthority) {
    completeness = rawAuthority
      ? ABYSSAL_CONTENT_COMPLETENESS_STATUS.UNKNOWN
      : completeness === ABYSSAL_CONTENT_COMPLETENESS_STATUS.MISSING
        ? completeness
        : ABYSSAL_CONTENT_COMPLETENESS_STATUS.UNKNOWN;
  }
  const fallbackUsed = component.fallbackUsed === true;
  return {
    component: String(component.component || `component_${index + 1}`).trim(),
    path: String(component.path || component.component || `component_${index + 1}`).trim(),
    roomIndex: component.roomIndex != null &&
      Number.isFinite(Number(component.roomIndex))
      ? Math.trunc(Number(component.roomIndex))
      : null,
    resolvedProfileID,
    authority: rawAuthority || null,
    validationAuthority: validationAuthority ? rawAuthority : null,
    authorityAffectsEvidence:
      component.authorityAffectsEvidence !== false && !validationAuthority,
    provenance: normalizeProvenance(component.provenance),
    fallbackUsed,
    fallbackReason: fallbackUsed
      ? String(component.fallbackReason || "UNSPECIFIED_FALLBACK").trim()
      : "",
    fallbackAllowed: component.fallbackAllowed === true,
    requestedAuthority: normalizeValue(component.requestedAuthority) || null,
    resolvedAuthority: rawAuthority || null,
    runtimeValid: component.runtimeValid === true,
    completeness,
    requirement,
    requiredFromLevel,
    debugAllowed: component.debugAllowed === true,
    details: component.details && typeof component.details === "object"
      ? component.details
      : {},
    explicitBlockers: Array.isArray(component.blockers)
      ? component.blockers.map((entry) => ({ ...entry }))
      : [],
  };
}

function authorityRequiredForLevel(level) {
  switch (level) {
    case ABYSSAL_CONTENT_COMPLETENESS_LEVEL.BASELINE_COMPLETE:
      return ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED;
    case ABYSSAL_CONTENT_COMPLETENESS_LEVEL.OBSERVED_COMPLETE:
      return ABYSSAL_CONTENT_AUTHORITY.OBSERVED_EMPIRICAL;
    case ABYSSAL_CONTENT_COMPLETENESS_LEVEL.CAPTURED_RETAIL_COMPLETE:
      return ABYSSAL_CONTENT_AUTHORITY.CAPTURED_RETAIL;
    default:
      return null;
  }
}

function authoritySatisfiesLevel(authority, level) {
  if (level === ABYSSAL_CONTENT_COMPLETENESS_LEVEL.PLAYABLE) {
    return AUTHORITY_VALUES.includes(authority);
  }
  if (level === ABYSSAL_CONTENT_COMPLETENESS_LEVEL.BASELINE_COMPLETE) {
    return [
      ABYSSAL_CONTENT_AUTHORITY.PROJECT_AUTHORED,
      ABYSSAL_CONTENT_AUTHORITY.OBSERVED_EMPIRICAL,
      ABYSSAL_CONTENT_AUTHORITY.CAPTURED_RETAIL,
    ].includes(authority);
  }
  if (level === ABYSSAL_CONTENT_COMPLETENESS_LEVEL.OBSERVED_COMPLETE) {
    return [
      ABYSSAL_CONTENT_AUTHORITY.OBSERVED_EMPIRICAL,
      ABYSSAL_CONTENT_AUTHORITY.CAPTURED_RETAIL,
    ].includes(authority);
  }
  return authority === ABYSSAL_CONTENT_AUTHORITY.CAPTURED_RETAIL;
}

function componentRequiredForLevel(component, level) {
  if (component.requirement !== ABYSSAL_CONTENT_COMPONENT_REQUIREMENT.REQUIRED) {
    return false;
  }
  return compareAbyssalContentCompletenessLevels(
    level,
    component.requiredFromLevel,
  ) >= 0;
}

function buildComponentLevelBlockers(component, level) {
  if (!componentRequiredForLevel(component, level)) {
    return [];
  }
  const blockers = [];
  if (component.completeness !== ABYSSAL_CONTENT_COMPLETENESS_STATUS.COMPLETE) {
    blockers.push({
      level,
      reason: component.completeness,
      component: component.component,
      path: component.path,
      resolvedProfileID: component.resolvedProfileID || null,
    });
  }
  if (
    component.completeness === ABYSSAL_CONTENT_COMPLETENESS_STATUS.COMPLETE &&
    !component.runtimeValid
  ) {
    blockers.push({
      level,
      reason: "RUNTIME_VALIDATION_REQUIRED",
      component: component.component,
      path: component.path,
    });
  }
  if (
    component.authority === ABYSSAL_CONTENT_AUTHORITY.DEBUG_PLACEHOLDER &&
    !component.debugAllowed
  ) {
    blockers.push({
      level,
      reason: "DEBUG_PLACEHOLDER_FORBIDDEN",
      component: component.component,
      path: component.path,
      currentAuthority: component.authority,
    });
  }
  if (
    level !== ABYSSAL_CONTENT_COMPLETENESS_LEVEL.PLAYABLE &&
    component.fallbackUsed &&
    !component.fallbackAllowed
  ) {
    blockers.push({
      level,
      reason: "UNAPPROVED_FALLBACK",
      component: component.component,
      path: component.path,
      fallbackReason: component.fallbackReason,
      requestedAuthority: component.requestedAuthority,
      currentAuthority: component.authority,
    });
  }
  if (
    component.authorityAffectsEvidence &&
    !authoritySatisfiesLevel(component.authority, level)
  ) {
    blockers.push({
      level,
      reason: "AUTHORITY_BELOW_REQUIRED_LEVEL",
      component: component.component,
      path: component.path,
      currentAuthority: component.authority,
      requiredAuthority: authorityRequiredForLevel(level),
    });
  }
  for (const explicit of component.explicitBlockers) {
    const blockerLevel = explicit.level
      ? validateAbyssalContentCompletenessLevel(explicit.level)
      : level;
    if (compareAbyssalContentCompletenessLevels(level, blockerLevel) >= 0) {
      blockers.push({
        level,
        component: component.component,
        path: component.path,
        ...explicit,
      });
    }
  }
  return blockers;
}

function buildLegacyContentComponents(definition) {
  return flattenRequirements(definition && definition.contentRequirements).map(
    (entry, index) => {
      const path = entry.pathParts.join(".");
      const authority = readPath(
        definition && definition.contentAuthority,
        entry.pathParts,
      );
      const requirement = normalizeValue(entry.requirement);
      return {
        component: entry.pathParts.at(-1) || `component_${index + 1}`,
        path,
        resolvedProfileID: authority ? path : "",
        authority,
        runtimeValid: Boolean(authority),
        completeness: authority
          ? ABYSSAL_CONTENT_COMPLETENESS_STATUS.COMPLETE
          : ABYSSAL_CONTENT_COMPLETENESS_STATUS.MISSING,
        requirement,
      };
    },
  );
}

function buildRetailParityViolations(definition) {
  const level = ABYSSAL_CONTENT_COMPLETENESS_LEVEL.CAPTURED_RETAIL_COMPLETE;
  const audit = auditResolvedAbyssalContentCompleteness(definition);
  const violations = (audit.blockersByLevel[level] || []).map((blocker) => ({
    code: "RETAIL_PARITY_REQUIREMENT_NOT_MET",
    path: blocker.path || blocker.component || "unknown",
    component: blocker.component || "unknown",
    requirement: ABYSSAL_CONTENT_COMPONENT_REQUIREMENT.REQUIRED,
    policy: ABYSSAL_CONTENT_COMPLETENESS_POLICY.RETAIL_PARITY,
    resolvedAuthority: blocker.currentAuthority || null,
    requiredAuthority: blocker.requiredAuthority ||
      ABYSSAL_CONTENT_AUTHORITY.CAPTURED_RETAIL,
    reason: blocker.reason || "CAPTURED_RETAIL_EVIDENCE_REQUIRED",
  }));
  const sourceComponents = Array.isArray(definition.contentComponents)
    ? definition.contentComponents
    : [];
  for (const sourceComponent of sourceComponents) {
    const component = normalizeAbyssalContentComponent(sourceComponent);
    if (!componentRequiredForLevel(component, level)) continue;
    for (const [facet, rawAuthority] of Object.entries(component.details)) {
      if (!facet.endsWith("Authority")) continue;
      const authority = normalizeValue(rawAuthority);
      if (
        Object.values(ABYSSAL_CONTENT_VALIDATION_AUTHORITY).includes(authority)
      ) {
        continue;
      }
      if (authority === ABYSSAL_CONTENT_AUTHORITY.CAPTURED_RETAIL) continue;
      violations.push({
        code: "RETAIL_PARITY_FACET_AUTHORITY_NOT_ALLOWED",
        path: `${component.path}.details.${facet}`,
        component: component.component,
        requirement: component.requirement,
        policy: ABYSSAL_CONTENT_COMPLETENESS_POLICY.RETAIL_PARITY,
        resolvedAuthority: AUTHORITY_VALUES.includes(authority)
          ? authority
          : rawAuthority == null
            ? null
            : String(rawAuthority),
        requiredAuthority: ABYSSAL_CONTENT_AUTHORITY.CAPTURED_RETAIL,
        reason: AUTHORITY_VALUES.includes(authority)
          ? "FACET_AUTHORITY_BELOW_RETAIL_PARITY"
          : "UNKNOWN_FACET_AUTHORITY",
      });
    }
  }
  return violations;
}

function auditResolvedAbyssalContentCompleteness(resolvedDefinition = null) {
  const definition = resolvedDefinition && typeof resolvedDefinition === "object"
    ? resolvedDefinition
    : {};
  const declaredCompletenessLevel = validateAbyssalContentCompletenessLevel(
    definition.declaredCompletenessLevel ||
      ABYSSAL_CONTENT_COMPLETENESS_LEVEL.PLAYABLE,
    `Abyssal filament ${String(definition.definitionID || "unknown")}`,
  );
  const sourceComponents = Array.isArray(definition.contentComponents)
    ? definition.contentComponents
    : buildLegacyContentComponents(definition);
  const components = sourceComponents.map(normalizeAbyssalContentComponent);
  const blockersByLevel = {};
  let achievedCompletenessLevel = ABYSSAL_CONTENT_COMPLETENESS_LEVEL.INCOMPLETE;
  let lowerLevelSatisfied = true;
  for (const level of ABYSSAL_CONTENT_COMPLETENESS_LEVELS) {
    const blockers = components.flatMap((component) =>
      buildComponentLevelBlockers(component, level)
    );
    blockersByLevel[level] = blockers;
    if (lowerLevelSatisfied && blockers.length === 0) {
      achievedCompletenessLevel = level;
    } else {
      lowerLevelSatisfied = false;
    }
  }
  const comparison = compareAbyssalContentCompletenessLevels(
    achievedCompletenessLevel,
    declaredCompletenessLevel,
  );
  const achievedRank =
    ABYSSAL_CONTENT_COMPLETENESS_LEVEL_RANK[achievedCompletenessLevel];
  const nextLevel = ABYSSAL_CONTENT_COMPLETENESS_LEVELS[achievedRank + 1] || null;
  const requiredComponents = components.filter((component) =>
    component.requirement === ABYSSAL_CONTENT_COMPONENT_REQUIREMENT.REQUIRED
  );
  const requiredAuthorityCounts = Object.fromEntries(
    [...AUTHORITY_VALUES, ...Object.values(ABYSSAL_CONTENT_VALIDATION_AUTHORITY)]
      .map((authority) => [authority, 0]),
  );
  const statusCounts = Object.fromEntries(
    Object.values(ABYSSAL_CONTENT_COMPLETENESS_STATUS)
      .map((status) => [status, 0]),
  );
  for (const component of requiredComponents) {
    if (Object.hasOwn(requiredAuthorityCounts, component.authority)) {
      requiredAuthorityCounts[component.authority] += 1;
    }
    statusCounts[component.completeness] += 1;
  }
  return {
    filamentTypeID: Number(definition.filamentTypeID) || 0,
    definitionID: String(definition.definitionID || ""),
    filamentName: String(definition.filamentName || ""),
    tier: Number.isFinite(Number(definition.tier))
      ? Math.trunc(Number(definition.tier))
      : null,
    weather: String(definition.weatherType || ""),
    hullMode: String(definition.hullMode || ""),
    declaredCompletenessLevel,
    achievedCompletenessLevel,
    regression: comparison < 0,
    promotionAvailable: comparison > 0,
    nextLevel,
    nextLevelBlockers: nextLevel ? blockersByLevel[nextLevel] || [] : [],
    declaredLevelBlockers: blockersByLevel[declaredCompletenessLevel] || [],
    blockersByLevel,
    components,
    requiredComponentCount: requiredComponents.length,
    requiredAuthorityCounts,
    requiredStatusCounts: statusCounts,
    fallbackCount: components.filter((component) => component.fallbackUsed).length,
  };
}

function validateResolvedFilamentCompleteness(resolvedDefinition = null) {
  const audit = auditResolvedAbyssalContentCompleteness(resolvedDefinition);
  if (!audit.regression) {
    return {
      success: true,
      promotionAvailable: audit.promotionAvailable,
      audit,
    };
  }
  return {
    success: false,
    errorCode: "ABYSSAL_CONTENT_COMPLETENESS_REGRESSION",
    errorMsg: "ABYSSAL_CONTENT_COMPLETENESS_REGRESSION",
    declaredCompletenessLevel: audit.declaredCompletenessLevel,
    achievedCompletenessLevel: audit.achievedCompletenessLevel,
    blockers: audit.declaredLevelBlockers,
    audit,
  };
}

function readPath(source, pathParts) {
  let current = source;
  for (const part of pathParts) {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    current = current[String(part)];
  }
  return current;
}

function flattenRequirements(source, pathParts = []) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return [];
  }
  const entries = [];
  for (const [key, value] of Object.entries(source)) {
    const nextPath = [...pathParts, String(key)];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      entries.push(...flattenRequirements(value, nextPath));
      continue;
    }
    entries.push({ pathParts: nextPath, requirement: value });
  }
  return entries;
}

function buildAbyssalContentCompletenessReport(resolvedDefinition = null) {
  const definition = resolvedDefinition && typeof resolvedDefinition === "object"
    ? resolvedDefinition
    : {};
  const policyValue = definition.contentCompletenessPolicy;
  let policy = normalizeValue(policyValue);
  const violations = [];
  if (!COMPLETENESS_POLICY_VALUES.includes(policy)) {
    violations.push({
      code: "UNKNOWN_COMPLETENESS_POLICY",
      path: "contentCompletenessPolicy",
      component: "contentCompletenessPolicy",
      requirement: ABYSSAL_CONTENT_COMPONENT_REQUIREMENT.REQUIRED,
      resolvedAuthority: null,
      value: policyValue == null ? null : String(policyValue),
    });
    policy = "";
  }

  const authorityCounts = Object.fromEntries(
    AUTHORITY_VALUES.map((authority) => [authority, 0]),
  );
  const placeholderComponents = [];
  const provisionalComponents = [];
  const optionalComponents = [];
  const notApplicableComponents = [];
  let requiredComponents = 0;
  let acceptedComponents = 0;

  for (const entry of flattenRequirements(definition.contentRequirements)) {
    const path = entry.pathParts.join(".");
    const component = entry.pathParts.at(-1) || "unknown";
    let requirement = normalizeValue(entry.requirement);
    if (!COMPONENT_REQUIREMENT_VALUES.includes(requirement)) {
      violations.push({
        code: "UNKNOWN_COMPONENT_REQUIREMENT",
        path,
        component,
        requirement: entry.requirement == null ? null : String(entry.requirement),
        resolvedAuthority: null,
      });
      requirement = ABYSSAL_CONTENT_COMPONENT_REQUIREMENT.REQUIRED;
    }
    if (requirement === ABYSSAL_CONTENT_COMPONENT_REQUIREMENT.NOT_APPLICABLE) {
      notApplicableComponents.push(path);
      continue;
    }
    if (requirement === ABYSSAL_CONTENT_COMPONENT_REQUIREMENT.REQUIRED) {
      requiredComponents += 1;
    } else {
      optionalComponents.push(path);
    }

    const rawAuthority = readPath(definition.contentAuthority, entry.pathParts);
    const authority = normalizeValue(rawAuthority);
    if (!AUTHORITY_VALUES.includes(authority)) {
      const authorityMissing = rawAuthority == null || authority === "";
      if (
        requirement === ABYSSAL_CONTENT_COMPONENT_REQUIREMENT.REQUIRED ||
        !authorityMissing
      ) {
        violations.push({
          code: authorityMissing
            ? "CONTENT_AUTHORITY_MISSING"
            : "UNKNOWN_CONTENT_AUTHORITY",
          path,
          component,
          requirement,
          resolvedAuthority: rawAuthority == null ? null : String(rawAuthority),
        });
      }
      continue;
    }

    authorityCounts[authority] += 1;
    if (authority === ABYSSAL_CONTENT_AUTHORITY.DEBUG_PLACEHOLDER) {
      placeholderComponents.push(path);
    }
    if (authority === ABYSSAL_CONTENT_AUTHORITY.PROVISIONAL) {
      provisionalComponents.push(path);
    }

    const acceptedAuthorities = ACCEPTED_AUTHORITIES_BY_POLICY[policy];
    if (
      requirement === ABYSSAL_CONTENT_COMPONENT_REQUIREMENT.REQUIRED &&
      (!acceptedAuthorities || !acceptedAuthorities.has(authority))
    ) {
      violations.push({
        code: "CONTENT_AUTHORITY_NOT_ALLOWED",
        path,
        component,
        requirement,
        policy: policy || null,
        resolvedAuthority: authority,
      });
      continue;
    }
    if (requirement === ABYSSAL_CONTENT_COMPONENT_REQUIREMENT.REQUIRED) {
      acceptedComponents += 1;
    }
  }

  if (policy === ABYSSAL_CONTENT_COMPLETENESS_POLICY.RETAIL_PARITY) {
    const existingPaths = new Set(violations.map((entry) => entry.path));
    for (const violation of buildRetailParityViolations(definition)) {
      if (existingPaths.has(violation.path)) continue;
      violations.push(violation);
      existingPaths.add(violation.path);
    }
  }

  return {
    policy: policy || null,
    complete:
      violations.length === 0 && acceptedComponents === requiredComponents,
    requiredComponents,
    acceptedComponents,
    optionalComponents,
    notApplicableComponents,
    placeholderComponents,
    provisionalComponents,
    authorityCounts,
    violations,
  };
}

module.exports = {
  ABYSSAL_CONTENT_AUTHORITY,
  ABYSSAL_CONTENT_AUTHORITY_SEMANTICS,
  ABYSSAL_CONTENT_VALIDATION_AUTHORITY,
  ABYSSAL_CONTENT_COMPLETENESS_POLICY,
  ABYSSAL_CONTENT_COMPLETENESS_POLICY_SEMANTICS,
  ABYSSAL_CONTENT_COMPLETENESS_STATUS,
  ABYSSAL_CONTENT_COMPLETENESS_STATUS_SEMANTICS,
  ABYSSAL_CONTENT_COMPLETENESS_LEVEL,
  ABYSSAL_CONTENT_COMPLETENESS_LEVEL_SEMANTICS,
  ABYSSAL_CONTENT_COMPLETENESS_LEVEL_RANK,
  ABYSSAL_CONTENT_COMPONENT_REQUIREMENT,
  auditResolvedAbyssalContentCompleteness,
  buildAbyssalContentCompletenessReport,
  compareAbyssalContentCompletenessLevels,
  isAbyssalContentAuthority,
  normalizeAbyssalContentComponent,
  validateAbyssalContentAuthority,
  validateAbyssalContentCompletenessLevel,
  validateAbyssalContentCompletenessPolicy,
  validateAbyssalContentComponentRequirement,
  validateResolvedFilamentCompleteness,
};
