"use strict";

const {
  toFiniteNumber,
} = require("../../common/numbers");

const path = require("path");

const log = require(path.join(__dirname, "../../utils/logger"));
const {
  ITEM_FLAGS,
  createSpaceItemForOwner,
  grantItemsToCharacterLocation,
  moveItemToLocation,
  removeInventoryItem,
  restoreInventoryItemChangesAtomic,
} = require(path.join(__dirname, "../../services/inventory/itemStore"));
const {
  findItemById,
  getProjectionVersion: getItemMutationVersion,
  listContainerItems,
} = require(path.join(
  __dirname,
  "../../services/inventory/simulationInventoryProjection",
));
const {
  getAttributeIDByNames,
  getEffectIDByNames,
  getTypeAttributeMap,
  buildShipResourceState,
} = require(path.join(__dirname, "../../services/fitting/liveFittingState"));
const {
  resolveItemByName,
  resolveItemByTypeID,
} = require(path.join(__dirname, "../../services/inventory/itemTypeRegistry"));
const {
  buildLiveModuleAttributeMap,
} = require(path.join(__dirname, "./liveModuleAttributes"));
const nativeNpcStore = require(path.join(__dirname, "../npc/nativeNpcStore"));
const {
  transferNativeWreckLootToContainer,
} = require(path.join(__dirname, "../../services/inventory/salvageItemCustody"));
const {
  buildChildEntityScopeMetadata,
  canEntitiesInteractLocally,
} = require(path.join(
  __dirname,
  "../destiny/identity/interactionScope.js",
));
const {
  getActiveImplantLocationModifierSources,
} = require(path.join(__dirname, "../../services/dogma/implants/activeImplantModifiers"));
const {
  LOOT_CUSTOM_INFO_KEY,
  buildSpaceLootRightsSnapshot,
  hasAuthoritativeSpaceLootRightsSnapshot,
  readSpaceLootInfo,
} = require(path.join(__dirname, "../../services/_shared/spaceLootEntitlement"));

const EFFECT_SALVAGING = getEffectIDByNames("salvaging") || 2757;
const EFFECT_SALVAGE_DRONE = getEffectIDByNames("salvageDroneEffect") || 5163;
const HARVEST_SALVAGING = 202;

const ATTRIBUTE_CAPACITOR_NEED = getAttributeIDByNames("capacitorNeed") || 6;
const ATTRIBUTE_DURATION = getAttributeIDByNames("duration") || 73;
const ATTRIBUTE_SPEED = getAttributeIDByNames("speed") || 51;
const ATTRIBUTE_MAX_RANGE = getAttributeIDByNames("maxRange") || 54;
const ATTRIBUTE_MAX_GROUP_ACTIVE = getAttributeIDByNames("maxGroupActive") || 763;
const ATTRIBUTE_REACTIVATION_DELAY =
  getAttributeIDByNames("moduleReactivationDelay", "reactivationDelay") || 669;
const ATTRIBUTE_ACCESS_DIFFICULTY = getAttributeIDByNames("accessDifficulty") || 901;
const ATTRIBUTE_ACCESS_DIFFICULTY_BONUS =
  getAttributeIDByNames("accessDifficultyBonus") || 902;

const SALVAGEABLE_ENTITY_KINDS = new Set(["wreck"]);
const SALVAGE_CUSTOM_INFO_KEY = "evejsSalvage";
const SALVAGED_LOOT_CONTAINER_NAME = "Cargo Container";
const DEFAULT_LOOT_CONTAINER_LIFETIME_MS = 2 * 60 * 60 * 1000;
const DEFAULT_SMALL_WRECK_ACCESS_CHANCE = 30;
const DEFAULT_MEDIUM_WRECK_ACCESS_CHANCE = 20;
const DEFAULT_LARGE_WRECK_ACCESS_CHANCE = 10;
const DEFAULT_ADVANCED_WRECK_ACCESS_CHANCE = 0;
const DEFAULT_SLEEPER_WRECK_ACCESS_CHANCE = -20;
const CARGO_CAPACITY_CACHE = new Map();

const SALVAGE_MATERIALS = Object.freeze({
  trippedPowerCircuit: 25598,
  burnedLogicCircuit: 25600,
  charredMicroCircuit: 25599,
  friedInterfaceCircuit: 25601,
  contaminatedNaniteCompound: 25590,
  damagedArtificialNeuralNetwork: 25597,
  alloyedTritaniumBar: 25595,
  armorPlates: 25605,
  meltedCapacitorConsole: 25603,
  malfunctioningShieldEmitter: 25589,
  brokenDroneTransceiver: 25596,
  intactArmorPlates: 25624,
  currentPump: 25611,
  powerCircuit: 25617,
  capacitorConsole: 25622,
  enhancedWardConsole: 25625,
  scorchedTelemetryProcessor: 25588,
  smashedTriggerUnit: 25593,
  thrusterConsole: 25602,
  singleCrystalSuperalloyIBeam: 25614,
  conductivePolymer: 25604,
  droneTransceiver: 25615,
  wardConsole: 25606,
  telemetryProcessor: 25607,
  intactShieldEmitter: 25608,
  naniteCompound: 25609,
  triggerUnit: 25612,
  powerConduit: 25613,
  artificialNeuralNetwork: 25616,
});

const COMMON_T1_POOL = Object.freeze([
  { typeID: SALVAGE_MATERIALS.trippedPowerCircuit, weight: 16 },
  { typeID: SALVAGE_MATERIALS.burnedLogicCircuit, weight: 16 },
  { typeID: SALVAGE_MATERIALS.charredMicroCircuit, weight: 13 },
  { typeID: SALVAGE_MATERIALS.friedInterfaceCircuit, weight: 13 },
  { typeID: SALVAGE_MATERIALS.contaminatedNaniteCompound, weight: 10 },
  { typeID: SALVAGE_MATERIALS.damagedArtificialNeuralNetwork, weight: 8 },
  { typeID: SALVAGE_MATERIALS.malfunctioningShieldEmitter, weight: 8 },
]);

const SALVAGE_POOLS_BY_FACTION = Object.freeze({
  angel: [
    { typeID: SALVAGE_MATERIALS.alloyedTritaniumBar, weight: 18 },
    { typeID: SALVAGE_MATERIALS.armorPlates, weight: 12 },
    { typeID: SALVAGE_MATERIALS.smashedTriggerUnit, weight: 12 },
    { typeID: SALVAGE_MATERIALS.thrusterConsole, weight: 10 },
    { typeID: SALVAGE_MATERIALS.malfunctioningShieldEmitter, weight: 8 },
    { typeID: SALVAGE_MATERIALS.singleCrystalSuperalloyIBeam, weight: 2, minSize: "large" },
  ],
  blood: [
    { typeID: SALVAGE_MATERIALS.armorPlates, weight: 18 },
    { typeID: SALVAGE_MATERIALS.meltedCapacitorConsole, weight: 16 },
    { typeID: SALVAGE_MATERIALS.currentPump, weight: 10 },
    { typeID: SALVAGE_MATERIALS.powerCircuit, weight: 8 },
    { typeID: SALVAGE_MATERIALS.capacitorConsole, weight: 3, minSize: "large" },
    { typeID: SALVAGE_MATERIALS.intactArmorPlates, weight: 2, minSize: "large" },
  ],
  sansha: [
    { typeID: SALVAGE_MATERIALS.armorPlates, weight: 17 },
    { typeID: SALVAGE_MATERIALS.meltedCapacitorConsole, weight: 16 },
    { typeID: SALVAGE_MATERIALS.currentPump, weight: 10 },
    { typeID: SALVAGE_MATERIALS.powerCircuit, weight: 8 },
    { typeID: SALVAGE_MATERIALS.capacitorConsole, weight: 3, minSize: "large" },
    { typeID: SALVAGE_MATERIALS.intactArmorPlates, weight: 2, minSize: "large" },
  ],
  guristas: [
    { typeID: SALVAGE_MATERIALS.malfunctioningShieldEmitter, weight: 18 },
    { typeID: SALVAGE_MATERIALS.scorchedTelemetryProcessor, weight: 14 },
    { typeID: SALVAGE_MATERIALS.wardConsole, weight: 8 },
    { typeID: SALVAGE_MATERIALS.trippedPowerCircuit, weight: 8 },
    { typeID: SALVAGE_MATERIALS.enhancedWardConsole, weight: 2, minSize: "large" },
    { typeID: SALVAGE_MATERIALS.intactShieldEmitter, weight: 2, minSize: "large" },
  ],
  serpentis: [
    { typeID: SALVAGE_MATERIALS.burnedLogicCircuit, weight: 16 },
    { typeID: SALVAGE_MATERIALS.friedInterfaceCircuit, weight: 16 },
    { typeID: SALVAGE_MATERIALS.trippedPowerCircuit, weight: 12 },
    { typeID: SALVAGE_MATERIALS.brokenDroneTransceiver, weight: 10 },
    { typeID: SALVAGE_MATERIALS.damagedArtificialNeuralNetwork, weight: 8 },
    { typeID: SALVAGE_MATERIALS.armorPlates, weight: 4, minSize: "large" },
  ],
  drone: [
    { typeID: SALVAGE_MATERIALS.brokenDroneTransceiver, weight: 18 },
    { typeID: SALVAGE_MATERIALS.damagedArtificialNeuralNetwork, weight: 15 },
    { typeID: SALVAGE_MATERIALS.contaminatedNaniteCompound, weight: 14 },
    { typeID: SALVAGE_MATERIALS.conductivePolymer, weight: 10 },
    { typeID: SALVAGE_MATERIALS.droneTransceiver, weight: 3, minSize: "large" },
    { typeID: SALVAGE_MATERIALS.artificialNeuralNetwork, weight: 2, minSize: "large" },
  ],
  mercenary: [
    { typeID: SALVAGE_MATERIALS.trippedPowerCircuit, weight: 14 },
    { typeID: SALVAGE_MATERIALS.burnedLogicCircuit, weight: 14 },
    { typeID: SALVAGE_MATERIALS.armorPlates, weight: 10 },
    { typeID: SALVAGE_MATERIALS.malfunctioningShieldEmitter, weight: 10 },
    { typeID: SALVAGE_MATERIALS.meltedCapacitorConsole, weight: 8 },
  ],
});

const SIZE_ORDER = Object.freeze({
  small: 1,
  medium: 2,
  large: 3,
  capital: 4,
});

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function toPositiveInt(value, fallback = 0) {
  const numeric = toInt(value, fallback);
  return numeric > 0 ? numeric : fallback;
}

function roundNumber(value, digits = 6) {
  return Number(toFiniteNumber(value, 0).toFixed(digits));
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function cloneVector(value, fallback = { x: 0, y: 0, z: 0 }) {
  return {
    x: toFiniteNumber(value && value.x, fallback.x),
    y: toFiniteNumber(value && value.y, fallback.y),
    z: toFiniteNumber(value && value.z, fallback.z),
  };
}

function normalizeEffectName(effectRecord) {
  return String(effectRecord && effectRecord.name || "").trim();
}

function resolveActivationCharacterID(entity, moduleItem, shipItem, options = {}) {
  return toPositiveInt(
    options.characterID ||
      options.charid ||
      (entity && (entity.characterID || entity.charid || entity.pilotCharacterID)) ||
      (moduleItem && moduleItem.ownerID) ||
      (shipItem && shipItem.ownerID),
    0,
  );
}

function isSalvagingEffectRecord(effectRecord) {
  if (!effectRecord) {
    return false;
  }
  const effectID = toInt(effectRecord.effectID, 0);
  if (effectID === EFFECT_SALVAGING || effectID === EFFECT_SALVAGE_DRONE) {
    return true;
  }
  const name = normalizeEffectName(effectRecord);
  return name === "salvaging" || name === "salvageDroneEffect";
}

function isModuleSalvagingEffectRecord(effectRecord) {
  if (!effectRecord) {
    return false;
  }
  const effectID = toInt(effectRecord.effectID, 0);
  if (effectID === EFFECT_SALVAGING) {
    return true;
  }
  return normalizeEffectName(effectRecord) === "salvaging";
}

function getSurfaceDistance(left, right) {
  const dx = toFiniteNumber(left && left.position && left.position.x, 0) -
    toFiniteNumber(right && right.position && right.position.x, 0);
  const dy = toFiniteNumber(left && left.position && left.position.y, 0) -
    toFiniteNumber(right && right.position && right.position.y, 0);
  const dz = toFiniteNumber(left && left.position && left.position.z, 0) -
    toFiniteNumber(right && right.position && right.position.z, 0);
  const centerDistance = Math.sqrt((dx ** 2) + (dy ** 2) + (dz ** 2));
  return Math.max(
    0,
    centerDistance -
      Math.max(0, toFiniteNumber(left && left.radius, 0)) -
      Math.max(0, toFiniteNumber(right && right.radius, 0)),
  );
}

function parseSalvageCustomInfo(customInfo) {
  if (!customInfo || typeof customInfo !== "string") {
    return {};
  }
  try {
    const parsed = JSON.parse(customInfo);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_) {
    // ignored: customInfo that is not JSON counts as empty
    return {};
  }
}

function isInventoryItemMarkedSalvaged(itemRecord) {
  const info = parseSalvageCustomInfo(itemRecord && itemRecord.customInfo);
  return Boolean(info && info[SALVAGE_CUSTOM_INFO_KEY] && info[SALVAGE_CUSTOM_INFO_KEY].salvaged);
}

function isNativeWreckMarkedSalvaged(wreckID) {
  const wreckRecord = nativeNpcStore.getNativeWreck(toPositiveInt(wreckID, 0));
  return Boolean(wreckRecord && wreckRecord.salvaged === true);
}

function resolveLootContainerType() {
  const lookup = resolveItemByName(SALVAGED_LOOT_CONTAINER_NAME);
  if (lookup && lookup.success && lookup.match) {
    return lookup.match;
  }
  return null;
}

function callSalvageMutationSafely(executor, fallbackErrorMsg) {
  try {
    return executor();
  } catch (error) {
    return {
      success: false,
      errorMsg:
        String(error && error.message || "").trim() || fallbackErrorMsg,
    };
  }
}

function hasOwn(object, key) {
  return Boolean(
    object &&
    typeof object === "object" &&
    Object.prototype.hasOwnProperty.call(object, key),
  );
}

function copyExplicitLootField(lootInfo, fieldName, sources = []) {
  if (hasOwn(lootInfo, fieldName)) {
    return;
  }
  for (const source of sources) {
    if (!hasOwn(source, fieldName) || source[fieldName] === undefined) {
      continue;
    }
    lootInfo[fieldName] = source[fieldName];
    return;
  }
}

// Salvaging a wreck with cargo replaces the wreck row with a Cargo Container.
// That is a shape change, not a new loot-right event: the replacement must not
// look up the owner's *current* corporation or fleet and silently mint new
// rights. Preserve persisted evejsLoot first, then fill only fields explicitly
// carried by the source record/live entity. Native wrecks store their snapshot
// as top-level fields, while abandonment can still be live-only.
function buildReplacementContainerLootCustomInfo(targetEntity, sourceRecord) {
  const targetLootInfo = readSpaceLootInfo(targetEntity && targetEntity.customInfo);
  const sourceLootInfo = readSpaceLootInfo(sourceRecord && sourceRecord.customInfo);
  const lootInfo = {
    ...targetLootInfo,
    ...sourceLootInfo,
  };
  const explicitSources = [sourceRecord, targetEntity];

  for (const fieldName of [
    "corporationID",
    "lootRightCorpID",
    "allianceID",
    "warFactionID",
    "lootRightFleetID",
  ]) {
    copyExplicitLootField(lootInfo, fieldName, explicitSources);
  }

  const abandonmentSources = [sourceLootInfo, targetLootInfo, ...explicitSources];
  const hasExplicitAbandonment = abandonmentSources.some(
    (source) => hasOwn(source, "abandoned") || hasOwn(source, "lootAbandoned"),
  );
  if (hasExplicitAbandonment) {
    // Abandonment is one-way. A live true therefore wins over a stale persisted
    // false if both representations happen to be present during replacement.
    lootInfo.abandoned = abandonmentSources.some(
      (source) =>
        source &&
        (source.abandoned === true || source.lootAbandoned === true),
    );
  }

  // Native records use lootRightsSnapshotVersion; inventory customInfo uses
  // rightsSnapshotVersion. Only canonicalize a wreck that already carried an
  // authoritative snapshot. Legacy wrecks deliberately resolve missing
  // corporation/fleet fields from their owner's live membership; stamping an
  // empty v1 snapshot here would silently revoke those pre-salvage rights.
  const hasAuthoritativeSnapshot = Boolean(
    hasAuthoritativeSpaceLootRightsSnapshot(sourceLootInfo) ||
    hasAuthoritativeSpaceLootRightsSnapshot(targetLootInfo) ||
    toPositiveInt(sourceLootInfo.lootRightsSnapshotVersion, 0) >= 1 ||
    toPositiveInt(targetLootInfo.lootRightsSnapshotVersion, 0) >= 1 ||
    toPositiveInt(sourceRecord && sourceRecord.lootRightsSnapshotVersion, 0) >= 1 ||
    toPositiveInt(targetEntity && targetEntity.lootRightsSnapshotVersion, 0) >= 1
  );
  delete lootInfo.lootRightsSnapshotVersion;
  if (!hasAuthoritativeSnapshot) {
    delete lootInfo.rightsSnapshotVersion;
  }
  const canonicalLootInfo = hasAuthoritativeSnapshot
    ? {
      ...lootInfo,
      ...buildSpaceLootRightsSnapshot(lootInfo),
    }
    : lootInfo;

  return JSON.stringify({
    [LOOT_CUSTOM_INFO_KEY]: canonicalLootInfo,
  });
}

function buildSpaceContainerOptions(targetEntity, sourceRecord = null, nowMs = Date.now()) {
  const sourceSpaceState = sourceRecord && sourceRecord.spaceState ? sourceRecord.spaceState : {};
  const position = cloneVector(
    targetEntity && targetEntity.position ? targetEntity.position : sourceSpaceState.position,
  );
  const direction = cloneVector(
    targetEntity && targetEntity.direction ? targetEntity.direction : sourceSpaceState.direction,
    { x: 1, y: 0, z: 0 },
  );
  const velocity = cloneVector(
    targetEntity && targetEntity.velocity ? targetEntity.velocity : sourceSpaceState.velocity,
  );
  const targetPoint = cloneVector(
    targetEntity && targetEntity.targetPoint ? targetEntity.targetPoint : sourceSpaceState.targetPoint,
    position,
  );
  const createdAtMs = Math.max(
    0,
    toFiniteNumber(sourceRecord && sourceRecord.createdAtMs, 0) ||
      toFiniteNumber(nowMs, Date.now()),
  );
  const sourceExpiresAtMs = toFiniteNumber(
    (sourceRecord && sourceRecord.expiresAtMs) ||
      (targetEntity && targetEntity.expiresAtMs),
    0,
  );
  const fallbackExpiresAtMs = toFiniteNumber(nowMs, Date.now()) + DEFAULT_LOOT_CONTAINER_LIFETIME_MS;

  return {
    ...buildChildEntityScopeMetadata({
      ...(sourceRecord || {}),
      ...(
        sourceRecord && sourceRecord.spaceState
          ? sourceRecord.spaceState
          : {}
      ),
      ...(targetEntity || {}),
    }),
    position,
    velocity,
    direction,
    targetPoint,
    mode: "STOP",
    speedFraction: 0,
    createdAtMs,
    expiresAtMs: sourceExpiresAtMs > 0 ? sourceExpiresAtMs : fallbackExpiresAtMs,
    itemName: SALVAGED_LOOT_CONTAINER_NAME,
    customInfo: buildReplacementContainerLootCustomInfo(
      targetEntity,
      sourceRecord,
    ),
  };
}

function createLootContainerAtWreck(targetEntity, sourceRecord, nowMs) {
  const containerType = resolveLootContainerType();
  if (!containerType) {
    return {
      success: false,
      errorMsg: "CONTAINER_TYPE_NOT_FOUND",
    };
  }

  const ownerID = toPositiveInt(
    (sourceRecord && sourceRecord.ownerID) ||
      (targetEntity && targetEntity.ownerID),
    0,
  );
  const systemID = toPositiveInt(
    (sourceRecord && (sourceRecord.systemID || sourceRecord.locationID)) ||
      (targetEntity && targetEntity.systemID),
    0,
  );
  if (!ownerID || !systemID) {
    return {
      success: false,
      errorMsg: "CONTAINER_CREATE_FAILED",
    };
  }

  const createResult = createSpaceItemForOwner(
    ownerID,
    systemID,
    containerType,
    buildSpaceContainerOptions(targetEntity, sourceRecord, nowMs),
  );
  if (!createResult.success || !createResult.data) {
    return {
      success: false,
      errorMsg: createResult.errorMsg || "CONTAINER_CREATE_FAILED",
    };
  }

  return {
    success: true,
    data: {
      container: createResult.data,
      changes: createResult.changes || [],
    },
  };
}

function getWreckSourceText(targetEntity, itemRecord = null, nativeWreckRecord = null) {
  return [
    targetEntity && targetEntity.itemName,
    targetEntity && targetEntity.typeName,
    targetEntity && targetEntity.groupName,
    targetEntity && targetEntity.sourceNpcName,
    targetEntity && targetEntity.sourceFactionName,
    targetEntity && targetEntity.ownerName,
    itemRecord && itemRecord.itemName,
    nativeWreckRecord && nativeWreckRecord.itemName,
    nativeWreckRecord && nativeWreckRecord.sourceNpcName,
    nativeWreckRecord && nativeWreckRecord.sourceFactionName,
  ]
    .filter(Boolean)
    .map(String)
    .join(" ")
    .toLowerCase();
}

function isSalvageableTarget(targetEntity) {
  if (!targetEntity) {
    return false;
  }
  const kind = String(targetEntity.kind || "").trim();
  if (!SALVAGEABLE_ENTITY_KINDS.has(kind) && targetEntity.nativeNpcWreck !== true) {
    return false;
  }
  if (targetEntity.salvaged === true || targetEntity.salvageComplete === true) {
    return false;
  }
  const targetID = toPositiveInt(targetEntity.itemID, 0);
  if (targetID <= 0) {
    return false;
  }
  if (targetEntity.nativeNpcWreck === true) {
    return !isNativeWreckMarkedSalvaged(targetID);
  }
  const itemRecord = findItemById(targetID);
  return !isInventoryItemMarkedSalvaged(itemRecord);
}

function getTargetItemRecord(targetEntity) {
  const targetID = toPositiveInt(targetEntity && targetEntity.itemID, 0);
  if (!targetID) {
    return null;
  }
  if (targetEntity && targetEntity.nativeNpcWreck === true) {
    return nativeNpcStore.buildNativeWreckInventoryItem(targetID);
  }
  return findItemById(targetID);
}

function resolveEntitySize(targetEntity, itemRecord = null, nativeWreckRecord = null) {
  const source = getWreckSourceText(targetEntity, itemRecord, nativeWreckRecord);
  const typeID = toPositiveInt(
    (itemRecord && itemRecord.typeID) ||
      (nativeWreckRecord && nativeWreckRecord.typeID) ||
      (targetEntity && targetEntity.typeID),
    0,
  );
  const typeRecord = resolveItemByTypeID(typeID) || {};
  const combined = `${source} ${normalizeText(typeRecord.name)} ${normalizeText(typeRecord.groupName)}`;

  if (/\b(titan|supercarrier|carrier|dreadnought|freighter|capital|force auxiliary|fax)\b/.test(combined)) {
    return "capital";
  }
  if (/\b(large|battleship|battlecruiser|industrial command|command ship|marauder|black ops)\b/.test(combined)) {
    return "large";
  }
  if (/\b(medium|cruiser|destroyer|logistics|recon|heavy assault|strategic cruiser|battlecruiser)\b/.test(combined)) {
    return "medium";
  }
  return "small";
}

function resolveAccessDifficultyBase(targetEntity, itemRecord = null, nativeWreckRecord = null) {
  const typeID = toPositiveInt(
    (itemRecord && itemRecord.typeID) ||
      (nativeWreckRecord && nativeWreckRecord.typeID) ||
      (targetEntity && targetEntity.typeID),
    0,
  );
  if (typeID > 0) {
    const typeAttrs = getTypeAttributeMap(typeID);
    const directAccessDifficulty = toFiniteNumber(typeAttrs[ATTRIBUTE_ACCESS_DIFFICULTY], NaN);
    if (Number.isFinite(directAccessDifficulty)) {
      return directAccessDifficulty;
    }
  }

  const source = getWreckSourceText(targetEntity, itemRecord, nativeWreckRecord);
  if (/\b(sleeper|drifter)\b/.test(source)) {
    return DEFAULT_SLEEPER_WRECK_ACCESS_CHANCE;
  }
  if (/\b(advanced|officer|commander|elite|tech ii|t2|abyssal|triglavian)\b/.test(source)) {
    return DEFAULT_ADVANCED_WRECK_ACCESS_CHANCE;
  }
  switch (resolveEntitySize(targetEntity, itemRecord, nativeWreckRecord)) {
    case "capital":
    case "large":
      return DEFAULT_LARGE_WRECK_ACCESS_CHANCE;
    case "medium":
      return DEFAULT_MEDIUM_WRECK_ACCESS_CHANCE;
    case "small":
    default:
      return DEFAULT_SMALL_WRECK_ACCESS_CHANCE;
  }
}

function calculateSalvageChancePercent(accessBasePercent, accessBonusPercent) {
  return Math.max(
    0,
    Math.min(
      100,
      roundNumber(
        toFiniteNumber(accessBasePercent, 0) + toFiniteNumber(accessBonusPercent, 0),
        6,
      ),
    ),
  );
}

function buildSalvageChanceSnapshot(targetEntity, accessBonusPercent = 0) {
  const itemRecord = getTargetItemRecord(targetEntity);
  const nativeWreckRecord = targetEntity && targetEntity.nativeNpcWreck === true
    ? nativeNpcStore.getNativeWreck(targetEntity.itemID)
    : null;
  const accessBasePercent = resolveAccessDifficultyBase(
    targetEntity,
    itemRecord,
    nativeWreckRecord,
  );
  const chancePercent = calculateSalvageChancePercent(
    accessBasePercent,
    accessBonusPercent,
  );
  return {
    accessBasePercent,
    accessBonusPercent: toFiniteNumber(accessBonusPercent, 0),
    chancePercent,
    faction: classifyWreckFaction(targetEntity, itemRecord, nativeWreckRecord),
    size: resolveEntitySize(targetEntity, itemRecord, nativeWreckRecord),
  };
}

function classifyWreckFaction(targetEntity, itemRecord = null, nativeWreckRecord = null) {
  const source = getWreckSourceText(targetEntity, itemRecord, nativeWreckRecord);
  if (/\b(angel|gist|domination)\b/.test(source)) {
    return "angel";
  }
  if (/\b(blood|corpus|corpii|corpum|dark blood)\b/.test(source)) {
    return "blood";
  }
  if (/\b(sansha|centii|centum|centus|true sansha)\b/.test(source)) {
    return "sansha";
  }
  if (/\b(guristas|pith|dread guristas|dire pithi|dire pithum|dire pithatis)\b/.test(source)) {
    return "guristas";
  }
  if (/\b(serpentis|coreli|corelum|core|shadow serpentis)\b/.test(source)) {
    return "serpentis";
  }
  if (/\b(rogue drone|drone|alvi|alvum|alvus|strain|infested)\b/.test(source)) {
    return "drone";
  }
  if (/\b(mercenary|mordus|mordu|state navy|federation navy|imperial navy|republic fleet)\b/.test(source)) {
    return "mercenary";
  }
  return "generic";
}

function getRandom(callbacks = {}) {
  if (callbacks && typeof callbacks.random === "function") {
    const value = Number(callbacks.random());
    if (Number.isFinite(value)) {
      return Math.max(0, Math.min(0.999999999, value));
    }
  }
  return Math.random();
}

function filterPoolForSize(pool, size) {
  const sizeRank = SIZE_ORDER[size] || SIZE_ORDER.small;
  return pool.filter((entry) => {
    if (!entry || entry.typeID <= 0) {
      return false;
    }
    if (!entry.minSize) {
      return true;
    }
    return sizeRank >= (SIZE_ORDER[entry.minSize] || SIZE_ORDER.large);
  });
}

function chooseWeighted(pool, callbacks = {}) {
  const entries = Array.isArray(pool) ? pool.filter((entry) => entry && entry.weight > 0) : [];
  const totalWeight = entries.reduce((sum, entry) => sum + toFiniteNumber(entry.weight, 0), 0);
  if (totalWeight <= 0) {
    return null;
  }
  let roll = getRandom(callbacks) * totalWeight;
  for (const entry of entries) {
    roll -= toFiniteNumber(entry.weight, 0);
    if (roll <= 0) {
      return entry;
    }
  }
  return entries[entries.length - 1] || null;
}

function mergeGrantEntries(entries) {
  const merged = new Map();
  for (const entry of entries || []) {
    const typeID = toPositiveInt(entry && entry.itemType, 0);
    const quantity = toPositiveInt(entry && entry.quantity, 0);
    if (!typeID || !quantity) {
      continue;
    }
    merged.set(typeID, (merged.get(typeID) || 0) + quantity);
  }
  return [...merged.entries()].map(([itemType, quantity]) => ({ itemType, quantity }));
}

function buildSalvageRewardEntries(targetEntity, options = {}) {
  if (targetEntity?.homefrontRole === "salvage")
    return [{ itemType: 81352, quantity: 1 }];
  const itemRecord = options.itemRecord || getTargetItemRecord(targetEntity);
  const nativeWreckRecord = targetEntity && targetEntity.nativeNpcWreck === true
    ? nativeNpcStore.getNativeWreck(targetEntity.itemID)
    : null;
  const size = resolveEntitySize(targetEntity, itemRecord, nativeWreckRecord);
  const faction = classifyWreckFaction(targetEntity, itemRecord, nativeWreckRecord);
  const factionPool = SALVAGE_POOLS_BY_FACTION[faction] || [];
  const pool = [
    ...filterPoolForSize(factionPool, size),
    ...filterPoolForSize(COMMON_T1_POOL, size),
  ];
  const randomCallbacks = options.callbacks || {};
  const emptyChance =
    size === "small"
      ? 0.22
      : size === "medium"
        ? 0.14
        : size === "large"
          ? 0.08
          : 0.02;
  if (getRandom(randomCallbacks) < emptyChance) {
    return [];
  }

  const rollCount =
    size === "capital"
      ? 4 + Math.floor(getRandom(randomCallbacks) * 5)
      : size === "large"
        ? 1 + Math.floor(getRandom(randomCallbacks) * 3)
        : size === "medium"
          ? 1 + Math.floor(getRandom(randomCallbacks) * 2)
          : 1;
  const grantEntries = [];
  for (let index = 0; index < rollCount; index += 1) {
    const selected = chooseWeighted(pool, randomCallbacks);
    if (!selected) {
      continue;
    }
    const quantity =
      size === "capital"
        ? 2 + Math.floor(getRandom(randomCallbacks) * 4)
        : size === "large"
          ? 1 + Math.floor(getRandom(randomCallbacks) * 3)
          : size === "medium"
            ? 1 + Math.floor(getRandom(randomCallbacks) * 2)
            : 1;
    grantEntries.push({
      itemType: selected.typeID,
      quantity,
    });
  }
  return mergeGrantEntries(grantEntries);
}

function computeUsedVolume(items = []) {
  return items.reduce((sum, item) => {
    if (!item) {
      return sum;
    }
    const units =
      toInt(item.singleton, 0) === 1
        ? 1
        : Math.max(0, toInt(item.stacksize ?? item.quantity, 0));
    const volume = Math.max(0, toFiniteNumber(item.volume, 0));
    return sum + (volume * units);
  }, 0);
}

function computeGrantVolume(grantEntries = []) {
  return grantEntries.reduce((sum, entry) => {
    const typeID = toPositiveInt(entry && entry.itemType, 0);
    const itemType = resolveItemByTypeID(typeID);
    const quantity = toPositiveInt(entry && entry.quantity, 0);
    if (!itemType || quantity <= 0) {
      return sum;
    }
    return sum + (Math.max(0, toFiniteNumber(itemType.volume, 0)) * quantity);
  }, 0);
}

function resolveCargoSnapshot(characterID, shipItem, fittedItems = [], skillMap = null) {
  const numericCharacterID = toPositiveInt(characterID, 0);
  const shipID = toPositiveInt(shipItem && shipItem.itemID, 0);
  if (!numericCharacterID || !shipID || !shipItem) {
    return null;
  }
  const mutationVersion = getItemMutationVersion();
  const cacheKey = `${numericCharacterID}:${shipID}:${mutationVersion}`;
  if (CARGO_CAPACITY_CACHE.has(cacheKey)) {
    return CARGO_CAPACITY_CACHE.get(cacheKey);
  }
  const resourceState = buildShipResourceState(numericCharacterID, shipItem, {
    fittedItems,
    skillMap,
  });
  const usedVolume = computeUsedVolume(
    listContainerItems(numericCharacterID, shipID, ITEM_FLAGS.CARGO_HOLD),
  );
  const snapshot = {
    characterID: numericCharacterID,
    shipID,
    cargoCapacity: Math.max(0, toFiniteNumber(resourceState && resourceState.cargoCapacity, 0)),
    usedVolume: roundNumber(usedVolume, 6),
  };
  snapshot.availableVolume = Math.max(
    0,
    roundNumber(snapshot.cargoCapacity - snapshot.usedVolume, 6),
  );
  CARGO_CAPACITY_CACHE.set(cacheKey, snapshot);
  return snapshot;
}

function resolveCharacterID(entity, callbacks = {}) {
  if (callbacks && typeof callbacks.resolveCharacterID === "function") {
    const resolved = toPositiveInt(callbacks.resolveCharacterID(entity), 0);
    if (resolved > 0) {
      return resolved;
    }
  }
  return toPositiveInt(
    entity &&
      (
        entity.characterID ||
        entity.pilotCharacterID ||
        (entity.session && (entity.session.characterID || entity.session.charid))
      ),
    0,
  );
}

function resolveSalvagerActivation({
  scene,
  entity,
  moduleItem,
  effectRecord,
  chargeItem = null,
  shipItem,
  skillMap = null,
  fittedItems = null,
  activeModuleContexts = null,
  additionalDirectModifierEntries = null,
  options = {},
  callbacks = {},
} = {}) {
  if (!isModuleSalvagingEffectRecord(effectRecord)) {
    return { matched: false };
  }

  if (!scene || !entity || !moduleItem || !shipItem) {
    return {
      matched: true,
      success: false,
      errorMsg: "UNSUPPORTED_MODULE",
    };
  }

  const targetID = toPositiveInt(options.targetID, 0);
  if (!targetID) {
    return {
      matched: true,
      success: false,
      errorMsg: "TARGET_REQUIRED",
    };
  }

  const targetEntity = scene.getEntityByID(targetID);
  if (
    !isSalvageableTarget(targetEntity) ||
    !canEntitiesInteractLocally(entity, targetEntity)
  ) {
    return {
      matched: true,
      success: false,
      errorMsg: "TARGET_NOT_FOUND",
    };
  }

  if (
    callbacks.isEntityLockedTarget &&
    !callbacks.isEntityLockedTarget(entity, targetID)
  ) {
    return {
      matched: true,
      success: false,
      errorMsg: "TARGET_NOT_LOCKED",
    };
  }

  const characterID = resolveActivationCharacterID(entity, moduleItem, shipItem, options);
  const additionalLocationModifierSources = [
    ...(characterID > 0 ? getActiveImplantLocationModifierSources(characterID) : []),
    ...(Array.isArray(options.additionalLocationModifierSources)
      ? options.additionalLocationModifierSources
      : []),
  ];
  const moduleAttributes = buildLiveModuleAttributeMap(
    shipItem,
    moduleItem,
    chargeItem,
    skillMap,
    fittedItems,
    activeModuleContexts,
    {
      additionalLocationModifierSources,
      additionalDirectModifierEntries: Array.isArray(
        additionalDirectModifierEntries,
      )
        ? additionalDirectModifierEntries
        : [],
    },
  );
  if (!moduleAttributes) {
    return {
      matched: true,
      success: false,
      errorMsg: "UNSUPPORTED_MODULE",
    };
  }

  const maxRangeMeters = Math.max(
    0,
    roundNumber(toFiniteNumber(moduleAttributes[ATTRIBUTE_MAX_RANGE], 0), 3),
  );
  const surfaceDistance = callbacks.getEntitySurfaceDistance
    ? callbacks.getEntitySurfaceDistance(entity, targetEntity)
    : getSurfaceDistance(entity, targetEntity);
  if (surfaceDistance > maxRangeMeters + 1) {
    return {
      matched: true,
      success: false,
      errorMsg: "TARGET_OUT_OF_RANGE",
    };
  }

  const itemRecord = getTargetItemRecord(targetEntity);
  const nativeWreckRecord = targetEntity.nativeNpcWreck === true
    ? nativeNpcStore.getNativeWreck(targetID)
    : null;
  const accessBasePercent = resolveAccessDifficultyBase(
    targetEntity,
    itemRecord,
    nativeWreckRecord,
  );
  const accessBonusPercent = toFiniteNumber(
    moduleAttributes[ATTRIBUTE_ACCESS_DIFFICULTY_BONUS],
    0,
  );
  if (targetEntity.homefrontRole === "salvage" && accessBonusPercent < 20) {
    return {
      matched: true,
      success: false,
      errorMsg: "SALVAGE_CHANCE_TOO_LOW",
    };
  }
  const chancePercent = calculateSalvageChancePercent(
    accessBasePercent,
    accessBonusPercent,
  );
  const rawDurationMs = toFiniteNumber(
    moduleAttributes[ATTRIBUTE_DURATION],
    moduleAttributes[ATTRIBUTE_SPEED],
  );
  const durationAttributeID =
    toFiniteNumber(moduleAttributes[ATTRIBUTE_DURATION], 0) > 0
      ? ATTRIBUTE_DURATION
      : ATTRIBUTE_SPEED;

  return {
    matched: true,
    success: true,
    data: {
      targetEntity,
      runtimeAttrs: {
        capNeed: Math.max(0, roundNumber(toFiniteNumber(moduleAttributes[ATTRIBUTE_CAPACITOR_NEED], 0), 6)),
        durationMs: Math.max(1, roundNumber(rawDurationMs > 0 ? rawDurationMs : 10000, 3)),
        durationAttributeID,
        reactivationDelayMs: Math.max(
          0,
          roundNumber(toFiniteNumber(moduleAttributes[ATTRIBUTE_REACTIVATION_DELAY], 0), 3),
        ),
        maxGroupActive: Math.max(0, toInt(moduleAttributes[ATTRIBUTE_MAX_GROUP_ACTIVE], 0)),
        weaponFamily: null,
        attributeOverrides: {
          ...moduleAttributes,
        },
        salvagerSnapshot: {
          maxRangeMeters,
          accessBasePercent,
          accessBonusPercent,
          chancePercent,
          targetID,
          faction: classifyWreckFaction(targetEntity, itemRecord, nativeWreckRecord),
          size: resolveEntitySize(targetEntity, itemRecord, nativeWreckRecord),
        },
      },
      effectStatePatch: {
        salvagerEffect: true,
        salvagerRangeMeters: maxRangeMeters,
        salvageAccessBasePercent: accessBasePercent,
        salvageAccessBonusPercent: accessBonusPercent,
        salvageChancePercent: chancePercent,
      },
    },
  };
}

function hasRemainingLoot(targetEntity) {
  const wreckID = toPositiveInt(targetEntity && targetEntity.itemID, 0);
  if (!wreckID) {
    return false;
  }
  if (targetEntity && targetEntity.nativeNpcWreck === true) {
    return nativeNpcStore.listNativeWreckItemsForWreck(wreckID).length > 0;
  }
  return listContainerItems(null, wreckID, null).length > 0;
}

function syncSpawnedLootContainer(scene, containerRecord, callbacks = {}) {
  if (!containerRecord) {
    return {
      success: false,
      errorMsg: "CONTAINER_NOT_FOUND",
    };
  }

  if (callbacks && typeof callbacks.spawnInventoryBackedEntity === "function") {
    return callbacks.spawnInventoryBackedEntity(containerRecord, {
      broadcast: true,
      broadcastOptions: {
        freshAcquire: true,
      },
    });
  }

  if (scene && typeof scene.spawnDynamicInventoryEntity === "function") {
    return scene.spawnDynamicInventoryEntity(containerRecord.itemID, {
      broadcast: true,
    });
  }

  // A persisted container alone is invisible to pilots already in the scene.
  // Refuse completion so the caller restores the wreck and its contents.
  return {
    success: false,
    errorMsg: "CONTAINER_SPAWN_UNAVAILABLE",
  };
}

function transferInventoryWreckLootToContainer(wreckID, containerID) {
  const changes = [];
  const contents = listContainerItems(null, wreckID, null);
  for (const item of contents) {
    const moveResult = callSalvageMutationSafely(
      () => moveItemToLocation(
        item.itemID,
        containerID,
        ITEM_FLAGS.HANGAR,
      ),
      "LOOT_TRANSFER_FAILED",
    );
    if (!moveResult.success) {
      return {
        success: false,
        errorMsg: moveResult.errorMsg || "LOOT_TRANSFER_FAILED",
        changes,
      };
    }
    changes.push(...((moveResult.data && moveResult.data.changes) || []));
  }
  return {
    success: true,
    changes,
  };
}

function replaceInventoryWreckWithLootContainer(scene, targetEntity, nowMs, callbacks = {}) {
  const wreckID = toPositiveInt(targetEntity && targetEntity.itemID, 0);
  const itemRecord = findItemById(wreckID);
  if (!itemRecord) {
    return {
      success: false,
      errorMsg: "WRECK_NOT_FOUND",
    };
  }

  const createResult = callSalvageMutationSafely(
    () => createLootContainerAtWreck(targetEntity, itemRecord, nowMs),
    "CONTAINER_CREATE_FAILED",
  );
  if (!createResult.success) {
    return createResult;
  }

  const container = createResult.data.container;
  const changes = [...(createResult.data.changes || [])];
  const transferResult = transferInventoryWreckLootToContainer(wreckID, container.itemID);
  if (!transferResult.success) {
    return {
      success: false,
      errorMsg: transferResult.errorMsg || "LOOT_TRANSFER_FAILED",
      changes: [...changes, ...(transferResult.changes || [])],
    };
  }
  changes.push(...(transferResult.changes || []));

  const removeResult = callSalvageMutationSafely(
    () => removeInventoryItem(wreckID, {
      removeContents: false,
    }),
    "WRECK_REMOVE_FAILED",
  );
  if (!removeResult.success) {
    return {
      success: false,
      errorMsg: removeResult.errorMsg || "WRECK_REMOVE_FAILED",
      changes,
    };
  }
  changes.push(...((removeResult.data && removeResult.data.changes) || []));

  return {
    success: true,
    changes,
    containerID: container.itemID,
    container,
  };
}

function replaceNativeWreckWithLootContainer(scene, targetEntity, nowMs, callbacks = {}) {
  const wreckID = toPositiveInt(targetEntity && targetEntity.itemID, 0);
  const wreckRecord = nativeNpcStore.getNativeWreck(wreckID);
  if (!wreckRecord) {
    return {
      success: false,
      errorMsg: "WRECK_NOT_FOUND",
    };
  }

  const createResult = callSalvageMutationSafely(
    () => createLootContainerAtWreck(targetEntity, wreckRecord, nowMs),
    "CONTAINER_CREATE_FAILED",
  );
  if (!createResult.success) {
    return createResult;
  }

  const container = createResult.data.container;
  const changes = [...(createResult.data.changes || [])];
  const transferResult = transferNativeWreckLootToContainer(
    wreckRecord,
    container.itemID,
    toPositiveInt(container.ownerID, 0),
  );
  if (!transferResult.success) {
    return {
      success: false,
      errorMsg: transferResult.errorMsg || "LOOT_TRANSFER_FAILED",
      changes: [...changes, ...(transferResult.changes || [])],
      nativeRollback: {
        wreckRecord: cloneValue(wreckRecord),
        removedSourceRecords: cloneValue(transferResult.removedSourceRecords || []),
      },
    };
  }
  changes.push(...(transferResult.changes || []));

  const removeResult = callSalvageMutationSafely(
    () => nativeNpcStore.removeNativeWreck(wreckID),
    "WRECK_REMOVE_FAILED",
  );
  if (!removeResult || removeResult.success !== true) {
    return {
      success: false,
      errorMsg: removeResult && removeResult.errorMsg || "WRECK_REMOVE_FAILED",
      changes,
      nativeRollback: {
        wreckRecord: cloneValue(wreckRecord),
        removedSourceRecords: cloneValue(transferResult.removedSourceRecords || []),
      },
    };
  }

  return {
    success: true,
    changes,
    containerID: container.itemID,
    container,
    nativeRollback: {
      wreckRecord: cloneValue(wreckRecord),
      removedSourceRecords: cloneValue(transferResult.removedSourceRecords || []),
    },
  };
}

function removeSalvagedWreck(scene, targetEntity) {
  const wreckID = toPositiveInt(targetEntity && targetEntity.itemID, 0);
  if (!wreckID) {
    return {
      success: false,
      errorMsg: "WRECK_NOT_FOUND",
    };
  }
  if (targetEntity && targetEntity.nativeNpcWreck === true) {
    const wreckRecord = nativeNpcStore.getNativeWreck(wreckID);
    if (!wreckRecord) {
      return {
        success: false,
        errorMsg: "WRECK_NOT_FOUND",
      };
    }
    const removeResult = callSalvageMutationSafely(
      () => nativeNpcStore.removeNativeWreck(wreckID),
      "WRECK_REMOVE_FAILED",
    );
    if (!removeResult || removeResult.success !== true) {
      return {
        success: false,
        errorMsg: removeResult && removeResult.errorMsg || "WRECK_REMOVE_FAILED",
      };
    }
    return {
      success: true,
      changes: [],
      nativeRollback: {
        wreckRecord: cloneValue(wreckRecord),
        removedSourceRecords: [],
      },
    };
  }
  const removeResult = callSalvageMutationSafely(
    () => removeInventoryItem(wreckID, {
      removeContents: true,
    }),
    "WRECK_REMOVE_FAILED",
  );
  if (!removeResult.success) {
    return removeResult;
  }
  return {
    success: true,
    changes: (removeResult.data && removeResult.data.changes) || [],
  };
}

function completeSuccessfulSalvage(scene, targetEntity, nowMs, callbacks = {}) {
  if (hasRemainingLoot(targetEntity)) {
    return targetEntity && targetEntity.nativeNpcWreck === true
      ? replaceNativeWreckWithLootContainer(scene, targetEntity, nowMs, callbacks)
      : replaceInventoryWreckWithLootContainer(scene, targetEntity, nowMs, callbacks);
  }
  return removeSalvagedWreck(scene, targetEntity);
}

function restoreNativeSalvageState(nativeRollback = null) {
  if (!nativeRollback || !nativeRollback.wreckRecord) {
    return { success: true };
  }
  const wreckRecord = cloneValue(nativeRollback.wreckRecord);
  const wreckResult = callSalvageMutationSafely(
    () => nativeNpcStore.upsertNativeWreck(wreckRecord, {
      transient: wreckRecord.transient === true,
    }),
    "NATIVE_WRECK_ROLLBACK_FAILED",
  );
  if (!wreckResult || wreckResult.success !== true) {
    return {
      success: false,
      errorMsg: wreckResult && wreckResult.errorMsg || "NATIVE_WRECK_ROLLBACK_FAILED",
    };
  }
  for (const sourceRecord of nativeRollback.removedSourceRecords || []) {
    const itemResult = callSalvageMutationSafely(
      () => nativeNpcStore.upsertNativeWreckItem(sourceRecord, {
        transient: sourceRecord && sourceRecord.transient === true,
      }),
      "NATIVE_WRECK_ROLLBACK_FAILED",
    );
    if (!itemResult || itemResult.success !== true) {
      return {
        success: false,
        errorMsg: itemResult && itemResult.errorMsg || "NATIVE_WRECK_ROLLBACK_FAILED",
      };
    }
  }
  return { success: true };
}

function compensateSalvageCompletion(completionResult, additionalChanges = []) {
  const inventoryChanges = [
    ...((completionResult && completionResult.changes) || []),
    ...(Array.isArray(additionalChanges) ? additionalChanges : []),
  ];
  const inventoryResult = callSalvageMutationSafely(
    () => restoreInventoryItemChangesAtomic(inventoryChanges),
    "SALVAGE_INVENTORY_ROLLBACK_FAILED",
  );
  if (!inventoryResult || inventoryResult.success !== true) {
    return {
      success: false,
      errorMsg:
        inventoryResult && inventoryResult.errorMsg ||
        "SALVAGE_INVENTORY_ROLLBACK_FAILED",
    };
  }
  const nativeResult = restoreNativeSalvageState(
    completionResult && completionResult.nativeRollback,
  );
  if (!nativeResult.success) {
    return nativeResult;
  }
  return { success: true };
}

function removeSalvageSceneEntity(scene, entityID) {
  if (!scene || typeof scene.removeDynamicEntity !== "function") {
    return { success: true };
  }
  return callSalvageMutationSafely(
    () => scene.removeDynamicEntity(entityID, {
      allowSessionOwned: true,
      // The compensated salvage transaction has already settled the wreck or
      // replacement container in inventory. Generic scene persistence would
      // otherwise try to update a removed wreck and report ITEM_NOT_FOUND.
      persistSpaceState: false,
    }),
    "DYNAMIC_ENTITY_REMOVE_FAILED",
  );
}

function syncInventoryChangesToSession(session, changes = [], callbacks = {}) {
  if (!session || !Array.isArray(changes) || changes.length <= 0) {
    return;
  }
  if (callbacks && typeof callbacks.syncInventoryChangesToSession === "function") {
    callbacks.syncInventoryChangesToSession(session, changes);
  }
}

function resolveInventorySession(entity, callbacks = {}) {
  if (callbacks && typeof callbacks.resolveSession === "function") {
    return callbacks.resolveSession(entity) || null;
  }
  return entity && entity.session ? entity.session : null;
}

function notifySalvageResult(session, targetEntity, message, rewards = []) {
  if (!session || typeof session.sendNotification !== "function") {
    return;
  }
  const entries = message === "CustomNotify"
    ? [["notify", rewards.length === 0
      ? "Salvaging succeeded, but nothing of value was found."
      : `Salvaging succeeded. Recovered ${rewards.map((entry) => {
      const type = resolveItemByTypeID(entry.itemType);
      return `${entry.quantity} x ${type ? type.name : entry.itemType}`;
    }).join(", ")} and placed it in your cargo hold.`]]
    : [
      ["itemID", targetEntity.itemID],
      ["type", [4, targetEntity.typeID]],
    ];
  session.sendNotification("OnRemoteMessage", "clientID", [
    message,
    { type: "dict", entries },
  ]);
}

function syncSalvageRewardsToSession(session, shipID, changes) {
  if (!session || changes.length === 0) {
    return;
  }
  // Match the cargo delivery protocol used by mining: the plural event and
  // ShipCargo context refresh the open inventory and its count/value footer.
  const { emitItemsChangedForSession } = require("../../services/character/characterState");
  for (const change of changes) {
    emitItemsChangedForSession(
      session,
      change.item,
      change.previousData || change.previousState || {},
      { locationContext: ["Ship", shipID, "ShipCargo"] },
    );
  }
}

function executeSalvagerCycle({
  scene,
  entity,
  effectState,
  nowMs = Date.now(),
  callbacks = {},
} = {}) {
  if (!scene || !entity || !effectState) {
    return { success: false, stopReason: "module" };
  }
  const targetID = toPositiveInt(effectState.targetID, 0);
  const targetEntity = scene.getEntityByID(targetID);
  if (
    !isSalvageableTarget(targetEntity) ||
    !canEntitiesInteractLocally(entity, targetEntity)
  ) {
    return { success: false, stopReason: "target" };
  }
  if (
    callbacks.isEntityLockedTarget &&
    !callbacks.isEntityLockedTarget(entity, targetID)
  ) {
    return { success: false, stopReason: "target" };
  }
  const surfaceDistance = callbacks.getEntitySurfaceDistance
    ? callbacks.getEntitySurfaceDistance(entity, targetEntity)
    : getSurfaceDistance(entity, targetEntity);
  if (surfaceDistance > Math.max(0, toFiniteNumber(effectState.salvagerRangeMeters, 0)) + 1) {
    return { success: false, stopReason: "range" };
  }

  const chancePercent = Math.max(0, toFiniteNumber(effectState.salvageChancePercent, 0));
  const messageSession = callbacks.suppressSalvageMessages === true
    ? null
    : resolveInventorySession(entity, callbacks);
  const rollPercent = getRandom(callbacks) * 100;
  if (rollPercent >= chancePercent) {
    notifySalvageResult(
      messageSession, targetEntity, "SalvagingFailure",
    );
    return {
      success: true,
      data: {
        targetID,
        salvaged: false,
        chancePercent,
        rollPercent: roundNumber(rollPercent, 6),
      },
    };
  }

  const characterID = resolveCharacterID(entity, callbacks);
  const shipItem = callbacks.getEntityRuntimeShipItem
    ? callbacks.getEntityRuntimeShipItem(entity)
    : null;
  if (characterID <= 0 || !shipItem) {
    return { success: false, stopReason: "cargo" };
  }

  const fittedItems = callbacks.getEntityRuntimeFittedItems
    ? callbacks.getEntityRuntimeFittedItems(entity)
    : [];
  const skillMap = callbacks.getEntityRuntimeSkillMap
    ? callbacks.getEntityRuntimeSkillMap(entity)
    : null;
  const rewardEntries = buildSalvageRewardEntries(targetEntity, {
    callbacks,
  });
  const rewardVolume = roundNumber(computeGrantVolume(rewardEntries), 6);
  // Drones carry the recovered items home before depositing them in ship cargo.
  // Their inventory rows participate in the same rollback as module rewards.
  const shipID = toPositiveInt(shipItem.itemID, toPositiveInt(entity && entity.itemID, 0));
  const rewardLocationID = toPositiveInt(callbacks.salvageRewardLocationID, shipID);
  const cargoSnapshot = rewardLocationID === shipID
    ? resolveCargoSnapshot(characterID, shipItem, fittedItems, skillMap)
    : null;
  if (rewardLocationID === shipID &&
      (!cargoSnapshot || rewardVolume > cargoSnapshot.availableVolume + 1e-6)) {
    return {
      success: false,
      stopReason: "cargo",
      data: {
        requiredVolume: rewardVolume,
        availableVolume: cargoSnapshot ? cargoSnapshot.availableVolume : 0,
      },
    };
  }

  const completionResult = completeSuccessfulSalvage(scene, targetEntity, nowMs, callbacks);
  if (!completionResult.success) {
    const rollbackResult = compensateSalvageCompletion(completionResult);
    if (!rollbackResult.success) {
      log.error(
        `[SalvagerRuntime] failed to compensate incomplete salvage target=${targetID}: ` +
          rollbackResult.errorMsg,
      );
    }
    return {
      success: false,
      stopReason: "target",
      data: rollbackResult.success
        ? undefined
        : { rollbackErrorMsg: rollbackResult.errorMsg },
    };
  }

  // Rewards are deliberately granted only after the wreck replacement/removal
  // reached its authoritative store boundary. They remain part of the same
  // compensated saga: a failed grant, scene spawn, or scene removal restores
  // the original wreck and all of its contents before the cycle may be retried.
  let grantChanges = [];
  if (rewardEntries.length > 0) {
    const grantResult = callSalvageMutationSafely(
      () => grantItemsToCharacterLocation(
        characterID,
        rewardLocationID,
        ITEM_FLAGS.CARGO_HOLD,
        rewardEntries,
      ),
      "SALVAGE_REWARD_GRANT_FAILED",
    );
    if (!grantResult.success || !grantResult.data) {
      const rollbackResult = compensateSalvageCompletion(completionResult);
      if (!rollbackResult.success) {
        log.error(
          `[SalvagerRuntime] failed to compensate salvage reward target=${targetID}: ` +
            rollbackResult.errorMsg,
        );
      }
      return {
        success: false,
        stopReason: "cargo",
        data: rollbackResult.success
          ? undefined
          : { rollbackErrorMsg: rollbackResult.errorMsg },
      };
    }
    grantChanges = grantResult.data.changes || [];
  }

  let replacementSpawned = false;
  if (completionResult.container) {
    const spawnResult = callSalvageMutationSafely(
      () => syncSpawnedLootContainer(
        scene,
        completionResult.container,
        callbacks,
      ),
      "CONTAINER_SPAWN_FAILED",
    );
    if (!spawnResult || spawnResult.success !== true) {
      const rollbackResult = compensateSalvageCompletion(
        completionResult,
        grantChanges,
      );
      if (!rollbackResult.success) {
        log.error(
          `[SalvagerRuntime] failed to compensate container spawn target=${targetID}: ` +
            rollbackResult.errorMsg,
        );
      }
      return {
        success: false,
        stopReason: "target",
        data: rollbackResult.success
          ? undefined
          : { rollbackErrorMsg: rollbackResult.errorMsg },
      };
    }
    replacementSpawned = true;
  }

  let topologyRollbackErrorMsg = null;
  const sceneRemoveResult = removeSalvageSceneEntity(scene, targetID);
  if (sceneRemoveResult && sceneRemoveResult.success === false) {
    const replacementCleanupResult = replacementSpawned
      ? removeSalvageSceneEntity(scene, completionResult.containerID)
      : { success: true };
    if (!replacementCleanupResult || replacementCleanupResult.success !== true) {
      // The replacement is still a live scene entity backed by the already
      // committed container row. Rolling inventory back now would orphan that
      // ball and make a retry duplicate both cargo and reward. Try once more to
      // settle toward the committed replacement topology. If the old wreck
      // still refuses removal, make it inert and surface a hard rollback error;
      // custody remains authoritative for the replacement that is still live.
      const settleOriginalResult = removeSalvageSceneEntity(scene, targetID);
      if (!settleOriginalResult || settleOriginalResult.success !== true) {
        targetEntity.salvaged = true;
        targetEntity.salvageComplete = true;
        topologyRollbackErrorMsg =
          replacementCleanupResult && replacementCleanupResult.errorMsg ||
          "SALVAGE_SCENE_ROLLBACK_FAILED";
        log.error(
          `[SalvagerRuntime] retained committed salvage after scene rollback failure ` +
            `target=${targetID} container=${completionResult.containerID}: ` +
            topologyRollbackErrorMsg,
        );
      }
    } else {
      const rollbackResult = compensateSalvageCompletion(
        completionResult,
        grantChanges,
      );
      if (!rollbackResult.success) {
        log.error(
          `[SalvagerRuntime] failed to compensate scene removal target=${targetID}: ` +
            rollbackResult.errorMsg,
        );
      }
      return {
        success: false,
        stopReason: "target",
        data: rollbackResult.success
          ? undefined
          : { rollbackErrorMsg: rollbackResult.errorMsg },
      };
    }
  }

  syncSalvageRewardsToSession(
    rewardLocationID === shipID ? resolveInventorySession(entity, callbacks) : null,
    shipID,
    grantChanges,
  );
  syncInventoryChangesToSession(
    resolveInventorySession(entity, callbacks),
    completionResult.changes || [],
    callbacks,
  );

  notifySalvageResult(
    messageSession,
    targetEntity,
    "CustomNotify",
    rewardEntries,
  );

  if (callbacks && typeof callbacks.onWreckSalvaged === "function") {
    callbacks.onWreckSalvaged({
      scene,
      sourceEntity: entity,
      targetEntity,
      targetID,
      characterID,
      moduleID: toPositiveInt(effectState.moduleID, 0),
      moduleTypeID: toPositiveInt(effectState.typeID, 0),
      rewards: cloneValue(rewardEntries),
      nowMs,
    });
  }

  if (targetEntity.homefrontRole === "salvage") {
    require("../../services/homefront/homefrontHooks").runtime.objectiveEvent(
      scene,
      targetEntity,
      characterID,
      "salvage",
      1,
      nowMs,
    );
  }
  // Advance the "Salvage N Wrecks" AIR daily goal on each successful salvage
  // (covers both salvager modules and salvage drones, which share this cycle).
  // Defensive so daily-goal bookkeeping can never disrupt salvaging.
  try {
    require(path.join(
      __dirname,
      "../../services/dailyGoals/dailyGoalsState",
    )).recordActivity(characterID, "salvage_wreck", 1);
  } catch (dailyGoalError) {
    log.debug(
      `[SalvagerRuntime] daily-goal salvage_wreck hook failed char=${characterID}: ${dailyGoalError.message}`,
    );
  }

  return {
    success: false,
    stopReason: "target",
    data: {
      targetID,
      salvaged: true,
      rewards: rewardEntries,
      chancePercent,
      rollPercent: roundNumber(rollPercent, 6),
      emptyReward: rewardEntries.length === 0,
      containerID: toPositiveInt(completionResult.containerID, 0) || null,
      ...(topologyRollbackErrorMsg
        ? {
          rollbackErrorMsg: topologyRollbackErrorMsg,
          authoritativeReplacementRetained: true,
        }
        : {}),
    },
  };
}

module.exports = {
  EFFECT_SALVAGING,
  EFFECT_SALVAGE_DRONE,
  HARVEST_SALVAGING,
  isSalvagingEffectRecord,
  isModuleSalvagingEffectRecord,
  isSalvageableTarget,
  buildSalvageChanceSnapshot,
  resolveSalvagerActivation,
  executeSalvagerCycle,
  _testing: {
    calculateSalvageChancePercent,
    buildSalvageChanceSnapshot,
    buildSalvageRewardEntries,
    classifyWreckFaction,
    computeGrantVolume,
    buildReplacementContainerLootCustomInfo,
    resolveAccessDifficultyBase,
    resolveEntitySize,
    isInventoryItemMarkedSalvaged,
  },
};
