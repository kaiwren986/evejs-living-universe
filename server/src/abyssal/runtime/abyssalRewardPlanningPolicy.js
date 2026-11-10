"use strict";

const crypto = require("node:crypto");

const {
  validateRewardQuantityPolicy,
} = require("../domain/abyssalRewardQuantityPolicy");

const ABYSSAL_REWARD_PLAN_SCHEMA_VERSION = 1;
const ABYSSAL_RUN_REWARD_ALLOCATION_SCHEMA_VERSION = 1;
const ABYSSAL_RUN_REWARD_ALLOCATION_MODEL =
  "deterministic_provisional_distribution_v1";
const ABYSSAL_RUN_REWARD_ALLOCATION_POLICY = "provisional_distribution";
const ABYSSAL_REWARD_MANIFEST_AUTHORITY = "observed_empirical";
const ABYSSAL_REWARD_ALLOCATION_AUTHORITY = "project_authored_allocation";

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function normalizeText(value, fallback = "") {
  const text = String(value == null ? "" : value).trim();
  return text || fallback;
}

function clonePlainValue(value, ancestors = new Set()) {
  if (value === null || value === undefined) {
    return value ?? null;
  }
  if (typeof value !== "object") {
    return value;
  }
  if (ancestors.has(value)) {
    throw new TypeError("Abyssal reward planning input must be acyclic plain data");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => clonePlainValue(entry, ancestors));
    }
    return Object.fromEntries(
      Object.keys(value).map((key) => [key, clonePlainValue(value[key], ancestors)]),
    );
  } finally {
    ancestors.delete(value);
  }
}

function mergeAbyssalRewardEntries(lootEntries = []) {
  const mergedByKey = new Map();
  for (const lootEntry of Array.isArray(lootEntries) ? lootEntries : []) {
    const itemName = normalizeText(lootEntry && lootEntry.itemName, "");
    const itemTypeID = toInt(lootEntry && lootEntry.itemTypeID, 0);
    const quantity = Math.max(0, toInt(lootEntry && lootEntry.quantity, 0));
    if (!itemName || quantity <= 0) {
      continue;
    }
    const entryKey = itemTypeID > 0
      ? `type:${itemTypeID}`
      : `name:${itemName.toLowerCase()}`;
    const existingEntry = mergedByKey.get(entryKey);
    if (existingEntry) {
      existingEntry.quantity += quantity;
      existingEntry.maxQuantity = existingEntry.quantity;
      continue;
    }
    mergedByKey.set(entryKey, {
      ...clonePlainValue(lootEntry),
      quantity,
      minQuantity: quantity,
      maxQuantity: quantity,
      probability: 1,
    });
  }
  return [...mergedByKey.values()];
}

function buildStableRewardAllocationSortKey(seed, kind, identity) {
  return crypto.createHash("sha256")
    .update(`${seed}:${kind}:${identity}`)
    .digest("hex");
}

function allocateObservedRunRewardManifest(manifest, artifacts, seed) {
  if (!Array.isArray(artifacts) || artifacts.length <= 0) {
    throw new TypeError("Observed run reward allocation has no eligible artifacts");
  }
  aggregateObservedRewardQuantities(
    manifest,
    "Observed whole-run manifest",
  );
  const logicalUnits = [];
  for (const [entryIndex, entry] of manifest.entries()) {
    for (let ordinal = 0; ordinal < entry.quantity; ordinal += 1) {
      logicalUnits.push({
        entryIndex,
        itemTypeID: entry.itemTypeID,
        ordinal,
        sortKey: buildStableRewardAllocationSortKey(
          seed,
          "logical-unit",
          `${entry.itemTypeID}:${ordinal}`,
        ),
      });
    }
  }
  logicalUnits.sort((left, right) =>
    left.sortKey.localeCompare(right.sortKey) ||
    left.itemTypeID - right.itemTypeID ||
    left.ordinal - right.ordinal
  );
  const orderedArtifacts = artifacts
    .map((artifact) => ({
      ...clonePlainValue(artifact),
      sortKey: buildStableRewardAllocationSortKey(
        seed,
        "artifact",
        artifact.artifactID,
      ),
      entriesByTypeID: new Map(),
    }))
    .sort((left, right) =>
      left.sortKey.localeCompare(right.sortKey) ||
      left.roomIndex - right.roomIndex
    );
  for (const [unitIndex, unit] of logicalUnits.entries()) {
    const target = orderedArtifacts[unitIndex % orderedArtifacts.length];
    const sourceEntry = manifest[unit.entryIndex];
    const existing = target.entriesByTypeID.get(sourceEntry.itemTypeID);
    if (existing) {
      existing.quantity += 1;
      existing.baseQuantity = existing.quantity;
      existing.minQuantity = existing.quantity;
      existing.maxQuantity = existing.quantity;
    } else {
      target.entriesByTypeID.set(sourceEntry.itemTypeID, {
        ...clonePlainValue(sourceEntry),
        allocationEntryID: `${target.artifactID}:type-${sourceEntry.itemTypeID}`,
        baseQuantity: 1,
        quantity: 1,
        minQuantity: 1,
        maxQuantity: 1,
      });
    }
  }
  return orderedArtifacts
    .map((artifact) => ({
      artifactID: artifact.artifactID,
      roomIndex: artifact.roomIndex,
      artifactRole: artifact.artifactRole,
      cacheProfileID: artifact.cacheProfileID,
      cacheTypeID: artifact.cacheTypeID,
      entries: [...artifact.entriesByTypeID.values()]
        .sort((left, right) => left.itemTypeID - right.itemTypeID),
    }))
    .sort((left, right) =>
      left.roomIndex - right.roomIndex ||
      left.artifactID.localeCompare(right.artifactID)
    );
}

function buildObservedRunRewardAllocationChecksumPayload(allocation) {
  const normalizeEntries = (entries) => (Array.isArray(entries) ? entries : [])
    .map((entry) => ({
      itemTypeID: toInt(entry && entry.itemTypeID, 0),
      itemName: normalizeText(entry && entry.itemName, ""),
      quantity: toInt(entry && entry.quantity, 0),
      sourceLootOutcomeID: normalizeText(entry && entry.sourceLootOutcomeID, ""),
    }))
    .sort((left, right) => left.itemTypeID - right.itemTypeID);
  return {
    schemaVersion: toInt(allocation && allocation.schemaVersion, 0),
    allocationID: normalizeText(allocation && allocation.allocationID, ""),
    instanceID: toInt(allocation && allocation.instanceID, 0),
    sourceRewardProfileID: normalizeText(
      allocation && allocation.sourceRewardProfileID,
      "",
    ),
    lootTableID: normalizeText(allocation && allocation.lootTableID, ""),
    empiricalOutcomeID: normalizeText(allocation && allocation.empiricalOutcomeID, ""),
    empiricalManifestAuthority: normalizeText(
      allocation && allocation.empiricalManifestAuthority,
      "",
    ),
    allocationAuthority: normalizeText(allocation && allocation.allocationAuthority, ""),
    allocationPolicy: normalizeText(allocation && allocation.allocationPolicy, ""),
    allocationModel: normalizeText(allocation && allocation.allocationModel, ""),
    rngSeed: normalizeText(allocation && allocation.rngSeed, ""),
    wholeRunManifest: normalizeEntries(allocation && allocation.wholeRunManifest),
    artifactAllocations: (Array.isArray(allocation && allocation.artifactAllocations)
      ? allocation.artifactAllocations
      : [])
      .map((artifact) => ({
        artifactID: normalizeText(artifact && artifact.artifactID, ""),
        roomIndex: toInt(artifact && artifact.roomIndex, 0),
        artifactRole: normalizeText(artifact && artifact.artifactRole, ""),
        cacheProfileID: normalizeText(artifact && artifact.cacheProfileID, ""),
        cacheTypeID: toInt(artifact && artifact.cacheTypeID, 0),
        entries: normalizeEntries(artifact && artifact.entries),
      }))
      .sort((left, right) =>
        left.roomIndex - right.roomIndex ||
        left.artifactID.localeCompare(right.artifactID)
      ),
  };
}

function calculateObservedRunRewardAllocationChecksum(allocation) {
  return crypto.createHash("sha256")
    .update(JSON.stringify(buildObservedRunRewardAllocationChecksumPayload(allocation)))
    .digest("hex");
}

function aggregateObservedRewardQuantities(entries, label) {
  const quantities = new Map();
  for (const [index, entry] of (Array.isArray(entries) ? entries : []).entries()) {
    const itemTypeID = toInt(entry && entry.itemTypeID, 0);
    const quantity = Number(entry && entry.quantity);
    if (itemTypeID <= 0) {
      throw new TypeError(`${label} entry ${index} has an invalid item type ID`);
    }
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      throw new TypeError(`${label} entry ${index} has an invalid quantity`);
    }
    const nextQuantity = (quantities.get(itemTypeID) || 0) + quantity;
    if (!Number.isSafeInteger(nextQuantity)) {
      throw new TypeError(`${label} item ${itemTypeID} overflows its quantity`);
    }
    quantities.set(itemTypeID, nextQuantity);
  }
  return quantities;
}

function buildObservedRunRewardConservationLedger(allocation) {
  const planned = aggregateObservedRewardQuantities(
    allocation && allocation.wholeRunManifest,
    "Observed whole-run manifest",
  );
  const allocated = new Map();
  for (const artifact of (Array.isArray(allocation && allocation.artifactAllocations)
    ? allocation.artifactAllocations
    : [])) {
    const artifactID = normalizeText(artifact && artifact.artifactID, "<unknown>");
    const artifactQuantities = aggregateObservedRewardQuantities(
      artifact && artifact.entries,
      `Observed reward artifact ${artifactID}`,
    );
    for (const [itemTypeID, quantity] of artifactQuantities.entries()) {
      const nextQuantity = (allocated.get(itemTypeID) || 0) + quantity;
      if (!Number.isSafeInteger(nextQuantity)) {
        throw new TypeError(
          `Observed reward artifact allocations overflow type ${itemTypeID}`,
        );
      }
      allocated.set(itemTypeID, nextQuantity);
    }
  }
  const itemTypeIDs = [...new Set([...planned.keys(), ...allocated.keys()])]
    .sort((left, right) => left - right);
  const byItemType = itemTypeIDs.map((itemTypeID) => ({
    itemTypeID,
    plannedWholeRunQuantity: planned.get(itemTypeID) || 0,
    allocatedQuantity: allocated.get(itemTypeID) || 0,
  }));
  const plannedWholeRunQuantity = byItemType.reduce(
    (total, entry) => total + entry.plannedWholeRunQuantity,
    0,
  );
  const allocatedQuantity = byItemType.reduce(
    (total, entry) => total + entry.allocatedQuantity,
    0,
  );
  return {
    valid: byItemType.every(
      (entry) => entry.plannedWholeRunQuantity === entry.allocatedQuantity,
    ) && plannedWholeRunQuantity === allocatedQuantity,
    plannedWholeRunQuantity,
    allocatedQuantity,
    plannedItemTypeCount: planned.size,
    allocatedItemTypeCount: allocated.size,
    byItemType,
  };
}

function validateObservedRunRewardAllocation(allocation, expected = {}) {
  if (
    !allocation ||
    toInt(allocation.schemaVersion, 0) !==
      ABYSSAL_RUN_REWARD_ALLOCATION_SCHEMA_VERSION
  ) {
    throw new TypeError("Unsupported or missing observed run reward-allocation schema");
  }
  if (
    normalizeText(allocation.allocationPolicy, "") !==
      ABYSSAL_RUN_REWARD_ALLOCATION_POLICY ||
    normalizeText(allocation.allocationModel, "") !==
      ABYSSAL_RUN_REWARD_ALLOCATION_MODEL ||
    normalizeText(allocation.empiricalManifestAuthority, "") !==
      ABYSSAL_REWARD_MANIFEST_AUTHORITY ||
    normalizeText(allocation.allocationAuthority, "") !==
      ABYSSAL_REWARD_ALLOCATION_AUTHORITY
  ) {
    throw new TypeError("Observed run reward allocation has invalid authority metadata");
  }
  if (
    !normalizeText(allocation.allocationID, "") ||
    !normalizeText(allocation.empiricalOutcomeID, "") ||
    !normalizeText(allocation.rngSeed, "")
  ) {
    throw new TypeError("Observed run reward allocation is missing its stable identity");
  }
  if (
    !Array.isArray(allocation.wholeRunManifest) ||
    allocation.wholeRunManifest.length <= 0
  ) {
    throw new TypeError("Observed whole-run reward manifest is empty");
  }
  if (expected.instanceID != null) {
    const instanceID = toInt(expected.instanceID, 0);
    if (
      toInt(allocation.instanceID, 0) !== instanceID ||
      allocation.allocationID !== `abyssal-run-reward-allocation:${instanceID}`
    ) {
      throw new TypeError("Observed run reward allocation does not match its run");
    }
  }
  let selectedOutcomeEntries = Array.isArray(expected.selectedOutcomeEntries)
    ? expected.selectedOutcomeEntries
    : null;
  if (
    expected.sourceRewardProfileID != null ||
    expected.lootTableID != null
  ) {
    if (
      normalizeText(allocation.sourceRewardProfileID, "") !==
        normalizeText(expected.sourceRewardProfileID, "") ||
      normalizeText(allocation.lootTableID, "") !==
        normalizeText(expected.lootTableID, "")
    ) {
      throw new TypeError("Observed run reward allocation does not match its reward profile");
    }
    if (Array.isArray(expected.observedRunLootOutcomes)) {
      const selectedOutcome = expected.observedRunLootOutcomes.find((outcome) =>
        outcome &&
        outcome.productionEligible === true &&
        toInt(outcome.effectiveProductionWeight, 0) > 0 &&
        normalizeText(outcome.lootOutcomeID, "") ===
          normalizeText(allocation.empiricalOutcomeID, "")
      );
      if (!selectedOutcome) {
        throw new TypeError(
          "Observed run reward allocation references an ineligible outcome",
        );
      }
      selectedOutcomeEntries = selectedOutcome.entries;
    }
  }
  if (Array.isArray(selectedOutcomeEntries)) {
    const selectedOutcomeQuantities = aggregateObservedRewardQuantities(
      selectedOutcomeEntries,
      "Selected observed outcome",
    );
    const manifestQuantities = aggregateObservedRewardQuantities(
      allocation.wholeRunManifest,
      "Observed whole-run manifest",
    );
    if (
      selectedOutcomeQuantities.size !== manifestQuantities.size ||
      [...selectedOutcomeQuantities.entries()].some(
        ([itemTypeID, quantity]) => manifestQuantities.get(itemTypeID) !== quantity,
      )
    ) {
      throw new TypeError(
        "Observed whole-run manifest does not match its empirical outcome",
      );
    }
  }
  return validateObservedAllocationArtifacts(allocation, expected);
}

function validateObservedAllocationArtifacts(allocation, expected) {
  const wholeRunQuantities = aggregateObservedRewardQuantities(
    allocation.wholeRunManifest,
    "Observed whole-run manifest",
  );
  if (wholeRunQuantities.size <= 0) {
    throw new TypeError("Observed whole-run reward manifest is empty");
  }
  const artifactAllocations = Array.isArray(allocation.artifactAllocations)
    ? allocation.artifactAllocations
    : [];
  if (artifactAllocations.length <= 0) {
    throw new TypeError("Observed run reward allocation has no artifacts");
  }
  if (Array.isArray(expected.artifacts)) {
    const expectedArtifacts = expected.artifacts;
    if (
      expectedArtifacts.length !== artifactAllocations.length ||
      expectedArtifacts.some((expectedArtifact) => {
        const actualArtifact = artifactAllocations.find(
          (artifact) => artifact.artifactID === expectedArtifact.artifactID,
        );
        return !actualArtifact ||
          toInt(actualArtifact.roomIndex, 0) !== toInt(expectedArtifact.roomIndex, 0) ||
          normalizeText(actualArtifact.artifactRole, "") !==
            normalizeText(expectedArtifact.artifactRole, "");
      })
    ) {
      throw new TypeError(
        "Observed run reward allocation does not match its eligible artifacts",
      );
    }
  }
  const artifactIDs = new Set();
  const roomIndexes = new Set();
  for (const [index, artifact] of artifactAllocations.entries()) {
    const artifactID = normalizeText(artifact && artifact.artifactID, "");
    const roomIndex = toInt(artifact && artifact.roomIndex, 0);
    if (!artifactID || artifactIDs.has(artifactID)) {
      throw new TypeError(`Observed run reward artifact ${index} has an invalid identity`);
    }
    if (
      roomIndex < 1 ||
      roomIndexes.has(roomIndex) ||
      normalizeText(artifact && artifact.artifactRole, "") !== "main_cache" ||
      !normalizeText(artifact && artifact.cacheProfileID, "") ||
      toInt(artifact && artifact.cacheTypeID, 0) <= 0
    ) {
      throw new TypeError(`Observed run reward artifact ${artifactID} is invalid`);
    }
    artifactIDs.add(artifactID);
    roomIndexes.add(roomIndex);
  }
  const conservation = buildObservedRunRewardConservationLedger(allocation);
  if (
    conservation.plannedItemTypeCount !== conservation.allocatedItemTypeCount ||
    wholeRunQuantities.size !== conservation.byItemType.length
  ) {
    throw new TypeError("Observed run reward allocation has missing or unexpected item types");
  }
  for (const entry of conservation.byItemType) {
    if (entry.plannedWholeRunQuantity !== entry.allocatedQuantity) {
      throw new TypeError(
        `Observed run reward allocation quantity mismatch for type ${entry.itemTypeID}`,
      );
    }
  }
  if (conservation.allocatedQuantity !== conservation.plannedWholeRunQuantity) {
    throw new TypeError("Observed run reward allocation logical-unit mismatch");
  }
  if (
    conservation.plannedWholeRunQuantity >= artifactAllocations.length &&
    artifactAllocations.some((artifact) =>
      !Array.isArray(artifact.entries) || artifact.entries.length <= 0
    )
  ) {
    throw new TypeError("Observed run reward allocation left an eligible cache empty");
  }
  if (
    normalizeText(allocation.checksum, "") !==
      calculateObservedRunRewardAllocationChecksum(allocation)
  ) {
    throw new TypeError("Observed run reward-allocation checksum mismatch");
  }
  return allocation;
}

function buildObservedRunRewardAllocation({
  instanceID,
  sourceRewardProfileID,
  lootTableID,
  empiricalOutcomeID,
  wholeRunManifest,
  artifacts,
  rngSeed,
  createdAtMs,
} = {}) {
  const numericInstanceID = toInt(instanceID, 0);
  const manifest = clonePlainValue(wholeRunManifest);
  const artifactAllocations = allocateObservedRunRewardManifest(
    manifest,
    artifacts,
    `${rngSeed}:${empiricalOutcomeID}`,
  );
  const allocation = {
    schemaVersion: ABYSSAL_RUN_REWARD_ALLOCATION_SCHEMA_VERSION,
    allocationID: `abyssal-run-reward-allocation:${numericInstanceID}`,
    instanceID: numericInstanceID,
    sourceRewardProfileID: normalizeText(sourceRewardProfileID, ""),
    lootTableID: normalizeText(lootTableID, ""),
    empiricalOutcomeID: normalizeText(empiricalOutcomeID, ""),
    empiricalManifestAuthority: ABYSSAL_REWARD_MANIFEST_AUTHORITY,
    allocationAuthority: ABYSSAL_REWARD_ALLOCATION_AUTHORITY,
    allocationPolicy: ABYSSAL_RUN_REWARD_ALLOCATION_POLICY,
    allocationModel: ABYSSAL_RUN_REWARD_ALLOCATION_MODEL,
    rngSeed: normalizeText(rngSeed, ""),
    wholeRunManifest: manifest,
    artifactAllocations,
    createdAtMs: Math.max(0, toInt(createdAtMs, 0)),
  };
  allocation.checksum = calculateObservedRunRewardAllocationChecksum(allocation);
  return validateObservedRunRewardAllocation(allocation, {
    instanceID: numericInstanceID,
    sourceRewardProfileID,
    lootTableID,
    selectedOutcomeEntries: manifest,
    artifacts,
  });
}

function getObservedRunRewardArtifactAllocation(allocation, roomIndex) {
  return (Array.isArray(allocation && allocation.artifactAllocations)
    ? allocation.artifactAllocations
    : [])
    .find((artifact) =>
      toInt(artifact && artifact.roomIndex, 0) === toInt(roomIndex, 0) &&
      normalizeText(artifact && artifact.artifactRole, "") === "main_cache"
    ) || null;
}

function rewardEntryQuantitiesMatch(leftEntries, rightEntries) {
  const left = aggregateObservedRewardQuantities(leftEntries, "Reward-plan entries");
  const right = aggregateObservedRewardQuantities(
    rightEntries,
    "Reward-allocation entries",
  );
  if (left.size !== right.size) {
    return false;
  }
  for (const [itemTypeID, quantity] of left.entries()) {
    if (right.get(itemTypeID) !== quantity) {
      return false;
    }
  }
  return true;
}

function buildAbyssalRewardPlanChecksumPayload(plan) {
  return {
    schemaVersion: toInt(plan && plan.schemaVersion, 0),
    planID: normalizeText(plan && plan.planID, ""),
    sourceRewardProfileID: normalizeText(plan && plan.sourceRewardProfileID, ""),
    lootTableID: normalizeText(plan && plan.lootTableID, ""),
    quantityPolicy: normalizeText(plan && plan.quantityPolicy, ""),
    tier: toInt(plan && plan.tier, -1),
    weather: normalizeText(plan && plan.weather, ""),
    roomIndex: toInt(plan && plan.roomIndex, 0),
    rngSeed: normalizeText(plan && plan.rngSeed, ""),
    entries: Array.isArray(plan && plan.entries)
      ? plan.entries.map((entry) => ({
          grantID: normalizeText(entry && entry.grantID, ""),
          itemTypeID: toInt(entry && entry.itemTypeID, 0),
          itemName: normalizeText(entry && entry.itemName, ""),
          baseQuantity: toInt(
            entry && entry.baseQuantity,
            toInt(entry && entry.quantity, 0),
          ),
          quantity: toInt(entry && entry.quantity, 0),
        }))
      : [],
  };
}

function calculateAbyssalRewardPlanChecksum(plan) {
  return crypto.createHash("sha256")
    .update(JSON.stringify(buildAbyssalRewardPlanChecksumPayload(plan)))
    .digest("hex");
}

function validateAbyssalRewardPlan(plan) {
  if (!plan || toInt(plan.schemaVersion, 0) !== ABYSSAL_REWARD_PLAN_SCHEMA_VERSION) {
    throw new TypeError("Unsupported or missing Abyssal reward-plan schema");
  }
  validateRewardQuantityPolicy(plan.quantityPolicy);
  if (
    !normalizeText(plan.planID, "") ||
    !normalizeText(plan.sourceRewardProfileID, "") ||
    !normalizeText(plan.rngSeed, "")
  ) {
    throw new TypeError("Abyssal reward plan is missing its stable identity");
  }
  if (!Number.isInteger(plan.tier) || plan.tier < 0 || plan.tier > 6) {
    throw new TypeError("Abyssal reward plan has an invalid tier");
  }
  if (!Number.isInteger(plan.roomIndex) || plan.roomIndex < 1 || plan.roomIndex > 3) {
    throw new TypeError("Abyssal reward plan has an invalid room index");
  }
  const entries = Array.isArray(plan.entries) ? plan.entries : [];
  const grantIDs = new Set();
  for (const [index, entry] of entries.entries()) {
    const grantID = normalizeText(entry && entry.grantID, "");
    if (!grantID || grantIDs.has(grantID)) {
      throw new TypeError(`Abyssal reward plan entry ${index} has an invalid grant ID`);
    }
    grantIDs.add(grantID);
    if (!Number.isSafeInteger(entry.itemTypeID) || entry.itemTypeID <= 0) {
      throw new TypeError(`Abyssal reward plan entry ${index} has an invalid item type ID`);
    }
    if (!Number.isSafeInteger(entry.baseQuantity) || entry.baseQuantity < 0) {
      throw new TypeError(`Abyssal reward plan entry ${index} has an invalid base quantity`);
    }
    if (!Number.isSafeInteger(entry.quantity) || entry.quantity <= 0) {
      throw new TypeError(`Abyssal reward plan entry ${index} has an invalid final quantity`);
    }
  }
  const progress = plan.grantProgress;
  const progressEntries = progress && progress.entries;
  if (
    !progress ||
    typeof progress !== "object" ||
    !["pending", "partial", "completed"].includes(progress.status) ||
    !progressEntries ||
    typeof progressEntries !== "object" ||
    Array.isArray(progressEntries) ||
    !Array.isArray(progress.receiptKeys)
  ) {
    throw new TypeError("Abyssal reward plan has invalid grant progress");
  }
  let completedEntryCount = 0;
  for (const entry of entries) {
    const entryProgress = progressEntries[entry.grantID];
    if (!entryProgress || !["pending", "completed"].includes(entryProgress.status)) {
      throw new TypeError(`Abyssal reward plan grant progress is missing ${entry.grantID}`);
    }
    if (entryProgress.status === "completed") {
      completedEntryCount += 1;
      if (!normalizeText(entryProgress.receiptKey, "")) {
        throw new TypeError(`Abyssal reward plan completed grant ${entry.grantID} has no receipt`);
      }
    }
  }
  if (Object.keys(progressEntries).some((grantID) => !grantIDs.has(grantID))) {
    throw new TypeError("Abyssal reward plan grant progress contains an unknown grant ID");
  }
  if (
    (progress.status === "completed" && completedEntryCount !== entries.length) ||
    (progress.status === "pending" && completedEntryCount !== 0) ||
    (progress.status === "partial" && (
      completedEntryCount === 0 || completedEntryCount === entries.length
    ))
  ) {
    throw new TypeError("Abyssal reward plan grant progress status is inconsistent");
  }
  if (progress.receiptKeys.some((receiptKey) => !normalizeText(receiptKey, ""))) {
    throw new TypeError("Abyssal reward plan contains an invalid receipt key");
  }
  const expectedChecksum = calculateAbyssalRewardPlanChecksum(plan);
  if (normalizeText(plan.checksum, "") !== expectedChecksum) {
    throw new TypeError("Abyssal reward-plan checksum mismatch");
  }
  return plan;
}

function validateAbyssalRewardPlanContext(plan, expected = {}) {
  const validated = validateAbyssalRewardPlan(plan);
  for (const [field, expectedValue] of Object.entries(expected)) {
    const actualValue = field === "tier" || field === "roomIndex"
      ? toInt(validated[field], -1)
      : normalizeText(validated[field], "");
    if (actualValue !== expectedValue) {
      throw new TypeError(`Abyssal reward plan ${field} does not match its reward context`);
    }
  }
  return validated;
}

function buildAbyssalRewardPlan({
  instanceID,
  sourceRewardProfileID,
  lootTableID,
  quantityPolicy,
  tier,
  weather,
  roomIndex,
  rngSeed,
  entries: selectedEntries,
  createdAtMs,
} = {}) {
  validateRewardQuantityPolicy(quantityPolicy);
  const numericInstanceID = toInt(instanceID, 0);
  const numericRoomIndex = toInt(roomIndex, 0);
  const entries = (Array.isArray(selectedEntries) ? selectedEntries : [])
    .map((entry, index) => {
      const itemTypeID = toInt(entry && entry.itemTypeID, 0);
      const quantity = Number(entry && entry.quantity);
      if (itemTypeID <= 0) {
        throw new TypeError(
          `Abyssal reward plan entry ${index} has no authoritative type ID`,
        );
      }
      if (!Number.isSafeInteger(quantity) || quantity <= 0) {
        throw new TypeError(
          `Abyssal reward plan entry ${index} has an invalid final quantity`,
        );
      }
      return {
        ...clonePlainValue(entry),
        grantID: [
          "abyssal-reward-entry",
          numericInstanceID,
          numericRoomIndex,
          index,
          itemTypeID,
        ].join(":"),
        itemTypeID,
        itemName: normalizeText(entry && entry.itemName, ""),
        baseQuantity: toInt(entry && entry.baseQuantity, quantity),
        quantity,
        minQuantity: quantity,
        maxQuantity: quantity,
      };
    });
  const planID = [
    "abyssal-reward-plan",
    numericInstanceID,
    numericRoomIndex,
  ].join(":");
  const plan = {
    schemaVersion: ABYSSAL_REWARD_PLAN_SCHEMA_VERSION,
    planID,
    sourceRewardProfileID: normalizeText(sourceRewardProfileID, ""),
    lootTableID: normalizeText(lootTableID, ""),
    quantityPolicy,
    tier: Math.max(0, toInt(tier, 0)),
    weather: normalizeText(weather, ""),
    roomIndex: numericRoomIndex,
    rngSeed: normalizeText(rngSeed, ""),
    entries,
    grantProgress: {
      status: "pending",
      entries: Object.fromEntries(entries.map((entry) => [entry.grantID, {
        status: "pending",
        receiptKey: "",
      }])),
      receiptKeys: [],
    },
    createdAtMs: toInt(createdAtMs, 0),
  };
  plan.checksum = calculateAbyssalRewardPlanChecksum(plan);
  return validateAbyssalRewardPlan(plan);
}

module.exports = {
  ABYSSAL_REWARD_ALLOCATION_AUTHORITY,
  ABYSSAL_REWARD_MANIFEST_AUTHORITY,
  ABYSSAL_REWARD_PLAN_SCHEMA_VERSION,
  ABYSSAL_RUN_REWARD_ALLOCATION_MODEL,
  ABYSSAL_RUN_REWARD_ALLOCATION_POLICY,
  ABYSSAL_RUN_REWARD_ALLOCATION_SCHEMA_VERSION,
  allocateObservedRunRewardManifest,
  buildAbyssalRewardPlan,
  buildObservedRunRewardAllocation,
  buildObservedRunRewardConservationLedger,
  calculateAbyssalRewardPlanChecksum,
  calculateObservedRunRewardAllocationChecksum,
  getObservedRunRewardArtifactAllocation,
  mergeAbyssalRewardEntries,
  rewardEntryQuantitiesMatch,
  validateAbyssalRewardPlan,
  validateAbyssalRewardPlanContext,
  validateObservedRunRewardAllocation,
};
