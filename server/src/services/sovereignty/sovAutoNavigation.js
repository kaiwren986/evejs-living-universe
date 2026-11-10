"use strict";

const path = require("path");

const worldData = require(path.join(__dirname, "../../space/worldData"));
const spaceRuntime = require(path.join(__dirname, "../../space/runtime"));
const structureState = require(path.join(__dirname, "../structure/structureState"));
const {
  jumpSessionToSolarSystem,
} = require(path.join(__dirname, "../../space/transitions"));
const {
  TYPE_INFRASTRUCTURE_HUB,
} = require(path.join(__dirname, "./sovConstants"));
const {
  canSolarSystemSupportUpgrades,
  canSolarSystemSupportUpgrade,
} = require(path.join(__dirname, "./sovUpgradeSupport"));
const {
  buildAnchorLayout,
  cloneSpacePoint,
  normalizePositiveInteger,
} = require(path.join(__dirname, "./sovAnchorLayout"));
const {
  isSovereigntyClaimableSolarSystem,
} = require(path.join(__dirname, "./sovSystemRules"));
const {
  isSovereigntyRelatedStructure,
} = require(path.join(__dirname, "./sovSpaceInterop"));
const {
  getSystemState,
  listAllAllianceSystems,
  upsertSystemState,
} = require(path.join(__dirname, "./sovState"));

function getSessionCharacterID(session) {
  return normalizePositiveInteger(
    session && (session.characterID || session.charid || session.userid),
    null,
  );
}

function getSessionCurrentSolarSystemID(session) {
  return normalizePositiveInteger(
    session &&
      (
        (session._space && session._space.systemID) ||
        session.solarsystemid2 ||
        session.solarsystemid
      ),
    null,
  );
}

function getSessionShipEntity(session) {
  const shipID = normalizePositiveInteger(
    session && session._space && session._space.shipID,
    null,
  );
  if (!shipID) {
    return null;
  }
  return spaceRuntime.getEntity(session, shipID);
}

function getSessionShipPoint(session) {
  const entity = getSessionShipEntity(session);
  return cloneSpacePoint(entity && entity.position, null);
}

function isClaimedSystemState(system) {
  return Boolean(
    system &&
      (
        normalizePositiveInteger(system.allianceID, null) ||
        normalizePositiveInteger(system.claimStructureID, null) ||
        normalizePositiveInteger(system.infrastructureHubID, null) ||
        (Array.isArray(system.structures) && system.structures.length > 0)
      ),
  );
}

function hasSovereigntyStructuresInSystem(solarSystemID) {
  return structureState.listStructuresForSystem(solarSystemID, {
    includeDestroyed: true,
    refresh: false,
  }).some((structure) => isSovereigntyRelatedStructure(structure));
}

function ensureSessionInSolarSystem(session, solarSystemID) {
  const targetSolarSystemID = normalizePositiveInteger(solarSystemID, null);
  if (!targetSolarSystemID || !worldData.getSolarSystemByID(targetSolarSystemID)) {
    return {
      success: false,
      errorMsg: "SOLAR_SYSTEM_NOT_FOUND",
    };
  }

  if (!session || !getSessionCharacterID(session)) {
    return {
      success: true,
      data: {
        skipped: true,
        moved: false,
        solarSystemID: targetSolarSystemID,
        reason: "NO_LIVE_SESSION",
      },
    };
  }

  const currentSolarSystemID = getSessionCurrentSolarSystemID(session);
  if (currentSolarSystemID === targetSolarSystemID && session._space) {
    return {
      success: true,
      data: {
        skipped: false,
        moved: false,
        solarSystemID: targetSolarSystemID,
      },
    };
  }

  // Server-driven repositioning, not a jump the pilot made.
  const jumpResult = jumpSessionToSolarSystem(session, targetSolarSystemID, {
    countsTowardJumpGoal: false,
  });
  if (!jumpResult.success) {
    return jumpResult;
  }

  return {
    success: true,
    data: {
      skipped: false,
      moved: true,
      solarSystemID: targetSolarSystemID,
      solarSystem:
        (jumpResult.data && jumpResult.data.solarSystem) ||
        worldData.getSolarSystemByID(targetSolarSystemID),
      spawnState: jumpResult.data && jumpResult.data.spawnState,
    },
  };
}

// The Hub's position in the system, when it has one. The Hub is the only
// sovereignty core, so it is also the primary point automation lands on.
function getStructurePositionsForSystem(solarSystemID) {
  const system = getSystemState(solarSystemID);
  const structures = Array.isArray(system && system.structures)
    ? system.structures
    : [];
  let hubPoint = null;
  for (const structure of structures) {
    if (normalizePositiveInteger(structure && structure.typeID, null) !== TYPE_INFRASTRUCTURE_HUB) {
      continue;
    }
    hubPoint = cloneSpacePoint(structure && structure.position, null);
    if (hubPoint) {
      break;
    }
  }
  return {
    positionsByKind: {
      ihub: hubPoint,
    },
    primaryPoint: cloneSpacePoint(hubPoint, null),
  };
}

// Older records may hold a Hub without a position. Give it the default spot
// at the sun so automation and mirrors have somewhere to put it.
function ensureStructurePositionsForSystem(solarSystemID) {
  const system = getSystemState(solarSystemID);
  const structures = Array.isArray(system && system.structures)
    ? system.structures
    : [];
  if (structures.length === 0) {
    return {
      success: false,
      errorMsg: "STRUCTURE_NOT_FOUND",
    };
  }

  const existingPoints = getStructurePositionsForSystem(solarSystemID);
  const hasAllPositions = structures.every((structure) => {
    if (normalizePositiveInteger(structure && structure.typeID, null) !== TYPE_INFRASTRUCTURE_HUB) {
      return true;
    }
    return Boolean(cloneSpacePoint(structure && structure.position, null));
  });
  if (hasAllPositions) {
    return {
      success: true,
      data: {
        updated: false,
        ...existingPoints,
      },
    };
  }

  const layout = buildAnchorLayout(solarSystemID);
  const nextStructures = structures.map((structure) => {
    if (normalizePositiveInteger(structure && structure.typeID, null) !== TYPE_INFRASTRUCTURE_HUB) {
      return structure;
    }
    return {
      ...structure,
      position: cloneSpacePoint(layout.positionsByKind.ihub, null),
    };
  });

  upsertSystemState(solarSystemID, {
    structures: nextStructures,
  });

  return {
    success: true,
    data: {
      updated: true,
      ...getStructurePositionsForSystem(solarSystemID),
    },
  };
}

function teleportSessionToPrimarySovAnchor(session, solarSystemID) {
  const sessionResult = ensureSessionInSolarSystem(session, solarSystemID);
  if (!sessionResult.success) {
    return sessionResult;
  }
  if (!session || !getSessionCharacterID(session)) {
    return {
      success: true,
      data: {
        skipped: true,
        moved: false,
        solarSystemID,
        reason: "NO_LIVE_SESSION",
      },
    };
  }

  const positionsResult = ensureStructurePositionsForSystem(solarSystemID);
  if (!positionsResult.success) {
    return positionsResult;
  }
  const targetPoint = cloneSpacePoint(
    positionsResult.data && positionsResult.data.primaryPoint,
    null,
  );
  if (!targetPoint) {
    return {
      success: true,
      data: {
        skipped: true,
        moved: false,
        solarSystemID,
        reason: "NO_SOV_ANCHOR_POINT",
      },
    };
  }

  const shipEntity = getSessionShipEntity(session);
  const direction = cloneSpacePoint(
    shipEntity && shipEntity.direction,
    { x: 1, y: 0, z: 0 },
  ) || { x: 1, y: 0, z: 0 };
  const teleportResult = spaceRuntime.teleportSessionShipToPoint(session, targetPoint, {
    direction,
    refreshOwnerSession: true,
  });
  if (!teleportResult.success) {
    return teleportResult;
  }

  return {
    success: true,
    data: {
      skipped: false,
      moved: true,
      solarSystemID,
      point: targetPoint,
      positionsByKind: positionsResult.data.positionsByKind,
    },
  };
}

function findUnclaimedSolarSystem(session, options = {}) {
  const preferredCurrentSystemID = normalizePositiveInteger(
    options.preferredCurrentSystemID || getSessionCurrentSolarSystemID(session),
    null,
  );
  const requiredUpgradeTypeID = normalizePositiveInteger(
    options.requiredUpgradeTypeID,
    null,
  );
  const requiredUpgradeTypeIDs = Array.isArray(options.requiredUpgradeTypeIDs)
    ? [...new Set(
      options.requiredUpgradeTypeIDs
        .map((typeID) => normalizePositiveInteger(typeID, null))
        .filter(Boolean),
    )]
    : [];
  const supportsRequiredUpgrades = (solarSystemID) => {
    if (requiredUpgradeTypeIDs.length > 0) {
      return canSolarSystemSupportUpgrades(solarSystemID, requiredUpgradeTypeIDs);
    }
    if (requiredUpgradeTypeID) {
      return canSolarSystemSupportUpgrade(solarSystemID, requiredUpgradeTypeID);
    }
    return true;
  };
  const claimedSystems = new Set(
    (listAllAllianceSystems() || [])
      .map((record) => normalizePositiveInteger(record && record.solarSystemID, null))
      .filter(Boolean),
  );
  const fallbackCurrentSystemID =
    preferredCurrentSystemID && !claimedSystems.has(preferredCurrentSystemID)
      ? preferredCurrentSystemID
      : null;

  const solarSystems = worldData.getSolarSystems()
    .map((solarSystem) => normalizePositiveInteger(solarSystem && solarSystem.solarSystemID, null))
    .filter(Boolean)
    .sort((left, right) => left - right);

  for (const solarSystemID of solarSystems) {
    if (solarSystemID === preferredCurrentSystemID) {
      continue;
    }
    const solarSystem = worldData.getSolarSystemByID(solarSystemID);
    if (!isSovereigntyClaimableSolarSystem(solarSystem)) {
      continue;
    }
    if (claimedSystems.has(solarSystemID)) {
      continue;
    }
    if (isClaimedSystemState(getSystemState(solarSystemID))) {
      continue;
    }
    if (hasSovereigntyStructuresInSystem(solarSystemID)) {
      continue;
    }
    if (!supportsRequiredUpgrades(solarSystemID)) {
      continue;
    }
    return {
      success: true,
      data: {
        solarSystemID,
        solarSystem,
      },
    };
  }

  if (
    fallbackCurrentSystemID &&
    isSovereigntyClaimableSolarSystem(fallbackCurrentSystemID) &&
    !isClaimedSystemState(getSystemState(fallbackCurrentSystemID)) &&
    !hasSovereigntyStructuresInSystem(fallbackCurrentSystemID) &&
    supportsRequiredUpgrades(fallbackCurrentSystemID)
  ) {
    return {
      success: true,
      data: {
        solarSystemID: fallbackCurrentSystemID,
        solarSystem: worldData.getSolarSystemByID(fallbackCurrentSystemID),
      },
    };
  }

  return {
    success: false,
    errorMsg: "UNCLAIMED_SOLAR_SYSTEM_NOT_FOUND",
  };
}

module.exports = {
  cloneSpacePoint,
  ensureSessionInSolarSystem,
  ensureStructurePositionsForSystem,
  findUnclaimedSolarSystem,
  getSessionCurrentSolarSystemID,
  getSessionShipPoint,
  getStructurePositionsForSystem,
  isClaimedSystemState,
  isSovereigntyClaimableSolarSystem,
  teleportSessionToPrimarySovAnchor,
};
