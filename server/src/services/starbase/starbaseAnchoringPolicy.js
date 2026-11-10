"use strict";

const path = require("node:path");
const bundledAnchoringRestrictions = require("./starbaseAnchoringRestrictions.json");

const worldData = require(path.join(__dirname, "../../space/worldData"));
const {
  listSystemSpaceItems,
} = require(path.join(__dirname, "../inventory/itemStore"));
const {
  resolveItemByTypeID,
} = require(path.join(__dirname, "../inventory/itemTypeRegistry"));
const {
  TABLE,
  readStaticTable,
} = require(path.join(__dirname, "../_shared/referenceData"));
const {
  corporationAuthorityHasRole,
  getPersistedCorporationAuthority,
} = require(path.join(__dirname, "../corporation/corporationAuthority"));
const {
  getClientParityWarpInPoint,
} = require(path.join(
  __dirname,
  "../../space/destiny/simulation/warpInPointParity",
));

const CATEGORY_STARBASE = 23;
const GROUP_CONTROL_TOWER = 365;
const GROUP_MOON = 8;
// Current client appConst.py:361; generic Equipment Config (:349) is a different role.
const CORP_ROLE_STARBASE_CONFIG = 9007199254740992n;
const ATTRIBUTE_MAX_STRUCTURE_DISTANCE = 650;
const ATTRIBUTE_SHIELD_RADIUS = 680;
const ATTRIBUTE_MOON_ANCHOR_DISTANCE = 711;
const ATTRIBUTE_MAX_SECURITY_LEVEL = 1032;
const ATTRIBUTE_REQUIRED_SOVEREIGNTY_LEVEL = 1185;
const ATTRIBUTE_REQUIRES_IHUB_UPGRADE = 1595;
// Pinned legacy POS dogma names the deprecated upgrade items. These semantic
// equivalents are an explicit compatibility bridge to the existing modern hub
// engine, not a second sovereignty implementation (dogma/const.py:118).
const MODERN_UPGRADE_BY_LEGACY_TYPE = Object.freeze({ 2001: 81619, 2008: 81615, 2009: 81623, 32422: 81621 });
const ATTRIBUTE_CONTROL_TOWER_MINIMUM_DISTANCE = 1165;
const ATTRIBUTE_MAX_ANCHORED_PER_SYSTEM_PER_GROUP = 1195;
const ATTRIBUTE_MIN_SECURITY_LEVEL = 1946;
const DEFAULT_MAX_STRUCTURE_DISTANCE_METERS = 300000;
const CONTROL_TOWER_MOON_SNAP_OFFSET_METERS = 100000;

function toInt(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

function vectorDistance(left, right) {
  if (!left || !right) return Number.POSITIVE_INFINITY;
  const dx = Number(left.x) - Number(right.x);
  const dy = Number(left.y) - Number(right.y);
  const dz = Number(left.z) - Number(right.z);
  return [dx, dy, dz].every(Number.isFinite)
    ? Math.sqrt((dx ** 2) + (dy ** 2) + (dz ** 2))
    : Number.POSITIVE_INFINITY;
}

function getDogmaAttribute(typeID, attributeID, fallback = null) {
  const root = readStaticTable(TABLE.TYPE_DOGMA) || {};
  const row = root.typesByTypeID && root.typesByTypeID[String(toInt(typeID, 0))];
  const value = Number(row && row.attributes && row.attributes[String(attributeID)]);
  return Number.isFinite(value) ? value : fallback;
}

function getItemRadius(item) {
  const type = resolveItemByTypeID(item && item.typeID);
  return Math.max(0, Number(item && item.radius) || Number(type && type.radius) || 0);
}

function getItemSystemID(item) {
  return toInt(item && item.spaceState && item.spaceState.systemID, toInt(item && item.locationID, 0));
}

function cloneVector(source) {
  return {
    x: Number(source && source.x) || 0,
    y: Number(source && source.y) || 0,
    z: Number(source && source.z) || 0,
  };
}

function getMoonWarpInPoint(moon) {
  return getClientParityWarpInPoint(moon) || cloneVector(moon && moon.position);
}

function getMoonControlTowerAnchorPosition(moon) {
  const moonPosition = cloneVector(moon && moon.position);
  const warpInPoint = getMoonWarpInPoint(moon);
  const towardMoon = {
    x: moonPosition.x - warpInPoint.x,
    y: moonPosition.y - warpInPoint.y,
    z: moonPosition.z - warpInPoint.z,
  };
  const length = Math.sqrt(
    (towardMoon.x ** 2) + (towardMoon.y ** 2) + (towardMoon.z ** 2),
  );
  const direction = Number.isFinite(length) && length > 0
    ? {
        x: towardMoon.x / length,
        y: towardMoon.y / length,
        z: towardMoon.z / length,
      }
    : { x: 1, y: 0, z: 0 };
  return {
    x: warpInPoint.x + (direction.x * CONTROL_TOWER_MOON_SNAP_OFFSET_METERS),
    y: warpInPoint.y + (direction.y * CONTROL_TOWER_MOON_SNAP_OFFSET_METERS),
    z: warpInPoint.z + (direction.z * CONTROL_TOWER_MOON_SNAP_OFFSET_METERS),
  };
}

function getTowerMaximumStructureDistance(tower) {
  return Math.max(0, getDogmaAttribute(
    tower && tower.typeID,
    ATTRIBUTE_MAX_STRUCTURE_DISTANCE,
    DEFAULT_MAX_STRUCTURE_DISTANCE_METERS,
  ));
}

function validateCorporationAuthority(session, ownerCorporationID, options = {}) {
  const ownerID = toInt(ownerCorporationID, 0);
  const authority = Object.prototype.hasOwnProperty.call(options, "authority")
    ? options.authority
    : getPersistedCorporationAuthority(session);
  if (!authority) {
    return { success: false, errorMsg: "STARBASE_PLAYER_CORPORATION_REQUIRED" };
  }
  if (options.tower && Number(options.tower.ownerID) === ownerID && options.operation && require("./starbaseAccessRuntime").hasStarbasePermission(
    session, options.tower, options.structureID, options.operation, { authority },
  )) {
    return { success: true, data: authority };
  }
  if (toInt(authority.corporationID, 0) !== ownerID) {
    return { success: false, errorMsg: "STARBASE_CORPORATION_OWNER_REQUIRED" };
  }
  if (
    authority.isCEO !== true &&
    authority.isDirector !== true &&
    !corporationAuthorityHasRole(authority, CORP_ROLE_STARBASE_CONFIG)
  ) {
    return { success: false, errorMsg: "STARBASE_EQUIPMENT_CONFIG_ROLE_REQUIRED" };
  }
  return { success: true, data: authority };
}

function normalizeRestrictionIDs(value) {
  return new Set(
    (Array.isArray(value) ? value : [])
      .map((entry) => toInt(entry, 0))
      .filter((entry) => entry > 0),
  );
}

function getOwningCorporationAllianceID(item) {
  const corporations = require("../corporation/corporationState");
  const corporationID = toInt(item && item.ownerID, 0);
  const corporation = corporations.getCorporationRecord(corporationID);
  const allianceID = toInt(corporation && !corporation.deleted && corporation.allianceID, 0);
  const alliance = allianceID > 0 && corporations.getAllianceRecord(allianceID);
  return alliance && !alliance.deleted && corporations.getAllianceCorporationIDs(allianceID).includes(corporationID)
    ? allianceID : 0;
}

function validateRequiredHubUpgrade(item, system, sovereigntyState = null) {
  const legacyTypeID = toInt(getDogmaAttribute(item && item.typeID, ATTRIBUTE_REQUIRES_IHUB_UPGRADE, 0), 0);
  if (legacyTypeID <= 0) return { success: true };
  const systemID = getItemSystemID(item);
  if (!require("../sovereignty/sovSystemRules").isSovereigntyClaimableSolarSystem(system)) {
    return { success: false, errorMsg: "STARBASE_SOVEREIGNTY_REQUIRED" };
  }
  const allianceID = getOwningCorporationAllianceID(item);
  const sovereignty = sovereigntyState || require("../sovereignty/sovState").getSystemState(systemID);
  if (!allianceID || toInt(sovereignty && sovereignty.allianceID, 0) !== allianceID) {
    return { success: false, errorMsg: "STARBASE_SOVEREIGNTY_REQUIRED" };
  }
  const modern = require("../sovereignty/sovModernState");
  const hubID = modern.getHubIDForSolarSystem(systemID);
  const requiredUpgradeTypeID = MODERN_UPGRADE_BY_LEGACY_TYPE[legacyTypeID] || legacyTypeID;
  // The public shared getter rechecks the hub's owning alliance; corporationID
  // is deliberately absent so an old corporation-owned hub cannot bypass it.
  const upgrades = modern.getHubUpgrades(hubID, { allianceID });
  if (!hubID || toInt(upgrades && upgrades.solarSystemID, 0) !== systemID ||
      !upgrades?.upgrades?.some((row) => toInt(row.typeID, 0) === requiredUpgradeTypeID && toInt(row.powerState, 0) === 2)) {
    return { success: false, errorMsg: "STARBASE_SOVEREIGNTY_UPGRADE_REQUIRED", data: { requiredUpgradeTypeID, legacyTypeID } };
  }
  return { success: true, data: { hubID, requiredUpgradeTypeID, allianceID } };
}

function validateSystemRestrictions(item, options = {}) {
  const systemID = getItemSystemID(item);
  const system = Object.prototype.hasOwnProperty.call(options, "system")
    ? options.system
    : worldData.getSolarSystemByID(systemID);
  if (!system || toInt(system.solarSystemID, systemID) !== systemID) {
    return { success: false, errorMsg: "STARBASE_SYSTEM_UNAVAILABLE" };
  }

  // Older deployed map tables omit these fields until DataSync. The bounded
  // source bundle supplies only missing fields; explicit arrays (even empty)
  // remain authoritative, and the shared world-data row is never modified.
  const bundled = bundledAnchoringRestrictions.systems[String(systemID)];
  const disallowedCategories = normalizeRestrictionIDs(
    system.disallowedAnchorCategories === undefined
      ? bundled?.disallowedAnchorCategories
      : system.disallowedAnchorCategories,
  );
  const disallowedGroups = normalizeRestrictionIDs(
    system.disallowedAnchorGroups === undefined
      ? bundled?.disallowedAnchorGroups
      : system.disallowedAnchorGroups,
  );
  if (
    disallowedCategories.has(toInt(item && item.categoryID, 0)) ||
    disallowedGroups.has(toInt(item && item.groupID, 0))
  ) {
    return { success: false, errorMsg: "STARBASE_ANCHORING_RESTRICTED_IN_SYSTEM" };
  }

  const security = Number(system.security);
  // Anchorable dogma values use the security band shown by the client (0.0,
  // 0.1, ... 1.0), while the map table keeps the higher-precision value.
  const effectiveSecurity = Number.isFinite(security)
    ? Math.round(Math.max(0, Math.min(1, security)) * 10) / 10
    : Number.NaN;
  const maximumSecurity = getDogmaAttribute(item && item.typeID, ATTRIBUTE_MAX_SECURITY_LEVEL, null);
  const minimumSecurity = getDogmaAttribute(item && item.typeID, ATTRIBUTE_MIN_SECURITY_LEVEL, null);
  if (Number.isFinite(effectiveSecurity) && maximumSecurity !== null && effectiveSecurity > maximumSecurity) {
    return {
      success: false,
      errorMsg: "STARBASE_SECURITY_TOO_HIGH",
      data: { security, effectiveSecurity, maximumSecurity },
    };
  }
  if (Number.isFinite(effectiveSecurity) && minimumSecurity !== null && effectiveSecurity < minimumSecurity) {
    return {
      success: false,
      errorMsg: "STARBASE_SECURITY_TOO_LOW",
      data: { security, effectiveSecurity, minimumSecurity },
    };
  }
  const requiredSovereigntyLevel = Math.max(0, toInt(getDogmaAttribute(
    item && item.typeID,
    ATTRIBUTE_REQUIRED_SOVEREIGNTY_LEVEL,
    0,
  ), 0));
  if (requiredSovereigntyLevel > 0) {
    let sovereigntyState = options.sovereigntyState || null;
    let strategicLevel = toInt(
      sovereigntyState && sovereigntyState.strategicLevel,
      -1,
    );
    if (!sovereigntyState || strategicLevel < 0) {
      const sovereigntyRuntime = require(path.join(
        __dirname,
        "../sovereignty/sovState",
      ));
      sovereigntyState = sovereigntyState ||
        sovereigntyRuntime.getSystemState(systemID);
      strategicLevel = sovereigntyRuntime.getStrategicIndexLevel(
        sovereigntyState && sovereigntyState.devIndices &&
          sovereigntyState.devIndices.claimedForDays,
      );
    }
    const itemAllianceID = getOwningCorporationAllianceID(item);
    if (
      itemAllianceID <= 0 ||
      toInt(sovereigntyState && sovereigntyState.allianceID, 0) !== itemAllianceID
    ) {
      return { success: false, errorMsg: "STARBASE_SOVEREIGNTY_REQUIRED" };
    }
    if (strategicLevel < requiredSovereigntyLevel) {
      return {
        success: false,
        errorMsg: "STARBASE_SOVEREIGNTY_LEVEL_REQUIRED",
        data: { strategicLevel, requiredSovereigntyLevel },
      };
    }
  }
  const upgrade = validateRequiredHubUpgrade(item, system, options.sovereigntyState);
  if (!upgrade.success) return upgrade;
  return { success: true, data: { system } };
}

function findNearestMoon(item, options = {}) {
  const systemID = getItemSystemID(item);
  const celestials = Array.isArray(options.celestials)
    ? options.celestials
    : worldData.getCelestialsForSystem(systemID);
  return celestials
    .filter((celestial) => (
      toInt(celestial && celestial.solarSystemID, systemID) === systemID &&
      (toInt(celestial && celestial.groupID, 0) === GROUP_MOON || celestial.kind === "moon")
    ))
    .map((moon) => {
      const warpInPoint = getMoonWarpInPoint(moon);
      const centerDistance = vectorDistance(
        item && item.spaceState && item.spaceState.position,
        moon.position,
      );
      const warpInDistance = vectorDistance(
        item && item.spaceState && item.spaceState.position,
        warpInPoint,
      );
      return {
        moon,
        centerDistance,
        physicalSurfaceDistance: Math.max(
          0,
          centerDistance - Math.max(0, Number(moon.radius) || 0) - getItemRadius(item),
        ),
        warpInPoint,
        warpInDistance,
        // Retain the former field for callers while making it describe the
        // actual legacy POS placement reference: the moon's fixed warp-in.
        surfaceDistance: warpInDistance,
        anchorPosition: getMoonControlTowerAnchorPosition(moon),
      };
    })
    .sort((left, right) => left.warpInDistance - right.warpInDistance ||
      toInt(left.moon.itemID, 0) - toInt(right.moon.itemID, 0))[0] || null;
}

function isAnchoredOrAnchoring(item) {
  const anchorState = String(item && item.spaceState && item.spaceState.anchorState || "").toLowerCase();
  return anchorState === "anchored" || anchorState === "anchoring";
}

function resolveTowerMoonID(tower, options = {}) {
  const persistedMoonID = toInt(tower && tower.spaceState && tower.spaceState.moonID, 0);
  if (persistedMoonID > 0) return persistedMoonID;
  const nearest = findNearestMoon(tower, options);
  const maximum = Math.max(0, getDogmaAttribute(
    tower && tower.typeID,
    ATTRIBUTE_MOON_ANCHOR_DISTANCE,
    0,
  ));
  return nearest && maximum > 0 && nearest.warpInDistance <= maximum
    ? toInt(nearest.moon.itemID, 0)
    : 0;
}

function validateControlTowerPlacement(tower, options = {}) {
  const systemValidation = validateSystemRestrictions(tower, options);
  if (!systemValidation.success) return systemValidation;

  const nearest = findNearestMoon(tower, options);
  if (!nearest) {
    return { success: false, errorMsg: "CONTROL_TOWER_MOON_REQUIRED" };
  }
  const maximum = Math.max(0, getDogmaAttribute(
    tower && tower.typeID,
    ATTRIBUTE_MOON_ANCHOR_DISTANCE,
    0,
  ));
  if (maximum <= 0 || nearest.warpInDistance > maximum) {
    return {
      success: false,
      errorMsg: "CONTROL_TOWER_TOO_FAR_FROM_MOON",
      data: { distance: nearest.warpInDistance, maximum },
    };
  }

  const systemItems = Array.isArray(options.systemItems)
    ? options.systemItems
    : listSystemSpaceItems(getItemSystemID(tower));
  const moonID = toInt(nearest.moon.itemID, 0);
  const occupyingTower = systemItems.find((candidate) => (
    toInt(candidate && candidate.itemID, 0) !== toInt(tower && tower.itemID, 0) &&
    toInt(candidate && candidate.categoryID, 0) === CATEGORY_STARBASE &&
    toInt(candidate && candidate.groupID, 0) === GROUP_CONTROL_TOWER &&
    isAnchoredOrAnchoring(candidate) &&
    resolveTowerMoonID(candidate, options) === moonID
  ));
  if (occupyingTower) {
    return {
      success: false,
      errorMsg: "CONTROL_TOWER_MOON_OCCUPIED",
      data: { moonID, occupyingTowerID: toInt(occupyingTower.itemID, 0) },
    };
  }
  return {
    success: true,
    data: {
      moonID,
      moon: nearest.moon,
      distance: nearest.warpInDistance,
      maximum,
      warpInPoint: nearest.warpInPoint,
      anchorPosition: nearest.anchorPosition,
    },
  };
}

function validateModulePlacement(item, tower, options = {}) {
  if (!item || !tower) {
    return { success: false, errorMsg: "CONTROL_TOWER_NOT_FOUND" };
  }
  const systemValidation = validateSystemRestrictions(item, options);
  if (!systemValidation.success) return systemValidation;
  if (
    getItemSystemID(item) <= 0 ||
    getItemSystemID(tower) !== getItemSystemID(item) ||
    toInt(tower.ownerID, 0) !== toInt(item.ownerID, 0) ||
    !isAnchoredOrAnchoring(tower)
  ) {
    return { success: false, errorMsg: "CONTROL_TOWER_NOT_FOUND" };
  }

  const distance = vectorDistance(item.spaceState && item.spaceState.position, tower.spaceState && tower.spaceState.position);
  const shieldRadius = Math.max(0, getDogmaAttribute(
    tower.typeID,
    ATTRIBUTE_SHIELD_RADIUS,
    0,
  ));
  const configuredOutsideOffset = getDogmaAttribute(
    item.typeID,
    ATTRIBUTE_CONTROL_TOWER_MINIMUM_DISTANCE,
    null,
  );
  const requiresOutsideForceField =
    configuredOutsideOffset !== null && configuredOutsideOffset > 0;
  const itemRadius = getItemRadius(item);
  let minimum = 0;
  let maximum = getTowerMaximumStructureDistance(tower);
  if (requiresOutsideForceField) {
    minimum = shieldRadius + configuredOutsideOffset;
    if (distance < minimum) {
      return {
        success: false,
        errorMsg: "STARBASE_MODULE_TOO_CLOSE_TO_FORCE_FIELD",
        data: { distance, minimum },
      };
    }
    if (distance > maximum) {
      return {
        success: false,
        errorMsg: "STARBASE_MODULE_TOO_FAR_FROM_CONTROL_TOWER",
        data: { distance, maximum },
      };
    }
  } else {
    maximum = Math.min(maximum, Math.max(0, shieldRadius - itemRadius));
    if (distance > maximum) {
      return {
        success: false,
        errorMsg: "STARBASE_MODULE_OUTSIDE_FORCE_FIELD",
        data: { distance, maximum, shieldRadius, itemRadius },
      };
    }
  }

  const systemItems = Array.isArray(options.systemItems)
    ? options.systemItems
    : listSystemSpaceItems(getItemSystemID(item));
  const maximumPerGroup = Math.max(0, toInt(getDogmaAttribute(
    item.typeID,
    ATTRIBUTE_MAX_ANCHORED_PER_SYSTEM_PER_GROUP,
    0,
  ), 0));
  if (maximumPerGroup > 0) {
    const groupCount = systemItems.filter((candidate) => (
      toInt(candidate && candidate.itemID, 0) !== toInt(item.itemID, 0) &&
      toInt(candidate && candidate.groupID, 0) === toInt(item.groupID, 0) &&
      isAnchoredOrAnchoring(candidate)
    )).length;
    if (groupCount >= maximumPerGroup) {
      return {
        success: false,
        errorMsg: "STARBASE_GROUP_ANCHOR_LIMIT_REACHED",
        data: { maximum: maximumPerGroup },
      };
    }
  }

  const overlapping = systemItems.find((candidate) => (
    toInt(candidate && candidate.itemID, 0) !== toInt(item.itemID, 0) &&
    toInt(candidate && candidate.categoryID, 0) === CATEGORY_STARBASE &&
    toInt(candidate && candidate.groupID, 0) !== GROUP_CONTROL_TOWER &&
    isAnchoredOrAnchoring(candidate) &&
    vectorDistance(item.spaceState.position, candidate.spaceState && candidate.spaceState.position) <
      itemRadius + getItemRadius(candidate)
  ));
  if (overlapping) {
    return {
      success: false,
      errorMsg: "STARBASE_MODULE_TOO_CLOSE_TO_STRUCTURE",
      data: { structureID: toInt(overlapping.itemID, 0) },
    };
  }

  return {
    success: true,
    data: {
      distance,
      minimum,
      maximum,
      requiresOutsideForceField,
    },
  };
}

module.exports = {
  CATEGORY_STARBASE,
  GROUP_CONTROL_TOWER,
  GROUP_MOON,
  CORP_ROLE_STARBASE_CONFIG,
  ATTRIBUTE_MAX_STRUCTURE_DISTANCE,
  ATTRIBUTE_SHIELD_RADIUS,
  ATTRIBUTE_MOON_ANCHOR_DISTANCE,
  ATTRIBUTE_REQUIRED_SOVEREIGNTY_LEVEL,
  ATTRIBUTE_REQUIRES_IHUB_UPGRADE,
  MODERN_UPGRADE_BY_LEGACY_TYPE,
  ATTRIBUTE_CONTROL_TOWER_MINIMUM_DISTANCE,
  DEFAULT_MAX_STRUCTURE_DISTANCE_METERS,
  CONTROL_TOWER_MOON_SNAP_OFFSET_METERS,
  findNearestMoon,
  getDogmaAttribute,
  getMoonControlTowerAnchorPosition,
  getMoonWarpInPoint,
  getTowerMaximumStructureDistance,
  resolveTowerMoonID,
  validateControlTowerPlacement,
  validateCorporationAuthority,
  validateModulePlacement,
  validateSystemRestrictions,
  validateRequiredHubUpgrade,
  vectorDistance,
  _testing: {
    getItemRadius,
    getItemSystemID,
    isAnchoredOrAnchoring,
    normalizeRestrictionIDs,
  },
};
