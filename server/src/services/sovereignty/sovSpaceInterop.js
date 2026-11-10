"use strict";

const {
  cloneValue,
} = require("../../common/clone");

const path = require("path");

const spaceRuntime = require(path.join(__dirname, "../../space/runtime"));
const structureState = require(path.join(__dirname, "../structure/structureState"));
const {
  STRUCTURE_STATE,
  STRUCTURE_UPKEEP_STATE,
} = require(path.join(__dirname, "../structure/structureConstants"));
const {
  resolveItemByTypeID,
} = require(path.join(__dirname, "../inventory/itemTypeRegistry"));
const {
  TYPE_INFRASTRUCTURE_HUB,
} = require(path.join(__dirname, "./sovConstants"));
const {
  TYPE_ANSIBLEX_JUMP_BRIDGE,
  TYPE_PHAROLUX_CYNO_BEACON,
  TYPE_TENEBREX_CYNO_JAMMER,
} = require(path.join(__dirname, "./sovUpgradeSupport"));
const {
  buildAnchorLayout,
} = require(path.join(__dirname, "./sovAnchorLayout"));

const SOVEREIGNTY_TYPE_IDS = new Set([
  TYPE_INFRASTRUCTURE_HUB,
  34832,
]);
const SOVEREIGNTY_FLEX_TYPE_IDS = new Set([
  TYPE_PHAROLUX_CYNO_BEACON,
  TYPE_ANSIBLEX_JUMP_BRIDGE,
  TYPE_TENEBREX_CYNO_JAMMER,
]);
const OWNER_SCC = 1000132;
const TYPE_SOVEREIGNTY_COMMAND_NODE = 34832;

function normalizeInteger(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function normalizePositiveInteger(value, fallback = null) {
  const numeric = normalizeInteger(value, 0);
  return numeric > 0 ? numeric : fallback;
}

function normalizePosition(value, fallback = { x: 0, y: 0, z: 0 }) {
  const safeFallback =
    fallback && typeof fallback === "object"
      ? fallback
      : { x: 0, y: 0, z: 0 };
  const source =
    value && typeof value === "object"
      ? value
      : safeFallback;
  return {
    x: Number.isFinite(Number(source && source.x)) ? Number(source.x) : safeFallback.x,
    y: Number.isFinite(Number(source && source.y)) ? Number(source.y) : safeFallback.y,
    z: Number.isFinite(Number(source && source.z)) ? Number(source.z) : safeFallback.z,
  };
}

function normalizeFiletimeToMs(value) {
  try {
    const normalized = BigInt(String(value || "0"));
    if (normalized <= 116444736000000000n) {
      return 0;
    }
    return Number((normalized - 116444736000000000n) / 10000n);
  } catch (_error) {
    // ignored: an unreadable FILETIME counts as time zero
    return 0;
  }
}

function isActiveVulnerabilityWindow(structure, nowMs = Date.now()) {
  const vulnerableStartMs = normalizeFiletimeToMs(structure && structure.vulnerableStartTime);
  const vulnerableEndMs = normalizeFiletimeToMs(structure && structure.vulnerableEndTime);
  return vulnerableStartMs > 0 && vulnerableEndMs > vulnerableStartMs && nowMs >= vulnerableStartMs && nowMs <= vulnerableEndMs;
}

function isActiveCampaign(structure, nowMs = Date.now()) {
  const campaignEventType = normalizeInteger(structure && structure.campaignEventType, 0);
  const campaignStartMs = normalizeFiletimeToMs(structure && structure.campaignStartTime);
  return campaignEventType > 0 && campaignStartMs > 0 && nowMs >= campaignStartMs;
}

function deriveMirrorState(structure, nowMs = Date.now()) {
  if (isActiveCampaign(structure, nowMs) || isActiveVulnerabilityWindow(structure, nowMs)) {
    return STRUCTURE_STATE.SHIELD_VULNERABLE;
  }
  return STRUCTURE_STATE.FOB_INVULNERABLE;
}

function buildMirrorName(typeID, structureID) {
  const itemType = resolveItemByTypeID(typeID);
  return String(
    itemType && itemType.name
      ? itemType.name
      : `Sovereignty Structure ${structureID}`,
  );
}

function isSovereigntyMirrorStructure(structure) {
  const typeID = normalizePositiveInteger(structure && structure.typeID, 0);
  return (
    Boolean(structure && structure.devFlags && structure.devFlags.sovereigntyMirror === true) ||
    SOVEREIGNTY_TYPE_IDS.has(typeID)
  );
}

function isSovereigntyAuxiliaryStructure(structure) {
  const typeID = normalizePositiveInteger(structure && structure.typeID, 0);
  const devFlags = structure && structure.devFlags && typeof structure.devFlags === "object"
    ? structure.devFlags
    : {};
  return (
    SOVEREIGNTY_FLEX_TYPE_IDS.has(typeID) ||
    devFlags.sovAutomation === true ||
    devFlags.sovereigntyFlex === true ||
    Boolean(devFlags.sovereigntyAuxiliary) ||
    Boolean(devFlags.sovAutoJobID)
  );
}

function isSovereigntyRelatedStructure(structure) {
  return (
    isSovereigntyMirrorStructure(structure) ||
    isSovereigntyAuxiliaryStructure(structure)
  );
}

function buildMirrorRecord(systemState, structure, nowMs = Date.now()) {
  const structureID = normalizePositiveInteger(structure && structure.itemID, null);
  const typeID = normalizePositiveInteger(structure && structure.typeID, null);
  const solarSystemID =
    normalizePositiveInteger(systemState && systemState.solarSystemID, null) ||
    normalizePositiveInteger(structure && structure.solarSystemID, null);
  const fallbackLayout = buildAnchorLayout(solarSystemID);
  const fallbackPosition =
    typeID === TYPE_INFRASTRUCTURE_HUB
      ? fallbackLayout.positionsByKind.ihub
      : null;
  const existing = structureState.getStructureByID(structureID, {
    refresh: false,
  });
  const canonicalDevFlags =
    structure && structure.devFlags && typeof structure.devFlags === "object"
      ? structure.devFlags
      : {};
  const isNeutralHub = Boolean(
    typeID === TYPE_INFRASTRUCTURE_HUB &&
    canonicalDevFlags.sovereigntyNeutralHub === true &&
    canonicalDevFlags.sovereigntyCaptured !== true
  );
  const ownerCorpID = isNeutralHub
    ? OWNER_SCC
    : (
        normalizePositiveInteger(structure && structure.corporationID, null) ||
        normalizePositiveInteger(structure && structure.ownerID, null) ||
        normalizePositiveInteger(systemState && systemState.corporationID, 1) ||
        1
      );
  const allianceID = isNeutralHub
    ? null
    : (
        normalizePositiveInteger(structure && structure.allianceID, null) ||
        normalizePositiveInteger(systemState && systemState.allianceID, null)
      );
  const mirroredEntosisCapture =
    structure && structure.entosisCapture && typeof structure.entosisCapture === "object"
      ? cloneValue(structure.entosisCapture)
      : null;
  const mirroredCampaignSourceInfo =
    structure && Array.isArray(structure.campaignSourceInfo)
      ? cloneValue(structure.campaignSourceInfo.slice(0, 4))
      : canonicalDevFlags && Array.isArray(canonicalDevFlags.campaignSourceInfo)
        ? cloneValue(canonicalDevFlags.campaignSourceInfo.slice(0, 4))
        : null;

  return {
    ...(existing || {}),
    structureID,
    typeID,
    groupID:
      typeID === TYPE_SOVEREIGNTY_COMMAND_NODE
        ? 1316
        : normalizePositiveInteger(structure && structure.groupID, null),
    categoryID:
      typeID === TYPE_SOVEREIGNTY_COMMAND_NODE
        ? 65
        : normalizePositiveInteger(structure && structure.categoryID, 65),
    name: String(structure && structure.name || buildMirrorName(typeID, structureID)),
    itemName: String(structure && structure.name || buildMirrorName(typeID, structureID)),
    ownerCorpID,
    ownerID: ownerCorpID,
    allianceID,
    solarSystemID,
    position: normalizePosition(
      structure && structure.position,
      normalizePosition(existing && existing.position, fallbackPosition),
    ),
    rotation:
      Array.isArray(existing && existing.rotation)
        ? [...existing.rotation]
        : [0, 0, 0],
    state: deriveMirrorState(structure, nowMs),
    stateStartedAt: nowMs,
    stateEndsAt: 0,
    upkeepState: STRUCTURE_UPKEEP_STATE.FULL_POWER,
    hasQuantumCore: false,
    quantumCoreItemTypeID: null,
    profileID: 1,
    serviceStates: {},
    fuelExpiresAt: 0,
    destroyedAt: 0,
    wars: [],
    unanchoring: null,
    liquidOzoneQty: 0,
    devFlags: {
      ...(existing && existing.devFlags && typeof existing.devFlags === "object"
        ? existing.devFlags
        : {}),
      ...cloneValue(canonicalDevFlags),
      // Generic structure normalization intentionally owns a bounded schema.
      // Carry the canonical capture checkpoint inside devFlags so runtime balls
      // can project it without inventing ownership or relying on Sov indexes.
      entosisCapture: mirroredEntosisCapture,
      campaignSourceInfo: mirroredCampaignSourceInfo,
      sovereigntyMirror: true,
      sovereigntyKind:
        typeID === TYPE_INFRASTRUCTURE_HUB
          ? "ihub"
          : "unknown",
    },
    accessProfile: {
      docking: "none",
      tethering: "none",
    },
  };
}

function syncSovereigntyStructureRuntime(systemState, options = {}) {
  const solarSystemID = normalizePositiveInteger(
    systemState && systemState.solarSystemID,
    null,
  );
  if (!solarSystemID) {
    return {
      success: false,
      errorMsg: "SOLAR_SYSTEM_NOT_FOUND",
    };
  }

  const nowMs = normalizeInteger(options.nowMs, Date.now());
  const desiredStructures = (Array.isArray(systemState && systemState.structures)
    ? systemState.structures
    : [])
    .filter((structure) =>
      SOVEREIGNTY_TYPE_IDS.has(normalizePositiveInteger(structure && structure.typeID, 0)))
    .map((structure) => buildMirrorRecord(systemState, structure, nowMs));
  const desiredIDs = new Set(
    desiredStructures
      .map((structure) => normalizePositiveInteger(structure && structure.structureID, null))
      .filter(Boolean),
  );

  const existingStructures = structureState.listStructuresForSystem(solarSystemID, {
    includeDestroyed: true,
    refresh: false,
  }).filter((structure) => isSovereigntyMirrorStructure(structure));

  for (const mirror of desiredStructures) {
    const upsertResult = structureState.upsertStructureRecord(mirror, {
      // Startup/recovery callers request a silent canonical-to-mirror repair.
      // Suppress the generic structure listener as well as our explicit scene
      // sync; otherwise a loaded scene receives duplicate Add/Remove/Change
      // traffic while the world is still reconciling.
      emitLive: options.syncScene !== false,
    });
    if (!upsertResult.success) {
      return upsertResult;
    }
  }

  for (const structure of existingStructures) {
    const structureID = normalizePositiveInteger(structure && structure.structureID, null);
    if (!structureID || desiredIDs.has(structureID)) {
      continue;
    }
    const removeResult = structureState.removeStructure(structureID, {
      emitLive: options.syncScene !== false,
    });
    if (!removeResult.success) {
      return removeResult;
    }
  }

  if (options.syncScene !== false && typeof spaceRuntime.syncStructureSceneState === "function") {
    spaceRuntime.syncStructureSceneState(solarSystemID, {
      broadcast: options.broadcast !== false,
      excludedSession: options.excludedSession || null,
    });
  }

  return {
    success: true,
    data: {
      solarSystemID,
      structureIDs: [...desiredIDs].sort((left, right) => left - right),
    },
  };
}

function clearAllSovereigntyStructureMirrors(options = {}) {
  const structures = structureState.listStructures({
    includeDestroyed: true,
    refresh: false,
  }).filter((structure) => isSovereigntyMirrorStructure(structure));
  const affectedSystems = new Set();

  for (const structure of structures) {
    const structureID = normalizePositiveInteger(structure && structure.structureID, null);
    const solarSystemID = normalizePositiveInteger(structure && structure.solarSystemID, null);
    if (!structureID) {
      continue;
    }
    const removeResult = structureState.removeStructure(structureID);
    if (!removeResult.success) {
      return removeResult;
    }
    if (solarSystemID) {
      affectedSystems.add(solarSystemID);
    }
  }

  if (options.syncScene !== false && typeof spaceRuntime.syncStructureSceneState === "function") {
    for (const solarSystemID of affectedSystems) {
      spaceRuntime.syncStructureSceneState(solarSystemID, {
        broadcast: options.broadcast !== false,
        excludedSession: options.excludedSession || null,
      });
    }
  }

  return {
    success: true,
    data: {
      removedCount: structures.length,
      solarSystemIDs: [...affectedSystems].sort((left, right) => left - right),
    },
  };
}

function clearAllSovereigntyRelatedStructures(options = {}) {
  const structures = structureState.listStructures({
    includeDestroyed: true,
    refresh: false,
  }).filter((structure) => isSovereigntyRelatedStructure(structure));
  const affectedSystems = new Set();

  for (const structure of structures) {
    const structureID = normalizePositiveInteger(structure && structure.structureID, null);
    const solarSystemID = normalizePositiveInteger(structure && structure.solarSystemID, null);
    if (!structureID) {
      continue;
    }
    // The GM sovereignty wipe includes fitted built-ins and seeded fuel. FLEX
    // structures now contain real inventory, so the empty-only removal path
    // would stop the wipe before the remaining Hub mirrors were removed.
    const removeResult = structureState.removeStructure(structureID, {
      discardContents: true,
    });
    if (!removeResult.success) {
      return removeResult;
    }
    if (solarSystemID) {
      affectedSystems.add(solarSystemID);
    }
  }

  if (options.syncScene !== false && typeof spaceRuntime.syncStructureSceneState === "function") {
    for (const solarSystemID of affectedSystems) {
      spaceRuntime.syncStructureSceneState(solarSystemID, {
        broadcast: options.broadcast !== false,
        excludedSession: options.excludedSession || null,
      });
    }
  }

  return {
    success: true,
    data: {
      removedCount: structures.length,
      solarSystemIDs: [...affectedSystems].sort((left, right) => left - right),
    },
  };
}

module.exports = {
  clearAllSovereigntyRelatedStructures,
  clearAllSovereigntyStructureMirrors,
  isSovereigntyAuxiliaryStructure,
  isSovereigntyRelatedStructure,
  syncSovereigntyStructureRuntime,
};
