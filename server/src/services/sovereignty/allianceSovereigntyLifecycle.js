"use strict";

const {
  cloneValue,
} = require("../../common/clone");

const path = require("node:path");

const database = require(path.join(__dirname, "../../gameStore"));
const {
  currentFileTime,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const {
  SOVEREIGNTY_TABLE,
  TYPE_INFRASTRUCTURE_HUB,
} = require(path.join(__dirname, "./sovConstants"));
const {
  getSystemState,
  publishSystemStateEffects,
} = require(path.join(__dirname, "./sovState"));
const {
  invalidateSovereigntyModernStateCache,
} = require(path.join(__dirname, "./sovModernState"));
const {
  syncSovereigntyStructureRuntime,
} = require(path.join(__dirname, "./sovSpaceInterop"));
const {
  readSovereigntyTable,
} = require(path.join(__dirname, "./sovStore"));
const {
  STRUCTURES_TABLE,
} = require(path.join(__dirname, "../structure/structureState"));

const PLAN_SCHEMA_VERSION = 1;
const TYPE_SOVEREIGNTY_COMMAND_NODE = 34832;
const CORE_TYPE_IDS = new Set([
  TYPE_INFRASTRUCTURE_HUB,
]);

function normalizePositiveInteger(value, fallback = null) {
  const numeric = Math.trunc(Number(value) || 0);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function normalizeNullableCorporationID(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  return normalizePositiveInteger(value, null);
}

function normalizeOperationID(value) {
  const operationID = String(value || "").trim();
  return operationID || null;
}

function normalizeCoreTypeID(value) {
  const typeID = normalizePositiveInteger(value, null);
  return CORE_TYPE_IDS.has(typeID) ? typeID : null;
}

function getStructureID(structure) {
  return normalizePositiveInteger(
    structure && (structure.itemID || structure.structureID),
    null,
  );
}

function getEffectiveStructureAllianceID(structure, system) {
  return normalizePositiveInteger(
    structure && structure.allianceID,
    normalizePositiveInteger(system && system.allianceID, null),
  );
}

function getEffectiveStructureCorporationID(structure, system) {
  return normalizePositiveInteger(
    structure && structure.corporationID,
    normalizePositiveInteger(
      structure && structure.ownerID,
      normalizePositiveInteger(system && system.corporationID, null),
    ),
  );
}

function getExplicitOwnershipValues(record, keys) {
  return [...new Set(
    keys
      .map((key) => normalizePositiveInteger(record && record[key], null))
      .filter(Boolean),
  )];
}

function valuesAreWithin(values, allowed) {
  return values.every((value) => allowed.has(value));
}

function normalizeSystemStructures(system) {
  return Array.isArray(system && system.structures) ? system.structures : [];
}

function getStructureDevFlags(structure) {
  return structure && structure.devFlags && typeof structure.devFlags === "object"
    ? structure.devFlags
    : {};
}

function getCampaignSourceInfo(structure) {
  const devFlags = getStructureDevFlags(structure);
  if (
    Array.isArray(structure && structure.campaignSourceInfo) &&
    structure.campaignSourceInfo.length >= 4
  ) {
    return structure.campaignSourceInfo;
  }
  return Array.isArray(devFlags.campaignSourceInfo) &&
    devFlags.campaignSourceInfo.length >= 4
    ? devFlags.campaignSourceInfo
    : [];
}

function buildActiveHubCampaignDescriptor(structure, system, allianceID) {
  if (
    normalizeCoreTypeID(structure && structure.typeID) !==
      TYPE_INFRASTRUCTURE_HUB ||
    getEffectiveStructureAllianceID(structure, system) !== allianceID
  ) {
    return null;
  }
  const structureID = getStructureID(structure);
  const devFlags = getStructureDevFlags(structure);
  const campaign =
    devFlags.sovereigntyCampaign &&
    typeof devFlags.sovereigntyCampaign === "object"
      ? devFlags.sovereigntyCampaign
      : null;
  if (!structureID || !campaign) {
    return null;
  }
  const campaignEpoch = String(campaign.campaignEpoch || "").trim();
  const targetID = normalizePositiveInteger(campaign.targetID, structureID);
  const sourceSolarSystemID = normalizePositiveInteger(
    campaign.sourceSolarSystemID,
    normalizePositiveInteger(system && system.solarSystemID, null),
  );
  const defenderAllianceID = normalizePositiveInteger(
    campaign.defenderAllianceID,
    getEffectiveStructureAllianceID(structure, system),
  );
  const status = String(campaign.status || campaign.phase || "")
    .trim()
    .toLowerCase();
  const nodeIDs = new Set(
    (Array.isArray(campaign.nodeIDs) ? campaign.nodeIDs : [])
      .map((entry) => normalizePositiveInteger(entry, null))
      .filter(Boolean),
  );
  const hasLiveCampaignProjection =
    status === "active" ||
    status === "campaign" ||
    status === "terminal-pending" ||
    normalizePositiveInteger(structure.campaignEventType, null) === 2 ||
    nodeIDs.size > 0;
  if (
    !campaignEpoch ||
    !sourceSolarSystemID ||
    targetID !== structureID ||
    defenderAllianceID !== allianceID ||
    !hasLiveCampaignProjection
  ) {
    return null;
  }
  return {
    targetID,
    sourceSolarSystemID,
    defenderAllianceID,
    campaignEpoch,
    nodeIDs,
  };
}

function collectActiveHubCampaignDescriptors(table, plan, allianceID) {
  const descriptors = [];
  const seen = new Set();
  for (const systemPlan of Array.isArray(plan && plan.systems)
    ? plan.systems
    : []) {
    const solarSystemID = normalizePositiveInteger(
      systemPlan && systemPlan.solarSystemID,
      null,
    );
    const system =
      solarSystemID && table.systems && table.systems[String(solarSystemID)];
    if (!system) {
      continue;
    }
    const plannedHubIDs = new Set([
      normalizePositiveInteger(systemPlan.expectedInfrastructureHubID, null),
      ...(Array.isArray(systemPlan.coreStructures)
        ? systemPlan.coreStructures
        : [])
        .filter(
          (structure) =>
            normalizeCoreTypeID(structure && structure.typeID) ===
            TYPE_INFRASTRUCTURE_HUB,
        )
        .map((structure) =>
          normalizePositiveInteger(structure && structure.itemID, null),
        ),
    ].filter(Boolean));
    for (const structure of normalizeSystemStructures(system)) {
      if (!plannedHubIDs.has(getStructureID(structure))) {
        continue;
      }
      const descriptor = buildActiveHubCampaignDescriptor(
        structure,
        system,
        allianceID,
      );
      if (!descriptor) {
        continue;
      }
      const key = `${descriptor.targetID}:${descriptor.campaignEpoch}`;
      if (!seen.has(key)) {
        seen.add(key);
        descriptors.push(descriptor);
      }
    }
  }
  return descriptors;
}

function commandNodeMatchesCampaign(structure, descriptor) {
  const nodeID = getStructureID(structure);
  if (
    !nodeID ||
    normalizePositiveInteger(structure && structure.typeID, null) !==
      TYPE_SOVEREIGNTY_COMMAND_NODE
  ) {
    return false;
  }
  const devFlags = getStructureDevFlags(structure);
  const sourceInfo = getCampaignSourceInfo(structure);
  const sourceSolarSystemID = normalizePositiveInteger(sourceInfo[0], null);
  const targetID = normalizePositiveInteger(
    devFlags.campaignTargetID,
    normalizePositiveInteger(sourceInfo[2], null),
  );
  const defenderAllianceID = normalizePositiveInteger(
    sourceInfo[3],
    normalizePositiveInteger(structure && structure.allianceID, null),
  );
  const campaignEpoch = String(
    devFlags.campaignEpoch || devFlags.sovereigntyCampaignEpoch || "",
  ).trim();
  if (
    (sourceSolarSystemID &&
      sourceSolarSystemID !== descriptor.sourceSolarSystemID) ||
    (targetID && targetID !== descriptor.targetID) ||
    (defenderAllianceID &&
      defenderAllianceID !== descriptor.defenderAllianceID) ||
    (campaignEpoch && campaignEpoch !== descriptor.campaignEpoch)
  ) {
    return false;
  }
  const sourceTupleMatches =
    sourceSolarSystemID === descriptor.sourceSolarSystemID &&
    targetID === descriptor.targetID &&
    defenderAllianceID === descriptor.defenderAllianceID;
  const campaignFlagsMatch =
    targetID === descriptor.targetID &&
    campaignEpoch === descriptor.campaignEpoch &&
    defenderAllianceID === descriptor.defenderAllianceID;
  return (
    sourceTupleMatches ||
    campaignFlagsMatch ||
    descriptor.nodeIDs.has(nodeID)
  );
}

function removeAllianceCampaignNodes(table, descriptors, effects) {
  const removedNodeIDs = [];
  const affectedSystemIDs = [];
  if (descriptors.length === 0) {
    return { removedNodeIDs, affectedSystemIDs };
  }
  for (const [systemKey, system] of Object.entries(table.systems || {})) {
    const solarSystemID = normalizePositiveInteger(
      system && system.solarSystemID,
      normalizePositiveInteger(systemKey, null),
    );
    if (!solarSystemID || !system) {
      continue;
    }
    const previousSystem = cloneValue(system);
    const nextStructures = normalizeSystemStructures(system).filter(
      (structure) => {
        if (
          !descriptors.some((descriptor) =>
            commandNodeMatchesCampaign(structure, descriptor),
          )
        ) {
          return true;
        }
        const nodeID = getStructureID(structure);
        if (nodeID) {
          removedNodeIDs.push(nodeID);
        }
        return false;
      },
    );
    if (nextStructures.length === normalizeSystemStructures(system).length) {
      continue;
    }
    system.structures = nextStructures;
    affectedSystemIDs.push(solarSystemID);
    const existingEffect = effects.find(
      (effect) => Number(effect.solarSystemID) === solarSystemID,
    );
    if (existingEffect) {
      existingEffect.nextSystem = cloneValue(system);
      existingEffect.changed = true;
    } else {
      effects.push({
        solarSystemID,
        previousSystem,
        nextSystem: cloneValue(system),
        changed: true,
      });
    }
  }
  return { removedNodeIDs, affectedSystemIDs };
}

function buildCoreStructurePlan(structure, system) {
  const itemID = getStructureID(structure);
  const typeID = normalizeCoreTypeID(structure && structure.typeID);
  if (!itemID || !typeID) {
    return null;
  }
  return {
    itemID,
    typeID,
    expectedAllianceID: getEffectiveStructureAllianceID(structure, system),
    expectedCorporationID: getEffectiveStructureCorporationID(
      structure,
      system,
    ),
    expectedOwnerID: normalizePositiveInteger(
      structure && structure.ownerID,
      getEffectiveStructureCorporationID(structure, system),
    ),
  };
}

function buildHubOwnershipPlan(table, coreStructures, system) {
  return coreStructures
    .filter((structure) => structure.typeID === TYPE_INFRASTRUCTURE_HUB)
    .map((structure) => {
      const hub = table.hubs && table.hubs[String(structure.itemID)];
      if (!hub || typeof hub !== "object") {
        return {
          hubID: structure.itemID,
          expectedAllianceID: structure.expectedAllianceID,
          expectedCorporationID: structure.expectedCorporationID,
          existed: false,
        };
      }
      return {
        hubID: structure.itemID,
        expectedAllianceID: normalizePositiveInteger(
          hub.allianceID,
          getEffectiveStructureAllianceID(null, system),
        ),
        expectedCorporationID: normalizePositiveInteger(
          hub.corporationID,
          normalizePositiveInteger(
            hub.ownerID,
            structure.expectedCorporationID,
          ),
        ),
        existed: true,
      };
    });
}

function buildAllianceSovereigntyDeparturePlan(options = {}) {
  const allianceID = normalizePositiveInteger(options.allianceID, null);
  if (!allianceID) {
    throw new TypeError("allianceID must be a positive integer");
  }
  const corporationID = normalizeNullableCorporationID(options.corporationID);
  if (
    options.corporationID !== undefined &&
    options.corporationID !== null &&
    !corporationID
  ) {
    throw new TypeError("corporationID must be null or a positive integer");
  }

  const table = readSovereigntyTable();
  const systems = [];
  for (const [systemKey, sourceSystem] of Object.entries(table.systems || {})) {
    const solarSystemID = normalizePositiveInteger(
      sourceSystem && sourceSystem.solarSystemID,
      normalizePositiveInteger(systemKey, null),
    );
    const systemAllianceID = normalizePositiveInteger(
      sourceSystem && sourceSystem.allianceID,
      null,
    );
    if (!solarSystemID || systemAllianceID !== allianceID) {
      continue;
    }
    const expectedSystemCorporationID = normalizePositiveInteger(
      sourceSystem && sourceSystem.corporationID,
      null,
    );
    const allCoreStructures = normalizeSystemStructures(sourceSystem)
      .map((structure) => buildCoreStructurePlan(structure, sourceSystem))
      .filter((structure) =>
        Boolean(structure && structure.expectedAllianceID === allianceID),
      );
    const coreStructures = corporationID
      ? allCoreStructures.filter(
          (structure) => structure.expectedCorporationID === corporationID,
        )
      : allCoreStructures;
    const expectedClaimStructureID = normalizePositiveInteger(
      sourceSystem && sourceSystem.claimStructureID,
      null,
    );
    const expectedInfrastructureHubID = normalizePositiveInteger(
      sourceSystem && sourceSystem.infrastructureHubID,
      null,
    );
    const systemOwnershipSelected =
      corporationID === null || expectedSystemCorporationID === corporationID;
    const hasCoreClaimReference = Boolean(
      expectedClaimStructureID || expectedInfrastructureHubID,
    );
    if (
      corporationID !== null &&
      coreStructures.length === 0 &&
      !(systemOwnershipSelected && hasCoreClaimReference)
    ) {
      continue;
    }

    systems.push({
      solarSystemID,
      expectedAllianceID: allianceID,
      expectedSystemCorporationID,
      expectedClaimStructureID,
      expectedInfrastructureHubID,
      systemOwnershipSelected,
      coreStructures,
      hubs: buildHubOwnershipPlan(table, coreStructures, sourceSystem),
    });
  }

  systems.sort((left, right) => left.solarSystemID - right.solarSystemID);
  return {
    schemaVersion: PLAN_SCHEMA_VERSION,
    mode: corporationID === null ? "alliance-closure" : "corporation-departure",
    allianceID,
    corporationID,
    builtAtMs: Math.max(0, Math.trunc(Number(options.nowMs) || Date.now())),
    systems,
  };
}

function validatePlan(plan, allianceID, corporationID, requireClosurePlan) {
  if (!plan || typeof plan !== "object") {
    return "SOVEREIGNTY_PLAN_REQUIRED";
  }
  if (Number(plan.schemaVersion) !== PLAN_SCHEMA_VERSION) {
    return "SOVEREIGNTY_PLAN_VERSION_UNSUPPORTED";
  }
  if (normalizePositiveInteger(plan.allianceID, null) !== allianceID) {
    return "SOVEREIGNTY_PLAN_ALLIANCE_MISMATCH";
  }
  const plannedCorporationID = normalizeNullableCorporationID(
    plan.corporationID,
  );
  if (requireClosurePlan && plannedCorporationID !== null) {
    return "SOVEREIGNTY_CLOSURE_PLAN_REQUIRED";
  }
  if (!requireClosurePlan && plannedCorporationID !== corporationID) {
    return "SOVEREIGNTY_PLAN_CORPORATION_MISMATCH";
  }
  if (!Array.isArray(plan.systems)) {
    return "SOVEREIGNTY_PLAN_SYSTEMS_REQUIRED";
  }
  return null;
}

function claimReferencesMatch(system, systemPlan) {
  return (
    normalizePositiveInteger(system && system.claimStructureID, null) ===
      normalizePositiveInteger(systemPlan.expectedClaimStructureID, null) &&
    normalizePositiveInteger(system && system.infrastructureHubID, null) ===
      normalizePositiveInteger(systemPlan.expectedInfrastructureHubID, null)
  );
}

function updateCurrentDataCorporation(system, fromCorporationID, toCorporationID) {
  if (!Array.isArray(system && system.currentData)) {
    return false;
  }
  let changed = false;
  system.currentData = system.currentData.map((row) => {
    if (
      normalizePositiveInteger(row && row.corporationID, null) !==
      fromCorporationID
    ) {
      return row;
    }
    changed = true;
    return { ...row, corporationID: toCorporationID };
  });
  return changed;
}

function nextTableRevision(previousRevision) {
  const previousMs = Date.parse(String(previousRevision || ""));
  const nextMs = Math.max(
    Date.now(),
    Number.isFinite(previousMs) ? previousMs + 1 : 0,
  );
  return new Date(nextMs).toISOString();
}

function writeSovereigntySnapshot(table) {
  table._meta = table._meta && typeof table._meta === "object"
    ? table._meta
    : { version: 2 };
  table._meta.updatedAt = nextTableRevision(table._meta.updatedAt);
  const writeResult = database.write(SOVEREIGNTY_TABLE, "/", table);
  if (!writeResult || writeResult.success !== true) {
    return writeResult || {
      success: false,
      errorMsg: "SOVEREIGNTY_WRITE_FAILED",
    };
  }
  invalidateSovereigntyModernStateCache();
  return { success: true };
}

function flushLifecycleTables() {
  const flushResult = database.flushTablesSync([
    SOVEREIGNTY_TABLE,
    STRUCTURES_TABLE,
  ]);
  if (!flushResult || flushResult.success !== true) {
    return {
      success: false,
      errorMsg: "SOVEREIGNTY_LIFECYCLE_FLUSH_FAILED",
      data: flushResult || null,
    };
  }
  return { success: true, data: flushResult };
}

function reconcileSystemEffects(effects, options = {}) {
  const failures = [];
  for (const effect of effects) {
    const nextSystem = effect.nextSystem || {
      solarSystemID: effect.solarSystemID,
      structures: [],
    };
    const syncResult = syncSovereigntyStructureRuntime(nextSystem, {
      broadcast: options.suppressNotifications !== true,
      syncScene: options.syncScene !== false,
      excludedSession: options.excludedSession || null,
      nowMs: options.nowMs,
    });
    if (!syncResult || syncResult.success !== true) {
      failures.push({
        solarSystemID: effect.solarSystemID,
        stage: "structure-mirror",
        errorMsg:
          (syncResult && syncResult.errorMsg) || "STRUCTURE_MIRROR_SYNC_FAILED",
      });
      continue;
    }
    if (effect.changed && options.suppressNotifications !== true) {
      const publishResult = publishSystemStateEffects(
        effect.previousSystem,
        nextSystem,
        {
          suppressStructureSync: true,
          suppressNotifications: false,
        },
      );
      if (!publishResult || publishResult.success !== true) {
        failures.push({
          solarSystemID: effect.solarSystemID,
          stage: "notifications",
          errorMsg:
            (publishResult && publishResult.errorMsg) ||
            "SOVEREIGNTY_NOTIFICATION_FAILED",
        });
      }
    }
  }
  return failures;
}

function enforceTransferredHubProjection(
  effects,
  allianceID,
  fromCorporationID,
  toCorporationID,
) {
  const affectedSystemIDs = new Set(
    effects.map((effect) => effect.solarSystemID),
  );
  const table = readSovereigntyTable();
  let changed = false;
  for (const system of Object.values(table.systems || {})) {
    const solarSystemID = normalizePositiveInteger(
      system && system.solarSystemID,
      null,
    );
    if (
      !affectedSystemIDs.has(solarSystemID) ||
      normalizePositiveInteger(system && system.allianceID, null) !== allianceID
    ) {
      continue;
    }
    for (const structure of normalizeSystemStructures(system)) {
      if (
        normalizeCoreTypeID(structure && structure.typeID) !==
          TYPE_INFRASTRUCTURE_HUB ||
        getEffectiveStructureAllianceID(structure, system) !== allianceID ||
        getEffectiveStructureCorporationID(structure, system) !==
          toCorporationID
      ) {
        continue;
      }
      const hubID = getStructureID(structure);
      const hub = hubID && table.hubs && table.hubs[String(hubID)];
      if (!hub) {
        continue;
      }
      const hubAllianceID = normalizePositiveInteger(
        hub.allianceID,
        allianceID,
      );
      const hubCorporationID = normalizePositiveInteger(
        hub.corporationID,
        normalizePositiveInteger(hub.ownerID, fromCorporationID),
      );
      if (
        hubAllianceID !== allianceID ||
        ![fromCorporationID, toCorporationID].includes(hubCorporationID)
      ) {
        continue;
      }
      if (hubCorporationID !== toCorporationID) {
        hub.corporationID = toCorporationID;
        changed = true;
      }
      if (
        Object.prototype.hasOwnProperty.call(hub, "ownerID") &&
        normalizePositiveInteger(hub.ownerID, null) !== toCorporationID
      ) {
        hub.ownerID = toCorporationID;
        changed = true;
      }
    }
  }
  if (changed) {
    return writeSovereigntySnapshot(table);
  }
  invalidateSovereigntyModernStateCache();
  return { success: true };
}

function enforceDroppedHubProjection(effects, allianceID, plan) {
  const affectedSystemIDs = new Set(
    effects.map((effect) => effect.solarSystemID),
  );
  const table = readSovereigntyTable();
  let changed = false;
  for (const systemPlan of Array.isArray(plan && plan.systems)
    ? plan.systems
    : []) {
    const solarSystemID = normalizePositiveInteger(
      systemPlan && systemPlan.solarSystemID,
      null,
    );
    if (!affectedSystemIDs.has(solarSystemID)) {
      continue;
    }
    const hubIDs = new Set([
      normalizePositiveInteger(systemPlan.expectedInfrastructureHubID, null),
      ...(Array.isArray(systemPlan.hubs) ? systemPlan.hubs : []).map((hub) =>
        normalizePositiveInteger(hub && hub.hubID, null),
      ),
      ...(Array.isArray(systemPlan.coreStructures)
        ? systemPlan.coreStructures
        : [])
        .filter(
          (structure) =>
            normalizeCoreTypeID(structure && structure.typeID) ===
            TYPE_INFRASTRUCTURE_HUB,
        )
        .map((structure) =>
          normalizePositiveInteger(structure && structure.itemID, null),
        ),
    ].filter(Boolean));
    for (const hubID of hubIDs) {
      const hub = table.hubs && table.hubs[String(hubID)];
      if (
        !hub ||
        normalizePositiveInteger(hub.allianceID, allianceID) !== allianceID
      ) {
        continue;
      }
      delete table.hubs[String(hubID)];
      changed = true;
    }
  }
  if (changed) {
    return writeSovereigntySnapshot(table);
  }
  invalidateSovereigntyModernStateCache();
  return { success: true };
}

function refreshSovereigntyPublicCaches(effects) {
  for (const solarSystemID of sortedUnique(
    effects.map((effect) => effect.solarSystemID),
  )) {
    getSystemState(solarSystemID);
  }
}

function sortedUnique(values) {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left - right);
}

function buildFailure(errorMsg, data = null) {
  return {
    success: false,
    errorMsg,
    ...(data ? { data } : {}),
  };
}

function transferAllianceSovereigntyOwnership(options = {}) {
  const allianceID = normalizePositiveInteger(options.allianceID, null);
  const fromCorporationID = normalizePositiveInteger(
    options.fromCorporationID,
    null,
  );
  const toCorporationID = normalizePositiveInteger(
    options.toCorporationID,
    null,
  );
  if (!allianceID || !fromCorporationID || !toCorporationID) {
    return buildFailure("INVALID_SOVEREIGNTY_TRANSFER_OWNER");
  }
  if (fromCorporationID === toCorporationID) {
    return buildFailure("SOVEREIGNTY_TRANSFER_OWNER_UNCHANGED");
  }
  const planError = validatePlan(
    options.plan,
    allianceID,
    fromCorporationID,
    false,
  );
  if (planError) {
    return buildFailure(planError);
  }

  const table = readSovereigntyTable();
  const effects = [];
  const transferredSystemIDs = [];
  const alreadyTransferredSystemIDs = [];
  const staleSystemIDs = [];
  const transferredStructureIDs = [];
  const alreadyTransferredStructureIDs = [];
  const staleStructureIDs = [];
  const staleHubIDs = [];
  let tableChanged = false;

  for (const systemPlan of options.plan.systems) {
    const solarSystemID = normalizePositiveInteger(
      systemPlan && systemPlan.solarSystemID,
      null,
    );
    if (!solarSystemID) {
      continue;
    }
    const system = table.systems && table.systems[String(solarSystemID)];
    if (
      !system ||
      normalizePositiveInteger(system.allianceID, null) !== allianceID
    ) {
      staleSystemIDs.push(solarSystemID);
      continue;
    }
    const previousSystem = cloneValue(system);
    let systemChanged = false;
    let systemVerified = false;
    let systemHasStaleCore = false;
    const localTransferredStructureIDs = [];
    const localAlreadyTransferredStructureIDs = [];

    const plannedHubs = new Map(
      (Array.isArray(systemPlan.hubs) ? systemPlan.hubs : [])
        .map((hub) => [normalizePositiveInteger(hub && hub.hubID, null), hub])
        .filter(([hubID]) => Boolean(hubID)),
    );
    const previousHubs = new Map(
      [...plannedHubs.keys()].map((hubID) => [
        hubID,
        table.hubs && table.hubs[String(hubID)]
          ? cloneValue(table.hubs[String(hubID)])
          : null,
      ]),
    );
    for (const structurePlan of Array.isArray(systemPlan.coreStructures)
      ? systemPlan.coreStructures
      : []) {
      const structureID = normalizePositiveInteger(
        structurePlan && structurePlan.itemID,
        null,
      );
      const typeID = normalizeCoreTypeID(structurePlan && structurePlan.typeID);
      if (!structureID || !typeID) {
        continue;
      }
      if (
        normalizePositiveInteger(structurePlan.expectedAllianceID, null) !==
          allianceID ||
        normalizePositiveInteger(structurePlan.expectedCorporationID, null) !==
          fromCorporationID
      ) {
        staleStructureIDs.push(structureID);
        systemHasStaleCore = true;
        continue;
      }
      const structure = normalizeSystemStructures(system).find(
        (entry) =>
          getStructureID(entry) === structureID &&
          normalizeCoreTypeID(entry && entry.typeID) === typeID,
      );
      if (!structure) {
        staleStructureIDs.push(structureID);
        systemHasStaleCore = true;
        continue;
      }
      if (getEffectiveStructureAllianceID(structure, system) !== allianceID) {
        staleStructureIDs.push(structureID);
        systemHasStaleCore = true;
        continue;
      }
      const allowedOwners = new Set([fromCorporationID, toCorporationID]);
      const structureOwners = getExplicitOwnershipValues(structure, [
        "corporationID",
        "ownerID",
      ]);
      if (
        structureOwners.length > 0 &&
        !valuesAreWithin(structureOwners, allowedOwners)
      ) {
        staleStructureIDs.push(structureID);
        systemHasStaleCore = true;
        continue;
      }

      const hub = typeID === TYPE_INFRASTRUCTURE_HUB
        ? table.hubs && table.hubs[String(structureID)]
        : null;
      if (hub) {
        const hubAllianceID = normalizePositiveInteger(
          hub.allianceID,
          allianceID,
        );
        const hubOwners = getExplicitOwnershipValues(hub, [
          "corporationID",
          "ownerID",
        ]);
        if (
          hubAllianceID !== allianceID ||
          (hubOwners.length > 0 && !valuesAreWithin(hubOwners, allowedOwners))
        ) {
          staleHubIDs.push(structureID);
          staleStructureIDs.push(structureID);
          systemHasStaleCore = true;
          continue;
        }
      }

      const effectiveOwner = getEffectiveStructureCorporationID(
        structure,
        system,
      );
      if (
        effectiveOwner === toCorporationID &&
        !structureOwners.includes(fromCorporationID)
      ) {
        localAlreadyTransferredStructureIDs.push(structureID);
        systemVerified = true;
      } else if (
        effectiveOwner === fromCorporationID ||
        structureOwners.includes(fromCorporationID)
      ) {
        structure.corporationID = toCorporationID;
        structure.ownerID = toCorporationID;
        localTransferredStructureIDs.push(structureID);
        systemChanged = true;
        systemVerified = true;
      } else {
        staleStructureIDs.push(structureID);
        systemHasStaleCore = true;
        continue;
      }

      if (hub) {
        const hubOwners = getExplicitOwnershipValues(hub, [
          "corporationID",
          "ownerID",
        ]);
        if (
          hubOwners.includes(fromCorporationID) ||
          normalizePositiveInteger(hub.corporationID, fromCorporationID) ===
            fromCorporationID
        ) {
          hub.corporationID = toCorporationID;
          if (Object.prototype.hasOwnProperty.call(hub, "ownerID")) {
            hub.ownerID = toCorporationID;
          }
        }
      } else if (
        typeID === TYPE_INFRASTRUCTURE_HUB &&
        plannedHubs.has(structureID)
      ) {
        // The hub projection is derived. Its absence is valid and will be
        // reconstructed from the transferred system without losing payload.
      }
    }

    const currentSystemCorporationID = normalizePositiveInteger(
      system.corporationID,
      null,
    );
    const systemOwnershipWasPlanned =
      systemPlan.systemOwnershipSelected === true &&
      normalizePositiveInteger(
        systemPlan.expectedSystemCorporationID,
        null,
      ) === fromCorporationID;
    let systemFenceFailed = systemHasStaleCore;
    if (systemOwnershipWasPlanned && !claimReferencesMatch(system, systemPlan)) {
      systemFenceFailed = true;
    }
    if (
      systemOwnershipWasPlanned &&
      currentSystemCorporationID !== fromCorporationID &&
      currentSystemCorporationID !== toCorporationID
    ) {
      systemFenceFailed = true;
    }
    if (systemFenceFailed) {
      table.systems[String(solarSystemID)] = previousSystem;
      for (const [hubID, previousHub] of previousHubs) {
        if (previousHub) {
          table.hubs[String(hubID)] = previousHub;
        } else {
          delete table.hubs[String(hubID)];
        }
      }
      staleSystemIDs.push(solarSystemID);
      continue;
    }
    if (systemOwnershipWasPlanned) {
      if (currentSystemCorporationID === fromCorporationID) {
        system.corporationID = toCorporationID;
        updateCurrentDataCorporation(
          system,
          fromCorporationID,
          toCorporationID,
        );
        systemChanged = true;
        systemVerified = true;
      } else if (currentSystemCorporationID === toCorporationID) {
        systemVerified = true;
      }
    }

    if (systemChanged) {
      tableChanged = true;
      transferredSystemIDs.push(solarSystemID);
    } else if (systemVerified) {
      alreadyTransferredSystemIDs.push(solarSystemID);
    }
    transferredStructureIDs.push(...localTransferredStructureIDs);
    alreadyTransferredStructureIDs.push(
      ...localAlreadyTransferredStructureIDs,
    );
    if (systemChanged || systemVerified) {
      effects.push({
        solarSystemID,
        previousSystem,
        nextSystem: cloneValue(system),
        changed: systemChanged,
      });
    }
  }

  if (tableChanged) {
    const writeResult = writeSovereigntySnapshot(table);
    if (!writeResult.success) {
      return buildFailure(
        writeResult.errorMsg || "SOVEREIGNTY_WRITE_FAILED",
      );
    }
  }
  const effectFailures = reconcileSystemEffects(effects, options);
  const hubProjectionResult = enforceTransferredHubProjection(
    effects,
    allianceID,
    fromCorporationID,
    toCorporationID,
  );
  if (!hubProjectionResult.success) {
    return buildFailure(
      hubProjectionResult.errorMsg || "SOVEREIGNTY_HUB_SYNC_FAILED",
    );
  }
  refreshSovereigntyPublicCaches(effects);
  const flushResult = flushLifecycleTables();
  if (!flushResult.success) {
    return flushResult;
  }
  const data = {
    operationID: normalizeOperationID(options.operationID),
    allianceID,
    fromCorporationID,
    toCorporationID,
    transferredSystemIDs: sortedUnique(transferredSystemIDs),
    alreadyTransferredSystemIDs: sortedUnique(alreadyTransferredSystemIDs),
    staleSystemIDs: sortedUnique(staleSystemIDs),
    transferredStructureIDs: sortedUnique(transferredStructureIDs),
    alreadyTransferredStructureIDs: sortedUnique(
      alreadyTransferredStructureIDs,
    ),
    staleStructureIDs: sortedUnique(staleStructureIDs),
    staleHubIDs: sortedUnique(staleHubIDs),
  };
  if (effectFailures.length > 0) {
    return buildFailure("SOVEREIGNTY_EFFECT_RECONCILIATION_FAILED", {
      ...data,
      effectFailures,
    });
  }
  return { success: true, data };
}

function coreStructureBelongsToAlliance(structure, system, allianceID) {
  return (
    Boolean(normalizeCoreTypeID(structure && structure.typeID)) &&
    getEffectiveStructureAllianceID(structure, system) === allianceID
  );
}

function clearDroppedCapitalSystems(table, allianceID, droppedSystemIDs) {
  const alliance = table.alliances && table.alliances[String(allianceID)];
  if (!alliance || !alliance.capitalInfo || droppedSystemIDs.size === 0) {
    return false;
  }
  let changed = false;
  const currentCapitalSystem = normalizePositiveInteger(
    alliance.capitalInfo.currentCapitalSystem,
    null,
  );
  const newCapitalSystem = normalizePositiveInteger(
    alliance.capitalInfo.newCapitalSystem,
    null,
  );
  if (currentCapitalSystem && droppedSystemIDs.has(currentCapitalSystem)) {
    alliance.capitalInfo.currentCapitalSystem = null;
    changed = true;
  }
  if (newCapitalSystem && droppedSystemIDs.has(newCapitalSystem)) {
    alliance.capitalInfo.newCapitalSystem = null;
    alliance.capitalInfo.newCapitalSystemValidAfter = "0";
    changed = true;
  }
  return changed;
}

function dropAllianceSovereigntyClaims(options = {}) {
  const allianceID = normalizePositiveInteger(options.allianceID, null);
  if (!allianceID) {
    return buildFailure("INVALID_SOVEREIGNTY_DROP_OWNER");
  }
  const planError = validatePlan(options.plan, allianceID, null, true);
  if (planError) {
    return buildFailure(planError);
  }

  const table = readSovereigntyTable();
  const activeCampaigns = collectActiveHubCampaignDescriptors(
    table,
    options.plan,
    allianceID,
  );
  const effects = [];
  const droppedSystemIDs = [];
  const alreadyDroppedSystemIDs = [];
  const staleSystemIDs = [];
  const removedStructureIDs = [];
  const removedHubIDs = [];
  const removedCommandNodeIDs = [];
  const commandNodeSystemIDs = [];
  let tableChanged = false;

  for (const systemPlan of options.plan.systems) {
    const solarSystemID = normalizePositiveInteger(
      systemPlan && systemPlan.solarSystemID,
      null,
    );
    if (!solarSystemID) {
      continue;
    }
    const system = table.systems && table.systems[String(solarSystemID)];
    if (!system) {
      alreadyDroppedSystemIDs.push(solarSystemID);
      effects.push({
        solarSystemID,
        previousSystem: null,
        nextSystem: { solarSystemID, structures: [] },
        changed: false,
      });
      continue;
    }
    const currentAllianceID = normalizePositiveInteger(system.allianceID, null);
    if (currentAllianceID && currentAllianceID !== allianceID) {
      staleSystemIDs.push(solarSystemID);
      continue;
    }
    const previousSystem = cloneValue(system);
    const plannedCoreIDs = new Set(
      (Array.isArray(systemPlan.coreStructures)
        ? systemPlan.coreStructures
        : [])
        .map((structure) =>
          normalizePositiveInteger(structure && structure.itemID, null),
        )
        .filter(Boolean),
    );
    const removedHubsForSystem = [];
    const nextStructures = normalizeSystemStructures(system).filter(
      (structure) => {
        const structureID = getStructureID(structure);
        const typeID = normalizeCoreTypeID(structure && structure.typeID);
        if (!structureID || !typeID) {
          return true;
        }
        const effectiveAllianceID = getEffectiveStructureAllianceID(
          structure,
          system,
        );
        const isRecoverablePlannedCore =
          currentAllianceID === null &&
          plannedCoreIDs.has(structureID) &&
          (effectiveAllianceID === null || effectiveAllianceID === allianceID);
        if (
          effectiveAllianceID !== allianceID &&
          !isRecoverablePlannedCore
        ) {
          return true;
        }
        removedStructureIDs.push(structureID);
        if (typeID === TYPE_INFRASTRUCTURE_HUB) {
          removedHubsForSystem.push(structureID);
        }
        return false;
      },
    );

    let systemChanged = nextStructures.length !== normalizeSystemStructures(system).length;
    system.structures = nextStructures;
    for (const hubID of new Set([
      ...removedHubsForSystem,
      normalizePositiveInteger(systemPlan.expectedInfrastructureHubID, null),
    ].filter(Boolean))) {
      const hub = table.hubs && table.hubs[String(hubID)];
      if (!hub) {
        continue;
      }
      const hubAllianceID = normalizePositiveInteger(
        hub.allianceID,
        currentAllianceID,
      );
      if (hubAllianceID !== allianceID) {
        continue;
      }
      delete table.hubs[String(hubID)];
      removedHubIDs.push(hubID);
      systemChanged = true;
    }

    if (currentAllianceID === allianceID) {
      system.allianceID = null;
      system.corporationID = null;
      system.claimStructureID = null;
      system.infrastructureHubID = null;
      system.claimTime = "0";
      system.fuelAccessGroupID = null;
      system.currentData = [];
      system.devIndices = {
        ...(system.devIndices && typeof system.devIndices === "object"
          ? system.devIndices
          : {}),
        claimedForDays: 0,
      };
      system.recentActivity = [
        {
          solarSystemID,
          ownerID: null,
          oldOwnerID: allianceID,
          stationID: null,
          changeTime: currentFileTime().toString(),
        },
        ...(Array.isArray(system.recentActivity) ? system.recentActivity : []),
      ];
      systemChanged = true;
    } else {
      const currentClaimStructureID = normalizePositiveInteger(
        system.claimStructureID,
        null,
      );
      const expectedClaimStructureID = normalizePositiveInteger(
        systemPlan.expectedClaimStructureID,
        null,
      );
      if (
        currentClaimStructureID &&
        currentClaimStructureID === expectedClaimStructureID
      ) {
        system.claimStructureID = null;
        systemChanged = true;
      }
      const currentInfrastructureHubID = normalizePositiveInteger(
        system.infrastructureHubID,
        null,
      );
      const expectedInfrastructureHubID = normalizePositiveInteger(
        systemPlan.expectedInfrastructureHubID,
        null,
      );
      if (
        currentInfrastructureHubID &&
        currentInfrastructureHubID === expectedInfrastructureHubID
      ) {
        system.infrastructureHubID = null;
        systemChanged = true;
      }
    }

    if (systemChanged) {
      tableChanged = true;
      droppedSystemIDs.push(solarSystemID);
    } else {
      alreadyDroppedSystemIDs.push(solarSystemID);
    }
    effects.push({
      solarSystemID,
      previousSystem,
      nextSystem: cloneValue(system),
      changed: systemChanged,
    });
  }

  const commandNodeCleanup = removeAllianceCampaignNodes(
    table,
    activeCampaigns,
    effects,
  );
  if (commandNodeCleanup.removedNodeIDs.length > 0) {
    removedCommandNodeIDs.push(...commandNodeCleanup.removedNodeIDs);
    removedStructureIDs.push(...commandNodeCleanup.removedNodeIDs);
    commandNodeSystemIDs.push(...commandNodeCleanup.affectedSystemIDs);
    tableChanged = true;
  }

  if (
    clearDroppedCapitalSystems(
      table,
      allianceID,
      new Set(droppedSystemIDs),
    )
  ) {
    tableChanged = true;
  }
  if (tableChanged) {
    const writeResult = writeSovereigntySnapshot(table);
    if (!writeResult.success) {
      return buildFailure(
        writeResult.errorMsg || "SOVEREIGNTY_WRITE_FAILED",
      );
    }
  }
  const effectFailures = reconcileSystemEffects(effects, options);
  const hubProjectionResult = enforceDroppedHubProjection(
    effects,
    allianceID,
    options.plan,
  );
  if (!hubProjectionResult.success) {
    return buildFailure(
      hubProjectionResult.errorMsg || "SOVEREIGNTY_HUB_SYNC_FAILED",
    );
  }
  refreshSovereigntyPublicCaches(effects);
  const flushResult = flushLifecycleTables();
  if (!flushResult.success) {
    return flushResult;
  }
  const data = {
    operationID: normalizeOperationID(options.operationID),
    allianceID,
    reason: String(options.reason || "alliance-closed"),
    droppedSystemIDs: sortedUnique(droppedSystemIDs),
    alreadyDroppedSystemIDs: sortedUnique(alreadyDroppedSystemIDs),
    staleSystemIDs: sortedUnique(staleSystemIDs),
    removedStructureIDs: sortedUnique(removedStructureIDs),
    removedHubIDs: sortedUnique(removedHubIDs),
    removedCommandNodeIDs: sortedUnique(removedCommandNodeIDs),
    commandNodeSystemIDs: sortedUnique(commandNodeSystemIDs),
  };
  if (effectFailures.length > 0) {
    return buildFailure("SOVEREIGNTY_EFFECT_RECONCILIATION_FAILED", {
      ...data,
      effectFailures,
    });
  }
  return { success: true, data };
}

module.exports = {
  PLAN_SCHEMA_VERSION,
  buildAllianceSovereigntyDeparturePlan,
  dropAllianceSovereigntyClaims,
  transferAllianceSovereigntyOwnership,
};
