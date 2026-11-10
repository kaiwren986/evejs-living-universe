"use strict";

const crypto = require("node:crypto");

const AUTHORITY_SCHEMA_VERSION = 1;
const AUTHORITY_CLASSES = new Set([
  "evidence_snapshot",
  "project_generated",
  "tranquility_exact",
]);
const FALLBACK_POLICY_FAIL_CLOSED = "fail_closed";
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
// The public atlas displays two decimal places of percent. Independent row
// rounding can therefore produce a displayed total of 100.01% without the
// underlying composition exceeding 100%. Keep this identical to the collector.
const MAX_DISPLAYED_FRACTION_TOTAL = 1.00011;

class MoonResourceAuthorityError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "MoonResourceAuthorityError";
    this.code = code;
    this.details = details;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function isNonEmptyText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function issue(code, path, message) {
  return { code, path, message };
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function canonicalizeJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("authority content contains a non-finite number");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalizeJson);
  }
  if (!isPlainObject(value)) {
    throw new TypeError("authority content must contain JSON-compatible values only");
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalizeJson(value[key])]),
  );
}

function buildHashPayload(dataset) {
  if (!isPlainObject(dataset)) {
    return dataset;
  }
  const payload = { ...dataset };
  delete payload.contentHash;

  if (Array.isArray(payload.provenance)) {
    payload.provenance = [...payload.provenance].sort((left, right) =>
      String(left && left.sourceID).localeCompare(String(right && right.sourceID)),
    );
  }
  if (Array.isArray(payload.profiles)) {
    payload.profiles = payload.profiles
      .map((profile) => {
        if (!isPlainObject(profile) || !Array.isArray(profile.composition)) {
          return profile;
        }
        return {
          ...profile,
          composition: [...profile.composition].sort(
            (left, right) => Number(left && left.typeID) - Number(right && right.typeID),
          ),
        };
      })
      .sort((left, right) => Number(left && left.moonID) - Number(right && right.moonID));
  }
  return canonicalizeJson(payload);
}

function calculateAuthorityContentHash(dataset) {
  const canonicalPayload = JSON.stringify(buildHashPayload(dataset));
  return crypto.createHash("sha256").update(canonicalPayload, "utf8").digest("hex");
}

function validateProvenance(provenance, issues) {
  if (!Array.isArray(provenance) || provenance.length === 0) {
    issues.push(issue(
      "PROVENANCE_REQUIRED",
      "provenance",
      "at least one provenance record is required",
    ));
    return;
  }

  const seenSourceIDs = new Set();
  provenance.forEach((entry, index) => {
    const entryPath = `provenance[${index}]`;
    if (!isPlainObject(entry)) {
      issues.push(issue("INVALID_PROVENANCE", entryPath, "provenance must be an object"));
      return;
    }
    if (!isNonEmptyText(entry.sourceID)) {
      issues.push(issue("INVALID_SOURCE_ID", `${entryPath}.sourceID`, "sourceID is required"));
    } else if (seenSourceIDs.has(entry.sourceID)) {
      issues.push(issue(
        "DUPLICATE_SOURCE_ID",
        `${entryPath}.sourceID`,
        `sourceID ${entry.sourceID} is duplicated`,
      ));
    } else {
      seenSourceIDs.add(entry.sourceID);
    }
    if (!isNonEmptyText(entry.sourceKind)) {
      issues.push(issue(
        "INVALID_SOURCE_KIND",
        `${entryPath}.sourceKind`,
        "sourceKind is required",
      ));
    }
    if (!isNonEmptyText(entry.sourceVersion)) {
      issues.push(issue(
        "INVALID_SOURCE_VERSION",
        `${entryPath}.sourceVersion`,
        "sourceVersion is required",
      ));
    }
    if (!SHA256_PATTERN.test(String(entry.sha256 || ""))) {
      issues.push(issue(
        "INVALID_SOURCE_HASH",
        `${entryPath}.sha256`,
        "sha256 must be a 64-character hexadecimal digest",
      ));
    }
  });
}

function validateProfile(profile, index, datasetVersion, seenMoonIDs, seenProfileIDs, issues) {
  const profilePath = `profiles[${index}]`;
  if (!isPlainObject(profile)) {
    issues.push(issue("INVALID_PROFILE", profilePath, "profile must be an object"));
    return;
  }

  if (!isPositiveInteger(profile.moonID)) {
    issues.push(issue("INVALID_MOON_ID", `${profilePath}.moonID`, "moonID must be positive"));
  } else if (seenMoonIDs.has(profile.moonID)) {
    issues.push(issue(
      "DUPLICATE_MOON_ID",
      `${profilePath}.moonID`,
      `moonID ${profile.moonID} is duplicated`,
    ));
  } else {
    seenMoonIDs.add(profile.moonID);
  }

  if (!isPositiveInteger(profile.solarSystemID)) {
    issues.push(issue(
      "INVALID_SOLAR_SYSTEM_ID",
      `${profilePath}.solarSystemID`,
      "solarSystemID must be positive",
    ));
  }
  if (!isNonEmptyText(profile.profileID)) {
    issues.push(issue("INVALID_PROFILE_ID", `${profilePath}.profileID`, "profileID is required"));
  } else if (seenProfileIDs.has(profile.profileID)) {
    issues.push(issue(
      "DUPLICATE_PROFILE_ID",
      `${profilePath}.profileID`,
      `profileID ${profile.profileID} is duplicated`,
    ));
  } else {
    seenProfileIDs.add(profile.profileID);
  }
  if (profile.datasetVersion !== datasetVersion) {
    issues.push(issue(
      "MIXED_DATASET_VERSION",
      `${profilePath}.datasetVersion`,
      "profile datasetVersion must match the containing dataset",
    ));
  }
  if (profile.sourceStatus !== "valid") {
    issues.push(issue(
      "UNUSABLE_SOURCE_PROFILE",
      `${profilePath}.sourceStatus`,
      "only profiles whose complete source data is valid may enter authority",
    ));
  }
  if (!Array.isArray(profile.composition) || profile.composition.length === 0) {
    issues.push(issue(
      "EMPTY_COMPOSITION",
      `${profilePath}.composition`,
      "composition must contain at least one ore",
    ));
    return;
  }

  const seenTypeIDs = new Set();
  let totalFraction = 0;
  let allFractionsValid = true;
  profile.composition.forEach((resource, resourceIndex) => {
    const resourcePath = `${profilePath}.composition[${resourceIndex}]`;
    if (!isPlainObject(resource)) {
      issues.push(issue("INVALID_RESOURCE", resourcePath, "resource must be an object"));
      allFractionsValid = false;
      return;
    }
    if (!isPositiveInteger(resource.typeID)) {
      issues.push(issue(
        "INVALID_RESOURCE_TYPE_ID",
        `${resourcePath}.typeID`,
        "typeID must be positive",
      ));
    } else if (seenTypeIDs.has(resource.typeID)) {
      issues.push(issue(
        "DUPLICATE_RESOURCE_TYPE_ID",
        `${resourcePath}.typeID`,
        `typeID ${resource.typeID} is duplicated within the profile`,
      ));
    } else {
      seenTypeIDs.add(resource.typeID);
    }

    if (!Number.isFinite(resource.fraction) || resource.fraction <= 0 || resource.fraction > 1) {
      issues.push(issue(
        "INVALID_RESOURCE_FRACTION",
        `${resourcePath}.fraction`,
        "fraction must be a finite number greater than 0 and no greater than 1",
      ));
      allFractionsValid = false;
    } else {
      totalFraction += resource.fraction;
    }
  });

  if (allFractionsValid && totalFraction > MAX_DISPLAYED_FRACTION_TOTAL) {
    issues.push(issue(
      "RESOURCE_TOTAL_OVER_ONE",
      `${profilePath}.composition`,
      `resource fractions total ${totalFraction}, which exceeds the display-rounding limit`,
    ));
  }
}

function validateAuthorityDataset(dataset) {
  const issues = [];
  if (!isPlainObject(dataset)) {
    return [issue("INVALID_DATASET", "$", "authority dataset must be an object")];
  }

  if (dataset.schemaVersion !== AUTHORITY_SCHEMA_VERSION) {
    issues.push(issue(
      "UNSUPPORTED_SCHEMA_VERSION",
      "schemaVersion",
      `schemaVersion must equal ${AUTHORITY_SCHEMA_VERSION}`,
    ));
  }
  if (!isNonEmptyText(dataset.datasetVersion)) {
    issues.push(issue("INVALID_DATASET_VERSION", "datasetVersion", "datasetVersion is required"));
  }
  if (!isPositiveInteger(dataset.sourceBuild)) {
    issues.push(issue("INVALID_SOURCE_BUILD", "sourceBuild", "sourceBuild must be positive"));
  }
  if (!AUTHORITY_CLASSES.has(dataset.authorityClass)) {
    issues.push(issue(
      "INVALID_AUTHORITY_CLASS",
      "authorityClass",
      `authorityClass must be one of ${[...AUTHORITY_CLASSES].join(", ")}`,
    ));
  }
  if (typeof dataset.tranquilityExact !== "boolean") {
    issues.push(issue(
      "INVALID_EXACTNESS_FLAG",
      "tranquilityExact",
      "tranquilityExact must be a boolean",
    ));
  } else if (
    (dataset.authorityClass === "tranquility_exact") !== dataset.tranquilityExact
  ) {
    issues.push(issue(
      "EXACTNESS_CLASS_MISMATCH",
      "tranquilityExact",
      "tranquilityExact must agree with authorityClass",
    ));
  }
  if (dataset.fallbackPolicy !== FALLBACK_POLICY_FAIL_CLOSED) {
    issues.push(issue(
      "UNSAFE_FALLBACK_POLICY",
      "fallbackPolicy",
      `fallbackPolicy must equal ${FALLBACK_POLICY_FAIL_CLOSED}`,
    ));
  }

  validateProvenance(dataset.provenance, issues);

  if (!Array.isArray(dataset.profiles)) {
    issues.push(issue("INVALID_PROFILES", "profiles", "profiles must be an array"));
  } else {
    const seenMoonIDs = new Set();
    const seenProfileIDs = new Set();
    dataset.profiles.forEach((profile, index) => validateProfile(
      profile,
      index,
      dataset.datasetVersion,
      seenMoonIDs,
      seenProfileIDs,
      issues,
    ));
  }

  if (!SHA256_PATTERN.test(String(dataset.contentHash || ""))) {
    issues.push(issue(
      "INVALID_CONTENT_HASH",
      "contentHash",
      "contentHash must be a 64-character hexadecimal digest",
    ));
  } else {
    try {
      const calculatedHash = calculateAuthorityContentHash(dataset);
      if (calculatedHash !== dataset.contentHash.toLowerCase()) {
        issues.push(issue(
          "CONTENT_HASH_MISMATCH",
          "contentHash",
          `contentHash does not match canonical authority content (${calculatedHash})`,
        ));
      }
    } catch (error) {
      issues.push(issue(
        "UNHASHABLE_AUTHORITY_CONTENT",
        "$",
        error.message,
      ));
    }
  }

  return issues;
}

function normalizeProfile(profile) {
  const composition = profile.composition
    .map((resource) => ({
      typeID: resource.typeID,
      fraction: resource.fraction,
    }))
    .sort((left, right) => left.typeID - right.typeID);
  const compositionTotal = composition.reduce(
    (total, resource) => total + resource.fraction,
    0,
  );
  return deepFreeze({
    moonID: profile.moonID,
    solarSystemID: profile.solarSystemID,
    profileID: profile.profileID,
    datasetVersion: profile.datasetVersion,
    sourceStatus: profile.sourceStatus,
    composition,
    compositionTotal,
  });
}

function createMoonResourceAuthority(dataset) {
  const issues = validateAuthorityDataset(dataset);
  if (issues.length > 0) {
    throw new MoonResourceAuthorityError(
      "INVALID_AUTHORITY_DATASET",
      `moon resource authority rejected ${issues.length} validation issue(s)`,
      { issues },
    );
  }

  const profilesByMoonID = new Map();
  for (const profile of dataset.profiles) {
    profilesByMoonID.set(profile.moonID, normalizeProfile(profile));
  }

  const metadata = deepFreeze({
    schemaVersion: dataset.schemaVersion,
    datasetVersion: dataset.datasetVersion,
    sourceBuild: dataset.sourceBuild,
    authorityClass: dataset.authorityClass,
    tranquilityExact: dataset.tranquilityExact,
    fallbackPolicy: dataset.fallbackPolicy,
    contentHash: dataset.contentHash.toLowerCase(),
    profileCount: profilesByMoonID.size,
    provenance: dataset.provenance
      .map((entry) => deepFreeze({
        sourceID: entry.sourceID,
        sourceKind: entry.sourceKind,
        sourceVersion: entry.sourceVersion,
        sha256: entry.sha256.toLowerCase(),
      }))
      .sort((left, right) => left.sourceID.localeCompare(right.sourceID)),
  });

  return deepFreeze({
    metadata,
    hasMoonProfile(moonID) {
      return isPositiveInteger(moonID) && profilesByMoonID.has(moonID);
    },
    getMoonProfile(moonID) {
      if (!isPositiveInteger(moonID)) {
        throw new MoonResourceAuthorityError(
          "INVALID_MOON_ID",
          "moonID must be a positive integer",
          { moonID },
        );
      }
      const profile = profilesByMoonID.get(moonID);
      if (!profile) {
        throw new MoonResourceAuthorityError(
          "MOON_PROFILE_NOT_FOUND",
          `no authoritative resource profile exists for moon ${moonID}`,
          {
            moonID,
            datasetVersion: metadata.datasetVersion,
            fallbackPolicy: metadata.fallbackPolicy,
          },
        );
      }
      return profile;
    },
  });
}

module.exports = {
  AUTHORITY_SCHEMA_VERSION,
  FALLBACK_POLICY_FAIL_CLOSED,
  MoonResourceAuthorityError,
  calculateAuthorityContentHash,
  createMoonResourceAuthority,
  validateAuthorityDataset,
};
