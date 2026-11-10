"use strict";

const { normalizeText } = require("../domain/abyssalValueUtils");

// Per-call evidence only: tracked runtime objects and required layout definitions differ.
function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function collectDestinationCandidates(ports, work) {
  const {
    listUniquePositiveInts,
    buildAbyssalSceneryVisualItemID,
    readEnvironmentalObjectStateFromItem,
  } = ports;
  const {
    pocketState,
    destinationRoomIndex,
    scene,
    deps,
    destinationRoomEntry,
    sceneryDescriptorsByRuntimeID,
    addRuntimeCandidates,
    sceneryProfileEntries,
    authoritativeScenery,
  } = work;
  addRuntimeCandidates(
    [destinationRoomEntry && destinationRoomEntry.originMarkerItemID],
    "roomEntry.originMarkerItemID",
    "marker",
  );
  addRuntimeCandidates(
    [destinationRoomEntry && destinationRoomEntry.conduitItemID],
    "roomEntry.conduitItemID",
    "conduit",
  );
  addRuntimeCandidates(
    destinationRoomEntry && destinationRoomEntry.hostileEntityIDs,
    "roomEntry.hostileEntityIDs",
    "npc",
  );
  addRuntimeCandidates(
    destinationRoomEntry && destinationRoomEntry.extractionNodeItemIDs,
    "roomEntry.extractionNodeItemIDs",
    "reward",
  );
  addRuntimeCandidates(
    destinationRoomEntry && destinationRoomEntry.extractionNodeLootContainerItemIDs,
    "roomEntry.extractionNodeLootContainerItemIDs",
    "reward",
  );
  for (const entityID of listUniquePositiveInts(
    destinationRoomEntry && destinationRoomEntry.sceneryVisualEntityIDs,
  )) {
    addRuntimeCandidates(
      [entityID],
      "roomEntry.sceneryVisualEntityIDs",
      "decoration",
      sceneryDescriptorsByRuntimeID.has(entityID),
    );
  }
  addRuntimeCandidates(
    [destinationRoomEntry && destinationRoomEntry.sceneryProbeEntityID],
    "roomEntry.sceneryProbeEntityID",
    "decoration",
  );
  for (const entityID of listUniquePositiveInts(
    destinationRoomEntry && destinationRoomEntry.environmentalObjectItemIDs,
  )) {
    const item = deps && typeof deps.findItemById === "function"
      ? deps.findItemById(entityID)
      : null;
    const environmentalState = readEnvironmentalObjectStateFromItem(item);
    addRuntimeCandidates(
      [entityID],
      "roomEntry.environmentalObjectItemIDs",
      normalizeText(environmentalState && environmentalState.profileID, "").includes("weather")
        ? "weather"
        : "decoration",
      Boolean(environmentalState && environmentalState.profileID),
    );
  }
  addRuntimeCandidates(
    [
      destinationRoomEntry && destinationRoomEntry.cacheItemID,
      destinationRoomEntry && destinationRoomEntry.cacheStructureItemID,
      destinationRoomEntry && destinationRoomEntry.cacheLootContainerItemID,
    ],
    "roomEntry.cacheItemID|cacheStructureItemID|cacheLootContainerItemID",
    "reward",
  );
  const definitionCandidates = sceneryProfileEntries.map((entry) => {
    const expectedRuntimeID = buildAbyssalSceneryVisualItemID(
      pocketState && pocketState.instanceID,
      destinationRoomIndex,
      entry && entry.slot,
      entry && entry.capturedRetailObject === true,
    );
    return {
      id: expectedRuntimeID,
      source: `sceneryProfile.entries[slot=${toInt(entry && entry.slot, 0)}]`,
      role: "layout-definition",
      runtimeEntityExpected: authoritativeScenery,
      runtimeEntityFound: Boolean(
        scene && typeof scene.getEntityByID === "function" && scene.getEntityByID(expectedRuntimeID)
      ),
      descriptorFound: true,
      typeID: toInt(entry && entry.candidateTypeID, 0),
    };
  });
  return definitionCandidates;
}

function buildAbyssalDestinationRequirements(ports, pocketState, destinationRoomIndex, scene, deps = ports.getDependencies()) {
  const {
    getPlaceholderRoomEntry,
    listUniquePositiveInts,
    getContentProfile,
    getAbyssalSceneryProfileForRoomIndex,
    listAbyssalSceneryProfileEntries,
    resolveAbyssalSceneryPolicy,
    SCENERY_POLICY_AUTHORITATIVE,
    buildAbyssalSceneryVisualItemID,
    listAbyssalRoomBootstrapEntityIDs,
    log,
    buildAbyssalSceneryAuthorityDiagnostics,
    warnIfAuthoritativeSceneryMissing,
  } = ports;
  const destinationRoomEntry = getPlaceholderRoomEntry(pocketState, destinationRoomIndex);
  const runtimeCandidatesByID = new Map();
  const addRuntimeCandidates = (values, source, role, descriptorFound = false) => {
    for (const entityID of listUniquePositiveInts(values)) {
      const existing = runtimeCandidatesByID.get(entityID);
      if (existing) {
        existing.source = `${existing.source}|${source}`;
        existing.descriptorFound = existing.descriptorFound || descriptorFound;
        continue;
      }
      runtimeCandidatesByID.set(entityID, {
        id: entityID,
        source,
        role,
        runtimeEntityExpected: true,
        runtimeEntityFound: Boolean(
          scene && typeof scene.getEntityByID === "function" && scene.getEntityByID(entityID)
        ),
        descriptorFound,
      });
    }
  };
  const contentProfile = getContentProfile(pocketState) || {};
  const sceneryProfile = getAbyssalSceneryProfileForRoomIndex(
    pocketState,
    destinationRoomIndex,
  );
  const sceneryProfileEntries = listAbyssalSceneryProfileEntries(sceneryProfile);
  const sceneryPolicy = resolveAbyssalSceneryPolicy(sceneryProfile);
  const authoritativeScenery = sceneryPolicy === SCENERY_POLICY_AUTHORITATIVE;
  const sceneryDescriptorsByRuntimeID = new Map(
    sceneryProfileEntries.map((entry) => [
      buildAbyssalSceneryVisualItemID(
        pocketState && pocketState.instanceID,
        destinationRoomIndex,
        entry && entry.slot,
        entry && entry.capturedRetailObject === true,
      ),
      entry,
    ]),
  );
  const definitionCandidates = collectDestinationCandidates(ports, {
    pocketState,
    destinationRoomIndex,
    scene,
    deps,
    destinationRoomEntry,
    sceneryDescriptorsByRuntimeID,
    addRuntimeCandidates,
    sceneryProfileEntries,
    authoritativeScenery,
  });
  const runtimeCandidates = [...runtimeCandidatesByID.values()];
  const trackedRuntimeEntityIDSet = new Set(runtimeCandidates.map((candidate) => candidate.id));
  const runtimeEntityIDs = listUniquePositiveInts([
    ...runtimeCandidates.map((candidate) => candidate.id),
    ...definitionCandidates
      .filter((candidate) => candidate.runtimeEntityExpected === true)
      .map((candidate) => candidate.id),
  ]);
  const runtimeEntityIDSet = new Set(runtimeEntityIDs);
  const missingCriticalRuntimeIDs = listUniquePositiveInts([
    ...runtimeCandidates
      .filter((candidate) => candidate.runtimeEntityFound !== true)
      .map((candidate) => candidate.id),
    ...definitionCandidates
      .filter((candidate) =>
        candidate.runtimeEntityExpected === true && candidate.runtimeEntityFound !== true
      )
      .map((candidate) => candidate.id),
  ]);
  const definitionOnlyIDs = definitionCandidates
    .filter((candidate) => !trackedRuntimeEntityIDSet.has(candidate.id))
    .map((candidate) => candidate.id);
  const unexpectedRequiredIDs = listAbyssalRoomBootstrapEntityIDs(
    pocketState,
    destinationRoomIndex,
  ).filter((entityID) => !runtimeEntityIDSet.has(entityID));
  const allCandidates = [...runtimeCandidates, ...definitionCandidates];
  const failedCandidates = allCandidates.filter((candidate) =>
    candidate.runtimeEntityExpected === true && candidate.runtimeEntityFound !== true
  );
  for (const candidate of failedCandidates) {
    log.warn(
      `[AbyssalDestinationRequirement] run=${toInt(pocketState && pocketState.instanceID, 0)} ` +
        `room=${toInt(destinationRoomIndex, 0)} id=${candidate.id} ` +
        `source=${candidate.source} role=${candidate.role} ` +
        `runtimeEntityExpected=${candidate.runtimeEntityExpected} ` +
        `runtimeEntityFound=${candidate.runtimeEntityFound} ` +
        `descriptorFound=${candidate.descriptorFound}`,
    );
  }
  log.info(
    `[AbyssalDestinationRequirements] run=${toInt(pocketState && pocketState.instanceID, 0)} ` +
      `room=${toInt(destinationRoomIndex, 0)} candidates=${allCandidates.length} ` +
      `runtime=${runtimeCandidates.length} definitions=${definitionCandidates.length} ` +
      `missing=${failedCandidates.length}`,
  );
  const sceneryDiagnostics = buildAbyssalSceneryAuthorityDiagnostics(
    pocketState,
    destinationRoomIndex,
    deps,
  );
  warnIfAuthoritativeSceneryMissing(
    pocketState,
    destinationRoomIndex,
    sceneryDiagnostics,
  );
  return {
    runtimeCandidates,
    definitionCandidates,
    runtimeEntityIDs,
    missingCriticalRuntimeIDs,
    definitionOnlyIDs,
    unexpectedRequiredIDs,
    sceneryProfile,
    sceneryProfileEntries,
    sceneryPolicy,
    sceneryDiagnostics,
  };
}

function createAbyssalDestinationRequirements(ports) {
  return { buildAbyssalDestinationRequirements: buildAbyssalDestinationRequirements.bind(null, ports) };
}

module.exports = { createAbyssalDestinationRequirements };
