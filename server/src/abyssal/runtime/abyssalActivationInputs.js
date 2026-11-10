"use strict";
const { toInt, normalizeText, toBool, normalizeLowerText } = require("../domain/abyssalRuntimeValues");

function resolveFilamentContentDefinition(ports,
  filamentTypeRecord,
  shipProfile,
  deps = ports.getDependencies(),
  selectionSeed = 0,
) {
  const {
    log,
  } = ports;
  const resolution = ports.resolveFilamentDefinition(
    {
      filamentTypeID: toInt(filamentTypeRecord && filamentTypeRecord.typeID, 0),
      filamentName: normalizeText(filamentTypeRecord && filamentTypeRecord.name, ""),
      filamentTypeRecord,
      hullMode: normalizeText(shipProfile && shipProfile.key, ""),
      filamentItemID: toInt(selectionSeed, 0),
    },
    {
      allowDebugFallback: deps && deps.abyssalAllowDebugDefinition === true,
    },
  );
  if (!resolution || !resolution.success) {
    log.warn(
      `[AbyssalMgr] Filament definition missing type=${toInt(filamentTypeRecord && filamentTypeRecord.typeID, 0)} ` +
        `name="${normalizeText(filamentTypeRecord && filamentTypeRecord.name, "unknown")}" ` +
        `hull=${normalizeText(shipProfile && shipProfile.key, "unknown")} ` +
        `reason=${normalizeText(resolution && resolution.errorMsg, "UNSUPPORTED_FILAMENT_DEFINITION")}`,
    );
    return resolution;
  }
  log.info(
    `[AbyssalMgr] Filament definition resolved type=${resolution.definition.filamentTypeID} ` +
      `name="${resolution.definition.filamentName}" definition=${resolution.definition.definitionID} ` +
      `tier=${resolution.definition.tier} hull=${resolution.definition.hullMode} ` +
      `debugFallback=${resolution.usedDebugFallback === true}`,
  );
  if (
    resolution.definition &&
    resolution.definition.authoredContentSelection &&
    resolution.definition.authoredContentSelection.fallbackUsed === true
  ) {
    log.warn(
      `[AbyssalContent] Authored capture unavailable ` +
        `type=${resolution.definition.filamentTypeID} tier=${resolution.definition.tier} ` +
        `weather=${normalizeText(resolution.definition.weatherType, "unknown")} ` +
        `diagnostic=${JSON.stringify(resolution.definition.authoredContentSelection)}`,
    );
  }
  return resolution;
}

function resolveTraceContentProfile(ports, traceState, shipProfile, deps = ports.getDependencies()) {
  const {
    getContentProfile,
  } = ports;
  const existingProfile = getContentProfile(traceState);
  if (existingProfile) {
    return {
      success: true,
      definition: existingProfile,
      usedDebugFallback: existingProfile.debugFallback === true,
      fromTraceState: true,
    };
  }
  const filamentTypeRecord = deps.resolveItemByTypeID(toInt(traceState && traceState.filamentTypeID, 0));
  if (!filamentTypeRecord) {
    return {
      success: false,
      errorMsg: "FILAMENT_TYPE_NOT_FOUND",
    };
  }
  return resolveFilamentContentDefinition(ports,
    filamentTypeRecord,
    shipProfile,
    deps,
    toInt(traceState && (traceState.traceItemID || traceState.filamentItemID), 0),
  );
}

function resolveFilamentItemID(ports, args, deps) {
  const {
    isAbyssalFilamentItem,
  } = ports;
  for (const entry of Array.isArray(args) ? args : []) {
    const directID = toInt(entry, 0);
    if (directID > 0) {
      const candidate = deps.findItemById(directID);
      if (candidate && isAbyssalFilamentItem(candidate, deps)) {
        return directID;
      }
    }

    const nestedID = toInt(entry && entry.itemID, 0);
    if (nestedID > 0) {
      const candidate = deps.findItemById(nestedID);
      if (candidate && isAbyssalFilamentItem(candidate, deps)) {
        return nestedID;
      }
    }
  }

  return toInt(args && args[0], 0);
}

function resolveActivateForFleet(ports, args) {
  if (!Array.isArray(args) || args.length < 2) {
    return false;
  }
  return toBool(args[1], false);
}

function isFleetRequiredForAbyssalShipProfile(ports, shipProfile = null) {
  const shipClass = normalizeLowerText(shipProfile && shipProfile.key, "");
  return (
    shipClass === "frigate" ||
    shipClass === "destroyer" ||
    toInt(shipProfile && shipProfile.requiredFilaments, 1) > 1
  );
}

function resolveGateTraceID(ports, args, session, deps) {
  const {
    getActiveTraceState,
    getCharacterID,
  } = ports;
  let explicitCandidateID = 0;
  for (const entry of Array.isArray(args) ? args : []) {
    const candidateID = toInt(entry, 0);
    if (candidateID > 0) {
      explicitCandidateID = explicitCandidateID || candidateID;
      if (getActiveTraceState(candidateID, deps)) {
        return candidateID;
      }
    }

    const nestedID = toInt(entry && entry.itemID, 0);
    if (nestedID > 0) {
      explicitCandidateID = explicitCandidateID || nestedID;
      if (getActiveTraceState(nestedID, deps)) {
        return nestedID;
      }
    }
  }

  if (explicitCandidateID > 0) {
    return explicitCandidateID;
  }

  const characterID = getCharacterID(session);
  return ports.getTraceIDForCharacter(characterID) || 0;
}

function resolveAbyssalTierFromFilamentName(ports, name) {
  const normalized = normalizeLowerText(name, "");
  if (!normalized) {
    return 1;
  }

  const tierMatch = normalized.match(/tier\s*(\d+)/);
  if (tierMatch) {
    const numericTier = toInt(tierMatch[1], 1);
    return Math.max(0, Math.min(6, numericTier || 1));
  }

  if (normalized.includes("tranquil")) {
    return 0;
  }

  if (normalized.includes("calm")) {
    return 1;
  }
  if (normalized.includes("agitated")) {
    return 2;
  }
  if (normalized.includes("fierce")) {
    return 3;
  }
  if (normalized.includes("raging")) {
    return 4;
  }
  if (normalized.includes("chaotic")) {
    return 5;
  }
  if (normalized.includes("cataclysmic")) {
    return 6;
  }
  return 1;
}

function resolveAbyssalTemplateID(ports, traceState) {
  const {
    getContentProfile,
    PLACEHOLDER_POCKET_TEMPLATE_ID_BY_TIER,
  } = ports;
  const contentProfile = getContentProfile(traceState);
  const tier = toInt(
    contentProfile && contentProfile.tier,
    resolveAbyssalTierFromFilamentName(ports, traceState && traceState.filamentName),
  );
  return (
    PLACEHOLDER_POCKET_TEMPLATE_ID_BY_TIER[tier] ||
    PLACEHOLDER_POCKET_TEMPLATE_ID_BY_TIER[1]
  );
}

function buildPocketSiteKey(ports, traceState) {
  return `abyssal:trace:${toInt(traceState && traceState.traceItemID, 0)}`;
}

function createAbyssalActivationInputs(ports) {
  return {
    resolveFilamentContentDefinition: resolveFilamentContentDefinition.bind(null, ports),
    resolveTraceContentProfile: resolveTraceContentProfile.bind(null, ports),
    resolveFilamentItemID: resolveFilamentItemID.bind(null, ports),
    resolveActivateForFleet: resolveActivateForFleet.bind(null, ports),
    isFleetRequiredForAbyssalShipProfile: isFleetRequiredForAbyssalShipProfile.bind(null, ports),
    resolveGateTraceID: resolveGateTraceID.bind(null, ports),
    resolveAbyssalTierFromFilamentName: resolveAbyssalTierFromFilamentName.bind(null, ports),
    resolveAbyssalTemplateID: resolveAbyssalTemplateID.bind(null, ports),
    buildPocketSiteKey: buildPocketSiteKey.bind(null, ports),
  };
}

module.exports = { createAbyssalActivationInputs };
