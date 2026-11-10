"use strict";

const {
  cloneValue,
} = require("../../common/clone");

const path = require("path");

const worldData = require(path.join(__dirname, "../../space/worldData"));
const spaceRuntime = require(path.join(__dirname, "../../space/runtime"));
const {
  isSovereigntyClaimableSolarSystem,
} = require(path.join(__dirname, "./sovSystemRules"));
const {
  currentFileTime,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const {
  getAllianceRecord,
  getCorporationRecord,
} = require(path.join(__dirname, "../corporation/corporationState"));
const {
  STRUCTURE_SERVICE_STATE,
  STRUCTURE_STATE_NAME_BY_ID,
} = require(path.join(__dirname, "../structure/structureConstants"));
const {
  DEV_INDEX_LEVEL_WIDTH,
  STRATEGIC_INDEX_DAY_THRESHOLDS,
  FILETIME_EPOCH_OFFSET,
  FILETIME_TICKS_PER_MILLISECOND,
  TYPE_INFRASTRUCTURE_HUB,
} = require(path.join(__dirname, "./sovConstants"));
const {
  getDefaultHubPosition,
} = require(path.join(__dirname, "./sovHubPlacement"));
const {
  cancelAllianceCapitalTransition,
  getAllianceCapitalInfo,
  getAlliancePrimeInfo,
  getOperationalIndexLevel,
  getStrategicIndexLevel,
  getSystemState,
  listAllSovereigntySystemStates,
  listSovStructuresForSystem,
  setAllianceCapitalSystem,
  setAlliancePrimeHour,
  upsertAllianceState,
  upsertSystemState,
} = require(path.join(__dirname, "./sovState"));
const {
  COMMAND_NODE_TYPE_ID,
  clearOwnedHubVulnerabilityState,
  configureSovereigntyVulnerability,
  forceCommandNodeCapture,
  forceOwnedHubReinforcement,
  getSovereigntyCampaignProjection,
  shiftOwnedHubTimers,
  tickSovereigntyCampaigns,
} = require(path.join(__dirname, "./sovCampaignState"));

const FILETIME_TICKS_PER_SECOND = 10_000_000n;
const FILETIME_TICKS_PER_DAY = 86400n * FILETIME_TICKS_PER_SECOND;
const SYNTHETIC_SOV_ITEM_ID_BASE = 1_140_000_000_000;
const DEFAULT_VULNERABILITY_DURATION_SECONDS = 900;
const OWNER_SCC = 1000132;

let syntheticItemSequence = 1;

function normalizeInteger(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.trunc(numeric);
}

function normalizePositiveInteger(value, fallback = null) {
  const numeric = normalizeInteger(value, 0);
  return numeric > 0 ? numeric : fallback;
}

function normalizeSpacePoint(value, fallback = null) {
  if (!value || typeof value !== "object") {
    return fallback;
  }
  const x = Number(value.x);
  const y = Number(value.y);
  const z = Number(value.z);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    return fallback;
  }
  return { x, y, z };
}

function cloneSpacePoint(value, fallback = null) {
  const point = normalizeSpacePoint(value, fallback);
  return point ? { ...point } : fallback;
}

function formatSpacePoint(value) {
  const point = normalizeSpacePoint(value, null);
  if (!point) {
    return null;
  }
  return `${Math.round(point.x)},${Math.round(point.y)},${Math.round(point.z)}`;
}

function resolveCurrentSolarSystemID(session) {
  return normalizePositiveInteger(
    session &&
      (
        (session._space && session._space.systemID) ||
        session.solarsystemid2 ||
        session.solarsystemid
      ),
    0,
  );
}

function resolveSolarSystemID(session, token, fallback = 0) {
  const trimmed = String(token || "").trim().toLowerCase();
  if (!trimmed || trimmed === "here" || trimmed === "current") {
    return resolveCurrentSolarSystemID(session) || fallback;
  }
  const numericSolarSystemID = normalizePositiveInteger(trimmed, 0);
  if (!numericSolarSystemID) {
    return fallback;
  }
  return worldData.getSolarSystemByID(numericSolarSystemID)
    ? numericSolarSystemID
    : fallback;
}

function resolveAllianceID(session, token, fallback = null) {
  if (token === undefined || token === null || token === "") {
    return normalizePositiveInteger(
      session && (session.allianceID || session.allianceid),
      fallback,
    );
  }
  return normalizePositiveInteger(token, fallback);
}

function resolveCorporationID(session, token, fallback = null) {
  if (token === undefined || token === null || token === "") {
    return normalizePositiveInteger(
      session && (session.corporationID || session.corpid),
      fallback,
    );
  }
  return normalizePositiveInteger(token, fallback);
}

function isHubStructure(structure) {
  return normalizePositiveInteger(structure && structure.typeID, 0) === TYPE_INFRASTRUCTURE_HUB;
}

function isCommandNodeStructure(structure) {
  return normalizePositiveInteger(structure && structure.typeID, 0) === COMMAND_NODE_TYPE_ID;
}

function formatStructureKind(structure) {
  if (!structure) {
    return "unknown";
  }
  if (isHubStructure(structure)) {
    return "ihub";
  }
  if (isCommandNodeStructure(structure)) {
    return "node";
  }
  return `type=${normalizePositiveInteger(structure.typeID, 0)}`;
}

function nextSyntheticSovItemID() {
  const offset = Number(currentFileTime() % 1_000_000_000n);
  const itemID =
    SYNTHETIC_SOV_ITEM_ID_BASE +
    (offset * 10) +
    syntheticItemSequence;
  syntheticItemSequence = syntheticItemSequence >= 9
    ? 1
    : syntheticItemSequence + 1;
  return itemID;
}

function ensureValidSolarSystem(solarSystemID) {
  const numericSolarSystemID = normalizePositiveInteger(solarSystemID, null);
  if (!numericSolarSystemID) {
    return {
      success: false,
      errorMsg: "SOLAR_SYSTEM_REQUIRED",
    };
  }
  const solarSystem = worldData.getSolarSystemByID(numericSolarSystemID);
  if (!solarSystem) {
    return {
      success: false,
      errorMsg: "SOLAR_SYSTEM_NOT_FOUND",
    };
  }
  return {
    success: true,
    data: {
      solarSystemID: numericSolarSystemID,
      solarSystem,
    },
  };
}

function formatOwnerLabel(kind, ownerID) {
  const numericOwnerID = normalizePositiveInteger(ownerID, null);
  if (!numericOwnerID) {
    return `${kind}=none`;
  }
  const record = kind === "alliance"
    ? getAllianceRecord(numericOwnerID)
    : getCorporationRecord(numericOwnerID);
  const recordName = record
    ? (record.allianceName || record.shortName || record.corporationName || record.tickerName)
    : null;
  return recordName
    ? `${kind}=${recordName}(${numericOwnerID})`
    : `${kind}=${numericOwnerID}`;
}

function filetimeToUnixMs(value) {
  try {
    const filetime = BigInt(String(value || "0"));
    if (filetime <= FILETIME_EPOCH_OFFSET) {
      return 0;
    }
    return Number((filetime - FILETIME_EPOCH_OFFSET) / FILETIME_TICKS_PER_MILLISECOND);
  } catch (error) {
    // ignored: an unreadable FILETIME counts as time zero
    return 0;
  }
}

function shiftFiletimeBackward(rawValue, seconds) {
  const numericSeconds = Math.max(0, normalizeInteger(seconds, 0));
  if (!rawValue || rawValue === "0" || numericSeconds <= 0) {
    return rawValue || "0";
  }
  try {
    const shiftedValue =
      BigInt(String(rawValue)) - (BigInt(numericSeconds) * FILETIME_TICKS_PER_SECOND);
    if (shiftedValue <= FILETIME_EPOCH_OFFSET) {
      return "0";
    }
    return shiftedValue.toString();
  } catch (error) {
    return rawValue || "0";
  }
}

function formatFiletime(rawValue) {
  const unixMs = filetimeToUnixMs(rawValue);
  return unixMs > 0 ? new Date(unixMs).toISOString() : "0";
}

function formatUnixMs(rawValue) {
  const unixMs = normalizeInteger(rawValue, 0);
  return unixMs > 0 ? new Date(unixMs).toISOString() : "0";
}

function getRawSystemState(solarSystemID) {
  return cloneValue(getSystemState(solarSystemID)) || null;
}

// The Hub that carries the system's claim: claim index, Hub index and the
// physical structure all name the same item, and the system has an owner.
function findOwnedHub(system) {
  if (!system || !normalizePositiveInteger(system.allianceID, null)) {
    return null;
  }
  const hubID = normalizePositiveInteger(system.infrastructureHubID, null);
  if (!hubID || normalizePositiveInteger(system.claimStructureID, null) !== hubID) {
    return null;
  }
  const structures = Array.isArray(system.structures) ? system.structures : [];
  return structures.find(
    (structure) => isHubStructure(structure) && normalizePositiveInteger(structure.itemID, null) === hubID,
  ) || null;
}

function requireOwnedHub(solarSystemID) {
  const validation = ensureValidSolarSystem(solarSystemID);
  if (!validation.success) {
    return validation;
  }
  const system = getRawSystemState(validation.data.solarSystemID);
  const hub = findOwnedHub(system);
  if (!hub) {
    return {
      success: false,
      errorMsg: "OWNED_HUB_REQUIRED",
    };
  }
  return {
    success: true,
    data: {
      solarSystemID: validation.data.solarSystemID,
      system,
      hub,
    },
  };
}

// Command nodes belong to one Hub's campaign and sit anywhere in the
// constellation. When a GM re-anchors or clears that Hub, its nodes go too.
function removeCampaignNodesForHub(hubID) {
  const numericHubID = normalizePositiveInteger(hubID, null);
  if (!numericHubID) {
    return [];
  }
  const removedNodeIDs = [];
  for (const system of listAllSovereigntySystemStates()) {
    const structures = Array.isArray(system.structures) ? system.structures : [];
    const kept = structures.filter((structure) => {
      const flags = structure && structure.devFlags ? structure.devFlags : {};
      const isNode =
        isCommandNodeStructure(structure) &&
        normalizePositiveInteger(flags.campaignTargetID, null) === numericHubID;
      if (isNode) {
        removedNodeIDs.push(normalizePositiveInteger(structure.itemID, 0));
      }
      return !isNode;
    });
    if (kept.length !== structures.length) {
      upsertSystemState(system.solarSystemID, { structures: kept });
    }
  }
  return removedNodeIDs;
}

/**
 * Places a Sovereignty Hub 100 km above the sun's warp-in point, the same
 * spot a GM capture uses. With an owner the Hub carries the claim at once:
 * claim index, Hub index and structure are one item. With `neutral: true`
 * the Hub is SCC-owned and waits for an Entosis claim, like a player launch.
 * An existing Hub in the system is reused and keeps its position.
 */
function anchorSovereigntyHub(solarSystemID, allianceID, corporationID, options = {}) {
  const validation = ensureValidSolarSystem(solarSystemID);
  if (!validation.success) {
    return validation;
  }
  const numericSolarSystemID = validation.data.solarSystemID;
  if (!isSovereigntyClaimableSolarSystem(numericSolarSystemID)) {
    return { success: false, errorMsg: "SOLAR_SYSTEM_NOT_CONQUERABLE" };
  }
  const neutral = options.neutral === true;
  const ownerAllianceID = neutral ? null : normalizePositiveInteger(allianceID, null);
  const ownerCorporationID = neutral ? OWNER_SCC : normalizePositiveInteger(corporationID, null);
  if (!neutral && (!ownerAllianceID || !ownerCorporationID)) {
    return { success: false, errorMsg: "OWNER_PAIR_REQUIRED" };
  }
  const defaultPosition = getDefaultHubPosition(numericSolarSystemID);
  if (!defaultPosition) {
    return { success: false, errorMsg: "SUN_NOT_FOUND" };
  }

  const currentSystem = getRawSystemState(numericSolarSystemID) || {};
  const currentStructures = Array.isArray(currentSystem.structures)
    ? cloneValue(currentSystem.structures)
    : [];
  const existing = currentStructures.find((structure) => isHubStructure(structure)) || null;
  const hubID = existing ? normalizePositiveInteger(existing.itemID, null) : nextSyntheticSovItemID();
  const nowMs = Date.now();
  const sameOwner =
    !neutral &&
    normalizePositiveInteger(currentSystem.allianceID, null) === ownerAllianceID &&
    normalizePositiveInteger(currentSystem.claimStructureID, null) === hubID;
  const hub = {
    itemID: hubID,
    typeID: TYPE_INFRASTRUCTURE_HUB,
    name: existing && existing.name ? existing.name : null,
    ownerID: ownerCorporationID,
    corporationID: ownerCorporationID,
    allianceID: ownerAllianceID,
    solarSystemID: numericSolarSystemID,
    campaignEventType: 0,
    campaignStartTime: "0",
    campaignScoresByTeam: {},
    vulnerableStartTime: "0",
    vulnerableEndTime: "0",
    position: cloneSpacePoint(existing && existing.position, null) || defaultPosition,
    devFlags: {
      sovereigntyNeutralHub: neutral,
      sovereigntyCaptured: !neutral,
      sovereigntyCaptureEpoch: neutral
        ? `sov-hub-deployment:${numericSolarSystemID}:gm:${hubID}:${nowMs}`
        : `gm-capture:${numericSolarSystemID}:${hubID}:${nowMs}`,
      sovereigntyGmAnchored: true,
    },
  };
  if (existing) {
    removeCampaignNodesForHub(hubID);
  }
  // A player launch always happens inside a loaded scene. Load this system's
  // scene too, so the Hub, and flex structures placed after it, are live at
  // once: the cyno jam and other scene-driven service checks run only there.
  spaceRuntime.ensureScene(numericSolarSystemID);
  const otherStructures = (getRawSystemState(numericSolarSystemID) || {}).structures || [];
  const structures = [
    ...otherStructures.filter((structure) => !isHubStructure(structure)),
    hub,
  ];
  const patch = neutral
    ? {
        allianceID: null,
        corporationID: null,
        claimStructureID: null,
        infrastructureHubID: null,
        claimTime: "0",
        structures,
        devIndices: { claimedForDays: 0 },
      }
    : {
        allianceID: ownerAllianceID,
        corporationID: ownerCorporationID,
        claimStructureID: hubID,
        infrastructureHubID: hubID,
        claimTime: sameOwner && String(currentSystem.claimTime || "0") !== "0"
          ? String(currentSystem.claimTime)
          : currentFileTime().toString(),
        structures,
        ...(sameOwner ? {} : { devIndices: { claimedForDays: 0 } }),
      };
  const nextSystem = upsertSystemState(numericSolarSystemID, patch, {
    suppressStructureSync: options.suppressStructureSync === true,
    suppressNotifications: options.suppressNotifications === true,
  });
  return {
    success: true,
    data: {
      solarSystemID: numericSolarSystemID,
      hubID,
      neutral,
      reused: Boolean(existing),
      position: cloneSpacePoint(hub.position, null),
      system: nextSystem,
    },
  };
}

function setHubVulnerabilityWindow(solarSystemID, durationSeconds) {
  const owned = requireOwnedHub(solarSystemID);
  if (!owned.success) {
    return owned;
  }
  const duration = Math.max(
    1,
    normalizeInteger(durationSeconds, DEFAULT_VULNERABILITY_DURATION_SECONDS),
  );
  const startFileTime = currentFileTime();
  const endFileTime = startFileTime + (BigInt(duration) * FILETIME_TICKS_PER_SECOND);
  const vulnerableStartMs = Number(
    (startFileTime - FILETIME_EPOCH_OFFSET) / FILETIME_TICKS_PER_MILLISECOND,
  );
  const vulnerableEndMs = Number(
    (endFileTime - FILETIME_EPOCH_OFFSET) / FILETIME_TICKS_PER_MILLISECOND,
  );
  // The engine owns the window: it checkpoints the state the Entosis tick
  // reads and writes the client-facing timestamps from it.
  const configured = configureSovereigntyVulnerability({
    solarSystemID: owned.data.solarSystemID,
    targetID: owned.data.hub.itemID,
    nowMs: vulnerableStartMs,
    vulnerableStartMs,
    vulnerableEndMs,
  });
  if (!configured.success) {
    return configured;
  }
  return {
    success: true,
    data: {
      solarSystemID: owned.data.solarSystemID,
      hubID: owned.data.hub.itemID,
      durationSeconds: duration,
      startTime: startFileTime.toString(),
      endTime: endFileTime.toString(),
    },
  };
}

function clearHubVulnerabilityWindow(solarSystemID) {
  const owned = requireOwnedHub(solarSystemID);
  if (!owned.success) {
    return owned;
  }
  const cleared = clearOwnedHubVulnerabilityState({
    solarSystemID: owned.data.solarSystemID,
    targetID: owned.data.hub.itemID,
  });
  if (!cleared.success) {
    return cleared;
  }
  return {
    success: true,
    data: {
      solarSystemID: owned.data.solarSystemID,
      hubID: owned.data.hub.itemID,
    },
  };
}

/**
 * Reinforces the owned Hub through the campaign engine. Without an exit the
 * engine picks its own time, about 48 hours out; `exitSeconds` sets the exit
 * relative to now, and 0 starts the command node event at once.
 */
function reinforceSystemHub(solarSystemID, options = {}) {
  const owned = requireOwnedHub(solarSystemID);
  if (!owned.success) {
    return owned;
  }
  const nowMs = Date.now();
  const exitSeconds = options.exitSeconds;
  const reinforced = forceOwnedHubReinforcement({
    solarSystemID: owned.data.solarSystemID,
    targetID: owned.data.hub.itemID,
    nowMs,
    reinforcementExitMs: Number.isFinite(Number(exitSeconds)) && exitSeconds !== null
      ? nowMs + Math.max(0, normalizeInteger(exitSeconds, 0)) * 1000
      : undefined,
  });
  if (!reinforced.success) {
    return reinforced;
  }
  let campaign = null;
  if (Number(reinforced.data.reinforcementExitMs) <= nowMs) {
    const ticked = tickSovereigntyCampaigns({
      targetID: owned.data.hub.itemID,
      nowMs,
    });
    if (!ticked.success) {
      return ticked;
    }
    campaign = getSovereigntyCampaignProjection({ targetID: owned.data.hub.itemID });
  }
  return {
    success: true,
    data: {
      solarSystemID: owned.data.solarSystemID,
      hubID: owned.data.hub.itemID,
      reinforcementExitMs: Number(reinforced.data.reinforcementExitMs),
      campaign,
    },
  };
}

/**
 * Captures one command node of the owned Hub's running campaign for a side.
 * `nodeToken` is a node ID or `next`; `side` is `defender`, `attacker` or an
 * alliance ID. `attacker` uses `sessionAllianceID` when that alliance is not
 * the defender.
 */
function captureSystemCampaignNode(solarSystemID, options = {}) {
  const owned = requireOwnedHub(solarSystemID);
  if (!owned.success) {
    return owned;
  }
  const hubID = owned.data.hub.itemID;
  const campaign = getSovereigntyCampaignProjection({ targetID: hubID });
  if (!campaign || campaign.status !== "active") {
    return { success: false, errorMsg: "CAMPAIGN_NOT_ACTIVE" };
  }
  const nodes = Array.isArray(campaign.commandNodes) ? campaign.commandNodes : [];
  const nodeToken = String(options.nodeToken || "next").trim().toLowerCase();
  const node = nodeToken === "next" || nodeToken === "any"
    ? nodes[0] || null
    : nodes.find((entry) => Number(entry.nodeID) === normalizePositiveInteger(nodeToken, 0)) || null;
  if (!node) {
    return { success: false, errorMsg: "COMMAND_NODE_NOT_FOUND" };
  }
  const defenderAllianceID = normalizePositiveInteger(campaign.defenderAllianceID, null);
  const side = String(options.side || "").trim().toLowerCase();
  let allianceID = null;
  if (side === "defender" || side === "defence" || side === "defense") {
    allianceID = defenderAllianceID;
  } else if (side === "attacker" || side === "attack") {
    const sessionAllianceID = normalizePositiveInteger(options.sessionAllianceID, null);
    if (!sessionAllianceID || sessionAllianceID === defenderAllianceID) {
      return { success: false, errorMsg: "ATTACKER_ALLIANCE_REQUIRED" };
    }
    allianceID = sessionAllianceID;
  } else {
    allianceID = normalizePositiveInteger(side, null);
  }
  if (!allianceID) {
    return { success: false, errorMsg: "SIDE_REQUIRED" };
  }
  const captured = forceCommandNodeCapture({
    nodeID: node.nodeID,
    campaignEpoch: campaign.campaignEpoch,
    allianceID,
    nowMs: Date.now(),
  });
  if (!captured.success) {
    return captured;
  }
  return {
    success: true,
    data: {
      solarSystemID: owned.data.solarSystemID,
      hubID,
      nodeID: node.nodeID,
      nodeSolarSystemID: node.solarSystemID,
      allianceID,
      defenderWon: allianceID === defenderAllianceID,
      completed: captured.completed === true,
      result: captured.data.result || null,
      scoresByTeam: cloneValue(captured.data.scoresByTeam),
      replacementNodeID: captured.data.replacementNodeID || null,
    },
  };
}

function fastForwardSovereigntyTimers(solarSystemID, seconds) {
  const numericSeconds = Math.max(0, normalizeInteger(seconds, 0));
  if (numericSeconds <= 0) {
    return {
      success: false,
      errorMsg: "SECONDS_REQUIRED",
    };
  }

  const currentSystem = getRawSystemState(solarSystemID);
  if (!currentSystem) {
    return {
      success: false,
      errorMsg: "SYSTEM_NOT_FOUND",
    };
  }

  let shiftedStructureTimerCount = 0;
  const shiftedStructures = (Array.isArray(currentSystem.structures) ? currentSystem.structures : []).map(
    (structure) => {
      const nextStructure = {
        ...cloneValue(structure),
        campaignStartTime: shiftFiletimeBackward(structure.campaignStartTime, numericSeconds),
        vulnerableStartTime: shiftFiletimeBackward(structure.vulnerableStartTime, numericSeconds),
        vulnerableEndTime: shiftFiletimeBackward(structure.vulnerableEndTime, numericSeconds),
      };
      if (
        nextStructure.campaignStartTime !== structure.campaignStartTime ||
        nextStructure.vulnerableStartTime !== structure.vulnerableStartTime ||
        nextStructure.vulnerableEndTime !== structure.vulnerableEndTime
      ) {
        shiftedStructureTimerCount += 1;
      }
      return nextStructure;
    },
  );

  upsertSystemState(solarSystemID, {
    structures: shiftedStructures,
  });

  // The owned Hub's engine state carries its own clock. Shift it too, or the
  // next checkpoint writes the old window back over the displayed one.
  let shiftedEngine = false;
  const ownedHub = findOwnedHub(currentSystem);
  if (ownedHub) {
    const shifted = shiftOwnedHubTimers({
      solarSystemID: currentSystem.solarSystemID,
      targetID: ownedHub.itemID,
      seconds: numericSeconds,
    });
    if (!shifted.success) {
      return shifted;
    }
    shiftedEngine = shifted.shifted === true;
  }

  let shiftedAllianceTimerCount = 0;
  const allianceID = normalizePositiveInteger(currentSystem.allianceID, null);
  if (allianceID) {
    const primeInfo = getAlliancePrimeInfo(allianceID);
    const capitalInfo = getAllianceCapitalInfo(allianceID);
    const nextPrimeValidAfter = shiftFiletimeBackward(
      primeInfo && primeInfo.newPrimeHourValidAfter,
      numericSeconds,
    );
    const nextCapitalValidAfter = shiftFiletimeBackward(
      capitalInfo && capitalInfo.newCapitalSystemValidAfter,
      numericSeconds,
    );
    if (nextPrimeValidAfter !== String(primeInfo && primeInfo.newPrimeHourValidAfter || "0")) {
      shiftedAllianceTimerCount += 1;
    }
    if (
      nextCapitalValidAfter !==
      String(capitalInfo && capitalInfo.newCapitalSystemValidAfter || "0")
    ) {
      shiftedAllianceTimerCount += 1;
    }
    upsertAllianceState(allianceID, {
      primeInfo: {
        newPrimeHourValidAfter: nextPrimeValidAfter,
      },
      capitalInfo: {
        newCapitalSystemValidAfter: nextCapitalValidAfter,
      },
    });
  }

  return {
    success: true,
    data: {
      solarSystemID,
      seconds: numericSeconds,
      shiftedStructureTimerCount,
      shiftedAllianceTimerCount,
      shiftedEngine,
    },
  };
}

// Claims the system for an owner with a Hub at the sun. The Hub is the claim.
function captureSystemForOwner(solarSystemID, allianceID, corporationID) {
  const anchored = anchorSovereigntyHub(solarSystemID, allianceID, corporationID);
  if (!anchored.success) {
    return anchored;
  }
  return {
    success: true,
    data: {
      solarSystemID: anchored.data.solarSystemID,
      hubID: anchored.data.hubID,
      system: anchored.data.system,
    },
  };
}

function loseSystemSovereignty(solarSystemID, nextAllianceID = null, nextCorporationID = null) {
  const normalizedNextAllianceID = normalizePositiveInteger(nextAllianceID, null);
  const normalizedNextCorporationID = normalizePositiveInteger(nextCorporationID, null);
  if (normalizedNextAllianceID || normalizedNextCorporationID) {
    if (!normalizedNextAllianceID || !normalizedNextCorporationID) {
      return {
        success: false,
        errorMsg: "OWNER_PAIR_REQUIRED",
      };
    }
    return captureSystemForOwner(
      solarSystemID,
      normalizedNextAllianceID,
      normalizedNextCorporationID,
    );
  }

  const currentSystem = getRawSystemState(solarSystemID);
  const currentHub = currentSystem
    ? (currentSystem.structures || []).find((structure) => isHubStructure(structure))
    : null;
  if (currentHub) {
    removeCampaignNodesForHub(currentHub.itemID);
  }
  const nextSystem = upsertSystemState(solarSystemID, {
    allianceID: null,
    corporationID: null,
    claimStructureID: null,
    infrastructureHubID: null,
    claimTime: "0",
    structures: [],
    devIndices: {
      claimedForDays: 0,
    },
  });

  return {
    success: true,
    data: {
      solarSystemID,
      system: nextSystem,
    },
  };
}

function clearSystemSovereignty(solarSystemID) {
  return loseSystemSovereignty(solarSystemID, null, null);
}

function setSystemClaimAge(solarSystemID, days) {
  if (!Number.isSafeInteger(days) || days < 0) {
    return { success: false, errorMsg: "INVALID_CLAIM_AGE" };
  }
  const claimTime = currentFileTime() - BigInt(days) * FILETIME_TICKS_PER_DAY;
  if (claimTime <= 0n) {
    return { success: false, errorMsg: "INVALID_CLAIM_AGE" };
  }
  const validation = ensureValidSolarSystem(solarSystemID);
  if (!validation.success) return validation;
  const system = getSystemState(validation.data.solarSystemID);
  if (
    !system || !system.allianceID || !system.corporationID ||
    (!system.claimStructureID && !system.infrastructureHubID) ||
    String(system.claimTime || "0") === "0"
  ) {
    return { success: false, errorMsg: "SOVEREIGNTY_CLAIM_REQUIRED" };
  }

  // The client checks SovHubInfo.claimTime, while upgrade validation uses the
  // strategic index. Set both in one update; age is absolute, not cumulative.
  const nextSystem = upsertSystemState(system.solarSystemID, {
    claimTime: claimTime.toString(),
    devIndices: { ...system.devIndices, claimedForDays: days },
  });
  return {
    success: Boolean(nextSystem),
    errorMsg: nextSystem ? null : "SOVEREIGNTY_AGE_UPDATE_FAILED",
    data: { solarSystemID: system.solarSystemID, days, system: nextSystem },
  };
}

function setSystemDevelopmentIndexValue(
  solarSystemID,
  indexKind,
  value,
) {
  const normalizedSolarSystemID = normalizePositiveInteger(solarSystemID, null);
  if (!normalizedSolarSystemID) {
    return {
      success: false,
      errorMsg: "SOLAR_SYSTEM_REQUIRED",
    };
  }

  const system = getSystemState(normalizedSolarSystemID);
  if (!system) {
    return {
      success: false,
      errorMsg: "SOLAR_SYSTEM_NOT_FOUND",
    };
  }

  const normalizedIndexKind = String(indexKind || "").trim().toLowerCase();
  const numericValue = Number(value);
  if (
    normalizedIndexKind !== "military" &&
    normalizedIndexKind !== "industrial" &&
    normalizedIndexKind !== "claimed" &&
    normalizedIndexKind !== "strategic"
  ) {
    return {
      success: false,
      errorMsg: "INVALID_INDEX_KIND",
    };
  }

  if (
    !Number.isSafeInteger(numericValue) || numericValue < 0 ||
    (normalizedIndexKind === "strategic" && numericValue > 5)
  ) {
    return { success: false, errorMsg: "INVALID_INDEX_VALUE" };
  }

  if (normalizedIndexKind === "strategic" || normalizedIndexKind === "claimed") {
    const days = normalizedIndexKind === "claimed"
      ? numericValue
      : (STRATEGIC_INDEX_DAY_THRESHOLDS[numericValue - 1] || 0);
    // Both the development-index service and the Hub's timestamp-based checks
    // must see the requested age, including when resetting an older claim.
    return setSystemClaimAge(normalizedSolarSystemID, days);
  }

  // The documented command accepts levels 0-5. Preserve larger raw-point
  // values used by existing GM scripts and sovereignty automation.
  const points = numericValue <= 5
    ? numericValue * DEV_INDEX_LEVEL_WIDTH
    : numericValue;
  const nextSystem = upsertSystemState(normalizedSolarSystemID, {
    devIndices: {
      ...system.devIndices,
      [normalizedIndexKind === "military" ? "militaryPoints" : "industrialPoints"]: points,
    },
  });
  return {
    success: Boolean(nextSystem),
    errorMsg: nextSystem ? null : "SOVEREIGNTY_INDEX_UPDATE_FAILED",
    data: {
      solarSystemID: normalizedSolarSystemID,
      system: nextSystem,
    },
  };
}

function describeCampaign(structure) {
  const campaignEventType = normalizeInteger(structure && structure.campaignEventType, 0);
  if (!campaignEventType) {
    return "campaign=off";
  }
  const scoreEntries = Object.entries(structure && structure.campaignScoresByTeam || {})
    .map(([teamID, score]) => `${teamID}:${score}`)
    .join(",");
  return [
    `campaign=event:${campaignEventType}`,
    `start=${formatFiletime(structure.campaignStartTime)}`,
    `scores=${scoreEntries || "none"}`,
  ].join(" ");
}

function describeVulnerability(structure) {
  if (
    !structure ||
    !structure.vulnerableStartTime ||
    !structure.vulnerableEndTime ||
    structure.vulnerableStartTime === "0" ||
    structure.vulnerableEndTime === "0"
  ) {
    return "vulnerability=off";
  }
  return [
    `vulnerability=${formatFiletime(structure.vulnerableStartTime)}`,
    `->`,
    `${formatFiletime(structure.vulnerableEndTime)}`,
  ].join(" ");
}

// The engine's own checkpoint for an owned Hub, which is what the Entosis
// tick reads. The display timestamps above are derived from it.
function describeHubEngineState(structure) {
  const state = structure && structure.devFlags && structure.devFlags.sovereigntyOwnedHubCapture;
  if (!state || typeof state !== "object") {
    return "engine=unscheduled";
  }
  return [
    `engine=${state.phase || "unknown"}`,
    `score=${Number(state.scoreAtLastUpdateTime || 0).toFixed(3)}`,
    `window=${formatUnixMs(state.vulnerableStartMs)} -> ${formatUnixMs(state.vulnerableEndMs)}`,
    `exit=${formatUnixMs(state.reinforcementExitMs)}`,
    `adm=${Number(state.occupancyMultiplier || 1).toFixed(2)}`,
  ].join(" | ");
}

function describeCampaignNodes(hubID) {
  const campaign = getSovereigntyCampaignProjection({ targetID: hubID });
  if (!campaign) {
    return [];
  }
  const scores = Object.entries(campaign.scoresByTeam || {})
    .map(([teamID, score]) => `${teamID}:${Number(score).toFixed(2)}`)
    .join(",");
  const lines = [
    `campaignEvent=${campaign.status || "unknown"} result=${campaign.result || "none"} constellation=${campaign.constellationID || "none"} scores=${scores || "none"}`,
  ];
  for (const node of campaign.commandNodes || []) {
    const capture = node.entosisCapture || {};
    lines.push(
      [
        `node=${node.nodeID}`,
        `system=${node.solarSystemID}`,
        `controlling=${capture.controllingTeamID ?? "none"}`,
        `score=${Number(capture.scoreAtLastUpdateTime ?? 0).toFixed(3)}`,
        formatSpacePoint(node.position)
          ? `pos=${formatSpacePoint(node.position)}`
          : null,
      ].filter(Boolean).join(" | "),
    );
  }
  return lines;
}

function describeHubUpgradeSnapshot(hubUpgrades) {
  if (!hubUpgrades || !Array.isArray(hubUpgrades.upgrades) || hubUpgrades.upgrades.length === 0) {
    return "hubUpgrades=none";
  }
  const upgradeLabels = hubUpgrades.upgrades.map((upgrade) => {
    const definition = upgrade && upgrade.definition ? upgrade.definition : {};
    const typeName = String(definition.typeName || upgrade.typeID || "upgrade");
    const powerState = Number(upgrade && upgrade.powerState) || 0;
    const stateLabel =
      powerState === 2
        ? "online"
        : powerState === 3
          ? "low"
          : powerState === 4
            ? "pending"
            : "offline";
    return `${typeName}(${upgrade.typeID})=${stateLabel}`;
  });
  return `hubUpgrades=${upgradeLabels.join(", ")}`;
}

function describeHubFuelSnapshot(hubFuel) {
  if (!hubFuel || !Array.isArray(hubFuel.fuels) || hubFuel.fuels.length === 0) {
    return "hubFuel=empty";
  }
  const fuelLabels = hubFuel.fuels
    .filter((fuel) => Number(fuel && fuel.amount) > 0 || Number(fuel && fuel.burnedPerHour) > 0)
    .map((fuel) => {
      const amount = Math.max(0, Number(fuel && fuel.amount) || 0);
      const burnedPerHour = Math.max(0, Number(fuel && fuel.burnedPerHour) || 0);
      const hoursLeft =
        burnedPerHour > 0
          ? `${(amount / burnedPerHour).toFixed(1)}h`
          : "static";
      return `${fuel.fuelTypeID}:${amount}@${burnedPerHour}/h(${hoursLeft})`;
    });
  return fuelLabels.length > 0
    ? `hubFuel=${fuelLabels.join(", ")}`
    : "hubFuel=empty";
}

function describeSovereigntyFlexStructures(solarSystemID) {
  const {
    getSovereigntyFlexDefinitions,
    listSovereigntyFlexStructuresForSystem,
  } = require(path.join(__dirname, "./sovFlexStructures"));
  const flexDefinitionsByTypeID = new Map(
    getSovereigntyFlexDefinitions().map((definition) => [definition.typeID, definition]),
  );
  const flexStructures = listSovereigntyFlexStructuresForSystem(solarSystemID);
  if (flexStructures.length === 0) {
    return [];
  }
  return flexStructures
    .sort((left, right) => Number(left.structureID || 0) - Number(right.structureID || 0))
    .map((structure) => {
      const definition = flexDefinitionsByTypeID.get(
        normalizePositiveInteger(structure && structure.typeID, 0),
      ) || null;
      const serviceState =
        definition &&
        Number(
          structure &&
            structure.serviceStates &&
            structure.serviceStates[String(definition.serviceID)],
        ) === STRUCTURE_SERVICE_STATE.ONLINE
          ? "online"
          : "offline";
      return [
        `flex=${definition ? definition.kind : structure.typeID}`,
        `item=${structure.structureID}`,
        `state=${STRUCTURE_STATE_NAME_BY_ID[normalizeInteger(structure && structure.state, 0)] || "unknown"}`,
        `service=${serviceState}`,
        `liquidOzone=${normalizeInteger(structure && structure.liquidOzoneQty, 0)}`,
        `fuelExpires=${formatUnixMs(structure && structure.fuelExpiresAt)}`,
        cloneSpacePoint(structure && structure.position, null)
          ? `pos=${formatSpacePoint(structure.position)}`
          : null,
      ].filter(Boolean).join(" | ");
    });
}

function buildSovereigntyStatusReport(solarSystemID) {
  const solarSystem = worldData.getSolarSystemByID(solarSystemID);
  if (!solarSystem) {
    return "Solar system not found.";
  }

  const system = getRawSystemState(solarSystemID) || {};
  const structures = listSovStructuresForSystem(solarSystemID);
  const lines = [];
  lines.push(
    `${solarSystem.solarSystemName || solarSystem.itemName || `System ${solarSystemID}`}(${solarSystemID}) ${formatOwnerLabel("alliance", system.allianceID)} ${formatOwnerLabel("corporation", system.corporationID)} claim=${system.claimStructureID || "none"} ihub=${system.infrastructureHubID || "none"}`,
  );

  if (system.allianceID) {
    const primeInfo = getAlliancePrimeInfo(system.allianceID);
    const capitalInfo = getAllianceCapitalInfo(system.allianceID);
    lines.push(
      `prime current=${primeInfo.currentPrimeHour} pending=${primeInfo.newPrimeHour} validAfter=${formatFiletime(primeInfo.newPrimeHourValidAfter)}`,
    );
    lines.push(
      `capital current=${capitalInfo.currentCapitalSystem || "none"} pending=${capitalInfo.newCapitalSystem || "none"} validAfter=${formatFiletime(capitalInfo.newCapitalSystemValidAfter)}`,
    );
  }

  const devIndices = system.devIndices || {};
  const militaryPoints = normalizeInteger(devIndices.militaryPoints, 0);
  const industrialPoints = normalizeInteger(devIndices.industrialPoints, 0);
  const claimedForDays = normalizeInteger(devIndices.claimedForDays, 0);
  lines.push(
    `indices military=${militaryPoints}(L${getOperationalIndexLevel(militaryPoints)}) industrial=${industrialPoints}(L${getOperationalIndexLevel(industrialPoints)}) claimedForDays=${claimedForDays}(strategic=${getStrategicIndexLevel(claimedForDays)})`,
  );
  lines.push(`claimTime=${formatFiletime(system.claimTime)}`);
  if (system.infrastructureHubID) {
    const {
      getHubFuel,
      getHubUpgrades,
    } = require(path.join(__dirname, "./sovModernState"));
    lines.push(
      describeHubUpgradeSnapshot(
        getHubUpgrades(system.infrastructureHubID),
      ),
    );
    lines.push(
      describeHubFuelSnapshot(
        getHubFuel(system.infrastructureHubID),
      ),
    );
  }

  if (structures.length === 0) {
    lines.push("structures=none");
    lines.push(...describeSovereigntyFlexStructures(solarSystemID));
    return lines.join("\n");
  }

  for (const structure of structures) {
    lines.push(
      [
        `structure=${formatStructureKind(structure)}`,
        `item=${structure.itemID}`,
        formatOwnerLabel("alliance", structure.allianceID),
        formatOwnerLabel("corporation", structure.corporationID),
        `defense=${Number(structure.defenseMultiplier || 0).toFixed(2)}`,
        `capital=${structure.isCapital === true ? "yes" : "no"}`,
        formatSpacePoint(structure.position)
          ? `pos=${formatSpacePoint(structure.position)}`
          : null,
        describeVulnerability(structure),
        describeCampaign(structure),
        isHubStructure(structure) ? describeHubEngineState(structure) : null,
      ].filter(Boolean).join(" | "),
    );
  }

  const ownedHub = findOwnedHub(system);
  if (ownedHub) {
    lines.push(...describeCampaignNodes(ownedHub.itemID));
  }

  lines.push(...describeSovereigntyFlexStructures(solarSystemID));

  return lines.join("\n");
}

module.exports = {
  DEFAULT_VULNERABILITY_DURATION_SECONDS,
  anchorSovereigntyHub,
  buildSovereigntyStatusReport,
  cancelAllianceCapitalTransition,
  captureSystemCampaignNode,
  captureSystemForOwner,
  clearHubVulnerabilityWindow,
  clearSystemSovereignty,
  ensureValidSolarSystem,
  fastForwardSovereigntyTimers,
  findOwnedHub,
  loseSystemSovereignty,
  reinforceSystemHub,
  resolveAllianceID,
  resolveCorporationID,
  resolveCurrentSolarSystemID,
  resolveSolarSystemID,
  setAllianceCapitalSystem,
  setAlliancePrimeHour,
  setHubVulnerabilityWindow,
  setSystemClaimAge,
  setSystemDevelopmentIndexValue,
};
