"use strict";
const { normalizeLowerText, toInt, normalizeText } = require("../domain/abyssalRuntimeValues");

function listAbyssalSceneryProbeCandidateKeys(ports) {
  const {
    ABYSSAL_SCENERY_PROBE_PROFILE,
  } = ports;
  return Object.keys(ABYSSAL_SCENERY_PROBE_PROFILE.candidates);
}

function getAbyssalSceneryProbeCandidateIndex(ports, candidateKey) {
  const normalizedCandidateKey = normalizeLowerText(candidateKey, "");
  if (!normalizedCandidateKey) {
    return -1;
  }
  return listAbyssalSceneryProbeCandidateKeys(ports).indexOf(normalizedCandidateKey);
}

function resolveAbyssalSceneryProbeCandidate(ports, candidateKey) {
  const {
    cloneValue,
    ABYSSAL_SCENERY_PROBE_PROFILE,
  } = ports;
  const normalizedCandidateKey = normalizeLowerText(candidateKey, "");
  if (!normalizedCandidateKey) {
    return null;
  }
  return cloneValue(ABYSSAL_SCENERY_PROBE_PROFILE.candidates[normalizedCandidateKey]) || null;
}

function listAbyssalSceneryProbeCatalogueCategoryKeys(ports) {
  return [
    "all",
    "environment",
    "structure",
    "cloud",
    "gas",
    "dust",
    "plasma",
    "nebula",
    "smoke",
    "debris",
    "other_environment",
  ];
}

function resolveAbyssalSceneryProbeCatalogueCategory(ports, categoryKey) {
  const normalizedCategoryKey = normalizeLowerText(categoryKey, "all");
  if (normalizedCategoryKey === "all") {
    return {
      key: "all",
      label: "all",
      matches(candidate) {
        return Boolean(candidate);
      },
    };
  }
  if (normalizedCategoryKey === "environment") {
    return {
      key: "environment",
      label: "environment",
      matches(candidate) {
        return normalizeLowerText(candidate && candidate.categoryKey, "") !== "structure";
      },
    };
  }
  if (listAbyssalSceneryProbeCatalogueCategoryKeys(ports).includes(normalizedCategoryKey)) {
    return {
      key: normalizedCategoryKey,
      label: normalizedCategoryKey,
      matches(candidate) {
        return normalizeLowerText(candidate && candidate.categoryKey, "") === normalizedCategoryKey;
      },
    };
  }
  return null;
}

function buildAbyssalSceneryProbeCatalogueEntry(ports, candidate, deps = ports.getDependencies()) {
  if (!candidate || toInt(candidate.typeID, 0) <= 0) {
    return null;
  }
  const typeRecord = deps.resolveItemByTypeID(toInt(candidate.typeID, 0)) || null;
  const resolvedRadius = Number.isFinite(Number(typeRecord && typeRecord.radius))
    ? Number(typeRecord.radius)
    : 0;
  const radiusOverrideMeters = Number.isFinite(Number(candidate && candidate.radiusOverrideMeters))
    ? Math.max(0, Number(candidate.radiusOverrideMeters))
    : 0;
  const effectiveRadiusMeters = Math.max(radiusOverrideMeters || 0, resolvedRadius || 0);
  const catalogueIndex = getAbyssalSceneryProbeCandidateIndex(ports, candidate.key);
  return {
    key: normalizeText(candidate && candidate.key, ""),
    categoryKey: normalizeText(candidate && candidate.categoryKey, "other_environment"),
    typeID: toInt(candidate && candidate.typeID, 0),
    typeName: normalizeText(typeRecord && typeRecord.name, candidate && candidate.typeName),
    groupID: toInt(typeRecord && typeRecord.groupID, 0),
    groupName: normalizeText(typeRecord && typeRecord.groupName, "unknown"),
    categoryID: toInt(typeRecord && typeRecord.categoryID, 0),
    categoryName: normalizeText(typeRecord && typeRecord.categoryName, "unknown"),
    graphicID: toInt(typeRecord && typeRecord.graphicID, 0),
    radiusMeters: resolvedRadius,
    radiusOverrideMeters,
    effectiveRadiusMeters,
    notes: normalizeText(candidate && candidate.notes, "none"),
    diagnosticTag: normalizeText(candidate && candidate.diagnosticTag, "none"),
    resolvedLocally: Boolean(typeRecord),
    safeForProbeAllowlist: Boolean(typeRecord),
    likelyVisibleThroughAddBalls: typeRecord
      ? (
        radiusOverrideMeters > 0 ||
        toInt(typeRecord.groupID, 0) === 226 ||
        toInt(typeRecord.groupID, 0) === 1975
      )
      : false,
    catalogueIndex: catalogueIndex >= 0 ? catalogueIndex + 1 : 0,
    catalogueSize: listAbyssalSceneryProbeCandidateKeys(ports).length,
  };
}

function listAbyssalSceneryProbeCatalogue(ports, categoryKey = "all", deps = ports.getDependencies()) {
  const category = resolveAbyssalSceneryProbeCatalogueCategory(ports, categoryKey);
  if (!category) {
    return {
      success: false,
      errorMsg: "CATEGORY_NOT_ALLOWLISTED",
      data: {
        allowlistKeys: listAbyssalSceneryProbeCatalogueCategoryKeys(ports),
      },
    };
  }
  const entries = listAbyssalSceneryProbeCandidateKeys(ports)
    .map((candidateKey) => buildAbyssalSceneryProbeCatalogueEntry(ports,
      resolveAbyssalSceneryProbeCandidate(ports, candidateKey),
      deps,
    ))
    .filter(Boolean)
    .filter((entry) => category.matches(entry));
  return {
    success: true,
    data: {
      categoryKey: category.key,
      categoryLabel: category.label,
      totalCount: entries.length,
      entries,
      allowlistKeys: listAbyssalSceneryProbeCatalogueCategoryKeys(ports),
    },
  };
}

function listAbyssalSceneryProbePresetKeys(ports) {
  const {
    ABYSSAL_SCENERY_PROBE_PROFILE,
  } = ports;
  return Object.keys(ABYSSAL_SCENERY_PROBE_PROFILE.positionPresets);
}

function resolveAbyssalSceneryProbePreset(ports, presetKey) {
  const {
    cloneValue,
    ABYSSAL_SCENERY_PROBE_PROFILE,
  } = ports;
  const normalizedPresetKey = normalizeLowerText(presetKey, "near");
  return cloneValue(ABYSSAL_SCENERY_PROBE_PROFILE.positionPresets[normalizedPresetKey]) || null;
}

function createAbyssalProbeCatalogue(ports) {
  return {
    listAbyssalSceneryProbeCandidateKeys: listAbyssalSceneryProbeCandidateKeys.bind(null, ports),
    getAbyssalSceneryProbeCandidateIndex: getAbyssalSceneryProbeCandidateIndex.bind(null, ports),
    resolveAbyssalSceneryProbeCandidate: resolveAbyssalSceneryProbeCandidate.bind(null, ports),
    listAbyssalSceneryProbeCatalogueCategoryKeys: listAbyssalSceneryProbeCatalogueCategoryKeys.bind(null, ports),
    resolveAbyssalSceneryProbeCatalogueCategory: resolveAbyssalSceneryProbeCatalogueCategory.bind(null, ports),
    buildAbyssalSceneryProbeCatalogueEntry: buildAbyssalSceneryProbeCatalogueEntry.bind(null, ports),
    listAbyssalSceneryProbeCatalogue: listAbyssalSceneryProbeCatalogue.bind(null, ports),
    listAbyssalSceneryProbePresetKeys: listAbyssalSceneryProbePresetKeys.bind(null, ports),
    resolveAbyssalSceneryProbePreset: resolveAbyssalSceneryProbePreset.bind(null, ports),
  };
}

module.exports = { createAbyssalProbeCatalogue };
