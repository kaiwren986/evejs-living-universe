"use strict";

const MOON_MINING_MODE = Object.freeze({
  MANUAL: "manual",
  METENOX: "metenox",
});

const MOON_MINING_SECURITY_CLASS = Object.freeze({
  HIGHSEC: "highsec",
  LOWSEC: "lowsec",
  NULLSEC: "nullsec",
  WORMHOLE: "wormhole",
  POCHVEN: "pochven",
});

const MINING_POINT_STATUS = Object.freeze({
  VERIFIED: "verified",
  MISSING: "missing",
  INVALID: "invalid",
  MISMATCHED: "mismatched",
});

const RESOURCE_PROFILE_STATUS = Object.freeze({
  READY: "ready",
  MISSING: "missing",
  INVALID: "invalid",
  MISMATCHED: "mismatched",
});

const ELIGIBILITY_CODE = Object.freeze({
  LOCATION_ELIGIBLE: "MOON_MINING_LOCATION_ELIGIBLE",
  OPERATION_READY: "MOON_MINING_OPERATION_READY",
  INVALID_MODE: "MOON_MINING_INVALID_MODE",
  INVALID_SYSTEM: "MOON_MINING_INVALID_SYSTEM",
  INVALID_MOON: "MOON_MINING_INVALID_MOON",
  INVALID_SECURITY_STATUS: "MOON_MINING_INVALID_SECURITY_STATUS",
  INVALID_SECURITY_CLASS: "MOON_MINING_INVALID_SECURITY_CLASS",
  SECURITY_CLASS_MISMATCH: "MOON_MINING_SECURITY_CLASS_MISMATCH",
  SECURITY_CLASS_DISALLOWED: "MOON_MINING_SECURITY_CLASS_DISALLOWED",
  MANUAL_SECURITY_TOO_HIGH: "MOON_MINING_MANUAL_SECURITY_TOO_HIGH",
  MINING_POINT_MISSING: "MOON_MINING_POINT_MISSING",
  MINING_POINT_INVALID: "MOON_MINING_POINT_INVALID",
  MINING_POINT_MISMATCHED: "MOON_MINING_POINT_MISMATCHED",
  MINING_POINT_SYSTEM_MISMATCH: "MOON_MINING_POINT_SYSTEM_MISMATCH",
  MINING_POINT_MOON_MISMATCH: "MOON_MINING_POINT_MOON_MISMATCH",
  RESOURCE_PROFILE_MISSING: "MOON_RESOURCE_PROFILE_MISSING",
  RESOURCE_PROFILE_INVALID: "MOON_RESOURCE_PROFILE_INVALID",
  RESOURCE_PROFILE_MISMATCHED: "MOON_RESOURCE_PROFILE_MISMATCHED",
  RESOURCE_PROFILE_SYSTEM_MISMATCH: "MOON_RESOURCE_PROFILE_SYSTEM_MISMATCH",
  RESOURCE_PROFILE_MOON_MISMATCH: "MOON_RESOURCE_PROFILE_MOON_MISMATCH",
});

const KNOWN_SPACE_CLASSES = new Set([
  MOON_MINING_SECURITY_CLASS.HIGHSEC,
  MOON_MINING_SECURITY_CLASS.LOWSEC,
  MOON_MINING_SECURITY_CLASS.NULLSEC,
]);
const SUPPORTED_SECURITY_CLASSES = new Set(Object.values(MOON_MINING_SECURITY_CLASS));

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function isFiniteSecurityStatus(value) {
  return Number.isFinite(value) && value >= -1 && value <= 1;
}

function roundDisplayedSecurityStatus(value) {
  if (!isFiniteSecurityStatus(value)) {
    return null;
  }
  if (value > 0 && value < 0.05) {
    return 0.1;
  }
  const rounded = value >= 0
    ? Math.floor((value * 10) + 0.5) / 10
    : Math.ceil((value * 10) - 0.5) / 10;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function classifyKnownSpaceSecurity(securityStatus) {
  if (!isFiniteSecurityStatus(securityStatus)) {
    return null;
  }
  if (securityStatus >= 0.45) {
    return MOON_MINING_SECURITY_CLASS.HIGHSEC;
  }
  if (securityStatus > 0) {
    return MOON_MINING_SECURITY_CLASS.LOWSEC;
  }
  return MOON_MINING_SECURITY_CLASS.NULLSEC;
}

function locationFailure(mode, code, details = {}) {
  return deepFreeze({
    mode,
    eligible: false,
    code,
    ...details,
  });
}

function readinessFailure(code, details = {}) {
  return deepFreeze({
    ready: false,
    code,
    ...details,
  });
}

function validateSystemAuthority(mode, system) {
  if (!system || typeof system !== "object" || !isPositiveInteger(system.solarSystemID)) {
    return locationFailure(mode, ELIGIBILITY_CODE.INVALID_SYSTEM);
  }

  const securityClass = String(system.securityClass || "").trim().toLowerCase();
  if (!SUPPORTED_SECURITY_CLASSES.has(securityClass)) {
    return locationFailure(mode, ELIGIBILITY_CODE.INVALID_SECURITY_CLASS, {
      solarSystemID: system.solarSystemID,
    });
  }

  const securityStatus = system.securityStatus;
  if (!isFiniteSecurityStatus(securityStatus)) {
    return locationFailure(mode, ELIGIBILITY_CODE.INVALID_SECURITY_STATUS, {
      solarSystemID: system.solarSystemID,
      securityClass,
    });
  }

  if (KNOWN_SPACE_CLASSES.has(securityClass)) {
    const derivedClass = classifyKnownSpaceSecurity(securityStatus);
    if (derivedClass !== securityClass) {
      return locationFailure(mode, ELIGIBILITY_CODE.SECURITY_CLASS_MISMATCH, {
        solarSystemID: system.solarSystemID,
        securityStatus,
        securityClass,
        derivedClass,
      });
    }
  }

  return deepFreeze({
    valid: true,
    solarSystemID: system.solarSystemID,
    securityStatus,
    displayedSecurityStatus: roundDisplayedSecurityStatus(securityStatus),
    securityClass,
  });
}

function validateMiningPointAuthority(mode, systemAuthority, moonID, miningPoint) {
  if (!miningPoint || typeof miningPoint !== "object") {
    return locationFailure(mode, ELIGIBILITY_CODE.MINING_POINT_MISSING, {
      solarSystemID: systemAuthority.solarSystemID,
      moonID,
    });
  }

  const status = String(miningPoint.status || "").trim().toLowerCase();
  if (status !== MINING_POINT_STATUS.VERIFIED) {
    const codeByStatus = {
      [MINING_POINT_STATUS.MISSING]: ELIGIBILITY_CODE.MINING_POINT_MISSING,
      [MINING_POINT_STATUS.MISMATCHED]: ELIGIBILITY_CODE.MINING_POINT_MISMATCHED,
    };
    return locationFailure(
      mode,
      codeByStatus[status] || ELIGIBILITY_CODE.MINING_POINT_INVALID,
      {
        solarSystemID: systemAuthority.solarSystemID,
        moonID,
        miningPointStatus: status || MINING_POINT_STATUS.INVALID,
      },
    );
  }

  if (
    !isPositiveInteger(miningPoint.beaconID) ||
    !isPositiveInteger(miningPoint.solarSystemID) ||
    !isPositiveInteger(miningPoint.moonID) ||
    typeof miningPoint.datasetVersion !== "string" ||
    !miningPoint.datasetVersion.trim()
  ) {
    return locationFailure(mode, ELIGIBILITY_CODE.MINING_POINT_INVALID, {
      solarSystemID: systemAuthority.solarSystemID,
      moonID,
    });
  }
  if (miningPoint.solarSystemID !== systemAuthority.solarSystemID) {
    return locationFailure(mode, ELIGIBILITY_CODE.MINING_POINT_SYSTEM_MISMATCH, {
      solarSystemID: systemAuthority.solarSystemID,
      miningPointSolarSystemID: miningPoint.solarSystemID,
      moonID,
    });
  }
  if (miningPoint.moonID !== moonID) {
    return locationFailure(mode, ELIGIBILITY_CODE.MINING_POINT_MOON_MISMATCH, {
      solarSystemID: systemAuthority.solarSystemID,
      moonID,
      miningPointMoonID: miningPoint.moonID,
    });
  }

  return deepFreeze({
    valid: true,
    beaconID: miningPoint.beaconID,
    solarSystemID: miningPoint.solarSystemID,
    moonID: miningPoint.moonID,
    datasetVersion: miningPoint.datasetVersion.trim(),
  });
}

function evaluateMoonMiningLocationEligibility({ mode, system, moonID, miningPoint } = {}) {
  const normalizedMode = String(mode || "").trim().toLowerCase();
  if (!Object.values(MOON_MINING_MODE).includes(normalizedMode)) {
    return locationFailure(normalizedMode || null, ELIGIBILITY_CODE.INVALID_MODE);
  }
  if (!isPositiveInteger(moonID)) {
    return locationFailure(normalizedMode, ELIGIBILITY_CODE.INVALID_MOON);
  }

  const systemAuthority = validateSystemAuthority(normalizedMode, system);
  if (!systemAuthority.valid) {
    return systemAuthority;
  }

  if (systemAuthority.securityClass === MOON_MINING_SECURITY_CLASS.POCHVEN) {
    return locationFailure(normalizedMode, ELIGIBILITY_CODE.SECURITY_CLASS_DISALLOWED, {
      solarSystemID: systemAuthority.solarSystemID,
      moonID,
      securityClass: systemAuthority.securityClass,
    });
  }

  if (
    normalizedMode === MOON_MINING_MODE.METENOX &&
    systemAuthority.securityClass === MOON_MINING_SECURITY_CLASS.HIGHSEC
  ) {
    return locationFailure(normalizedMode, ELIGIBILITY_CODE.SECURITY_CLASS_DISALLOWED, {
      solarSystemID: systemAuthority.solarSystemID,
      moonID,
      securityClass: systemAuthority.securityClass,
    });
  }

  if (
    normalizedMode === MOON_MINING_MODE.MANUAL &&
    systemAuthority.securityClass === MOON_MINING_SECURITY_CLASS.HIGHSEC &&
    systemAuthority.displayedSecurityStatus > 0.5
  ) {
    return locationFailure(normalizedMode, ELIGIBILITY_CODE.MANUAL_SECURITY_TOO_HIGH, {
      solarSystemID: systemAuthority.solarSystemID,
      moonID,
      securityStatus: systemAuthority.securityStatus,
      displayedSecurityStatus: systemAuthority.displayedSecurityStatus,
      securityClass: systemAuthority.securityClass,
    });
  }

  const pointAuthority = validateMiningPointAuthority(
    normalizedMode,
    systemAuthority,
    moonID,
    miningPoint,
  );
  if (!pointAuthority.valid) {
    return pointAuthority;
  }

  return deepFreeze({
    mode: normalizedMode,
    eligible: true,
    code: ELIGIBILITY_CODE.LOCATION_ELIGIBLE,
    solarSystemID: systemAuthority.solarSystemID,
    moonID,
    beaconID: pointAuthority.beaconID,
    miningPointDatasetVersion: pointAuthority.datasetVersion,
    securityStatus: systemAuthority.securityStatus,
    displayedSecurityStatus: systemAuthority.displayedSecurityStatus,
    securityClass: systemAuthority.securityClass,
  });
}

function evaluateMoonResourceReadiness({ solarSystemID, moonID, resourceProfile } = {}) {
  if (!isPositiveInteger(solarSystemID) || !isPositiveInteger(moonID)) {
    return readinessFailure(ELIGIBILITY_CODE.RESOURCE_PROFILE_INVALID);
  }
  if (!resourceProfile || typeof resourceProfile !== "object") {
    return readinessFailure(ELIGIBILITY_CODE.RESOURCE_PROFILE_MISSING, {
      solarSystemID,
      moonID,
    });
  }

  const status = String(resourceProfile.status || "").trim().toLowerCase();
  if (status !== RESOURCE_PROFILE_STATUS.READY) {
    const codeByStatus = {
      [RESOURCE_PROFILE_STATUS.MISSING]: ELIGIBILITY_CODE.RESOURCE_PROFILE_MISSING,
      [RESOURCE_PROFILE_STATUS.MISMATCHED]: ELIGIBILITY_CODE.RESOURCE_PROFILE_MISMATCHED,
    };
    return readinessFailure(
      codeByStatus[status] || ELIGIBILITY_CODE.RESOURCE_PROFILE_INVALID,
      {
        solarSystemID,
        moonID,
        resourceProfileStatus: status || RESOURCE_PROFILE_STATUS.INVALID,
      },
    );
  }

  if (
    !isPositiveInteger(resourceProfile.solarSystemID) ||
    !isPositiveInteger(resourceProfile.moonID) ||
    typeof resourceProfile.datasetVersion !== "string" ||
    !resourceProfile.datasetVersion.trim()
  ) {
    return readinessFailure(ELIGIBILITY_CODE.RESOURCE_PROFILE_INVALID, {
      solarSystemID,
      moonID,
    });
  }
  if (resourceProfile.solarSystemID !== solarSystemID) {
    return readinessFailure(ELIGIBILITY_CODE.RESOURCE_PROFILE_SYSTEM_MISMATCH, {
      solarSystemID,
      resourceProfileSolarSystemID: resourceProfile.solarSystemID,
      moonID,
    });
  }
  if (resourceProfile.moonID !== moonID) {
    return readinessFailure(ELIGIBILITY_CODE.RESOURCE_PROFILE_MOON_MISMATCH, {
      solarSystemID,
      moonID,
      resourceProfileMoonID: resourceProfile.moonID,
    });
  }

  return deepFreeze({
    ready: true,
    code: ELIGIBILITY_CODE.OPERATION_READY,
    solarSystemID,
    moonID,
    datasetVersion: resourceProfile.datasetVersion.trim(),
  });
}

function evaluateMoonMiningEligibility(context = {}) {
  const location = evaluateMoonMiningLocationEligibility(context);
  const resources = location.eligible
    ? evaluateMoonResourceReadiness({
      solarSystemID: location.solarSystemID,
      moonID: location.moonID,
      resourceProfile: context.resourceProfile,
    })
    : readinessFailure(location.code);

  return deepFreeze({
    mode: location.mode,
    locationEligible: location.eligible,
    resourceReady: resources.ready,
    operationReady: location.eligible && resources.ready,
    code: location.eligible ? resources.code : location.code,
    location,
    resources,
  });
}

module.exports = {
  ELIGIBILITY_CODE,
  MINING_POINT_STATUS,
  MOON_MINING_MODE,
  MOON_MINING_SECURITY_CLASS,
  RESOURCE_PROFILE_STATUS,
  classifyKnownSpaceSecurity,
  evaluateMoonMiningEligibility,
  evaluateMoonMiningLocationEligibility,
  evaluateMoonResourceReadiness,
  roundDisplayedSecurityStatus,
};
