"use strict";

const {
  round6,
  toFiniteNumber,
  toInt,
} = require("../../common/numbers");

const path = require("path");
const NodeModule = require("node:module");

const log = require(path.join(__dirname, "../../utils/logger"));
const {
  getAttributeIDByNames,
  getDynamicItemAttributeOverrides,
  getEffectTypeRecord,
  getLoadedChargeByFlag,
  getFittedModuleItems,
  getTypeEffectRecords,
} = require(path.join(__dirname, "../fitting/liveFittingState"));
const {
  getCachedCharacterSkillMap,
  getSkillMutationVersion,
} = require(path.join(__dirname, "../skills/skillState"));
const {
  getExpertSystemMutationVersion,
} = require(path.join(__dirname, "../skills/expertSystems/expertSystemState"));
const {
  getDogmaInvalidationVersion,
} = require(path.join(__dirname, "../character/dogmaInvalidationVersion"));
const {
  findItemById,
  findShipItemById,
} = require(path.join(__dirname, "../inventory/simulationInventoryProjection"));
const {
  resolveItemByTypeID,
} = require(path.join(__dirname, "../inventory/itemTypeRegistry"));
const {
  buildLocationModifiedAttributeMap,
  collectShipModifierAttributes,
} = require(path.join(__dirname, "../../space/combat/weaponDogma"));
const {
  getLocationModifierSourcesForSystem,
} = require(path.join(
  __dirname,
  "../exploration/wormholes/wormholeEnvironmentRuntime",
));
const {
  getActiveImplants,
  getActiveBoosters,
  getActiveImplantLocationModifierSources,
  getActiveImplantSourceStates,
  getActiveImplantShipModifierEntries,
} = require(path.join(__dirname, "../dogma/implants/activeImplantModifiers"));

const ATTRIBUTE_SPEED = getAttributeIDByNames("speed") || 51;
const ATTRIBUTE_DURATION = getAttributeIDByNames("duration") || 73;
const ATTRIBUTE_MAX_RANGE = getAttributeIDByNames("maxRange") || 54;
const ATTRIBUTE_FALLOFF = getAttributeIDByNames("falloff") || 158;
const ATTRIBUTE_TRACKING_SPEED = getAttributeIDByNames("trackingSpeed") || 160;
const ATTRIBUTE_OPTIMAL_SIG_RADIUS = getAttributeIDByNames("optimalSigRadius") || 620;
const ATTRIBUTE_SIGNATURE_RADIUS = getAttributeIDByNames("signatureRadius") || 552;
const ATTRIBUTE_ECM_JAM_DURATION = getAttributeIDByNames("ecmJamDuration") || 2822;
const ATTRIBUTE_SCAN_GRAVIMETRIC_STRENGTH_BONUS =
  getAttributeIDByNames("scanGravimetricStrengthBonus") || 238;
const ATTRIBUTE_SCAN_LADAR_STRENGTH_BONUS =
  getAttributeIDByNames("scanLadarStrengthBonus") || 239;
const ATTRIBUTE_SCAN_MAGNETOMETRIC_STRENGTH_BONUS =
  getAttributeIDByNames("scanMagnetometricStrengthBonus") || 240;
const ATTRIBUTE_SCAN_RADAR_STRENGTH_BONUS =
  getAttributeIDByNames("scanRadarStrengthBonus") || 241;
const ATTRIBUTE_DAMAGE_MULTIPLIER = getAttributeIDByNames("damageMultiplier") || 64;
const ATTRIBUTE_EM_DAMAGE = getAttributeIDByNames("emDamage") || 114;
const ATTRIBUTE_EXPLOSIVE_DAMAGE = getAttributeIDByNames("explosiveDamage") || 116;
const ATTRIBUTE_KINETIC_DAMAGE = getAttributeIDByNames("kineticDamage") || 117;
const ATTRIBUTE_THERMAL_DAMAGE = getAttributeIDByNames("thermalDamage") || 118;
const ATTRIBUTE_ENTITY_FLY_RANGE = getAttributeIDByNames("entityFlyRange") || 416;
const ATTRIBUTE_ENTITY_ATTACK_RANGE = getAttributeIDByNames("entityAttackRange") || 72;
const ATTRIBUTE_ENTITY_CHASE_MAX_DISTANCE =
  getAttributeIDByNames("entityChaseMaxDistance") || 665;
const ATTRIBUTE_ORBIT_RANGE = getAttributeIDByNames("orbitRange") || 157;
const ATTRIBUTE_WARP_SCRAMBLE_STATUS = getAttributeIDByNames("warpScrambleStatus") || 104;
const ATTRIBUTE_MINING_AMOUNT = getAttributeIDByNames("miningAmount") || 77;
// Residue. The name lookup is what resolves these; the numeric fallbacks are the
// IDs the SDE actually uses (3153/3154), NOT the 2865/2864 pair the mining
// module path falls back to -- those are stale there and must not be copied.
const ATTRIBUTE_MINING_WASTE_MULTIPLIER =
  getAttributeIDByNames("miningWastedVolumeMultiplier") || 3153;
const ATTRIBUTE_MINING_WASTE_PROBABILITY =
  getAttributeIDByNames("miningWasteProbability") || 3154;
const ATTRIBUTE_ACCESS_DIFFICULTY_BONUS =
  getAttributeIDByNames("accessDifficultyBonus") || 902;
const ATTRIBUTE_SHIELD_BONUS = getAttributeIDByNames("shieldBonus") || 68;
const ATTRIBUTE_ARMOR_DAMAGE_AMOUNT =
  getAttributeIDByNames("armorDamageAmount") || 84;
const ATTRIBUTE_STRUCTURE_DAMAGE_AMOUNT =
  getAttributeIDByNames("structureDamageAmount") || 83;

// Mirrors DRONE_CATEGORY_ID / ITEM_FLAGS.DRONE_BAY in
// simulationInventoryProjection / itemStore; duplicated here to keep this
// tick-path module free of their heavier import graphs.
const DRONE_CATEGORY_ID = 18;
const DRONE_BAY_FLAG_ID = 87;

const COMBAT_EFFECT_NAMES = new Set(["targetattack"]);
const ECM_EFFECT_NAMES = new Set(["entityecmfalloff"]);
const MINING_EFFECT_NAMES = new Set(["mining", "miningclouds"]);
const SALVAGE_EFFECT_NAMES = new Set(["salvagedroneeffect"]);
const REPAIR_EFFECT_DEFINITIONS = Object.freeze({
  npcentityremoteshieldbooster: Object.freeze({
    family: "remoteShield",
    amountAttributeID: ATTRIBUTE_SHIELD_BONUS,
  }),
  npcentityremotearmorrepairer: Object.freeze({
    family: "remoteArmor",
    amountAttributeID: ATTRIBUTE_ARMOR_DAMAGE_AMOUNT,
  }),
  npcentityremotehullrepairer: Object.freeze({
    family: "remoteHull",
    amountAttributeID: ATTRIBUTE_STRUCTURE_DAMAGE_AMOUNT,
  }),
  targetarmorrepair: Object.freeze({
    family: "remoteArmor",
    amountAttributeID: ATTRIBUTE_ARMOR_DAMAGE_AMOUNT,
  }),
});

function firstPositiveInt(...values) {
  for (const value of values) {
    const numeric = toInt(value, 0);
    if (numeric > 0) {
      return numeric;
    }
  }
  return 0;
}

function resolveDroneOrbitAttribute(attributes, droneItem, fallbackValue) {
  const itemOverrides = getDynamicItemAttributeOverrides(droneItem);
  if (
    Object.prototype.hasOwnProperty.call(
      itemOverrides,
      ATTRIBUTE_ENTITY_FLY_RANGE,
    )
  ) {
    return toFiniteNumber(attributes[ATTRIBUTE_ENTITY_FLY_RANGE], fallbackValue);
  }
  if (
    Object.prototype.hasOwnProperty.call(itemOverrides, ATTRIBUTE_ORBIT_RANGE) &&
    toFiniteNumber(attributes[ATTRIBUTE_ORBIT_RANGE], 0) > 0
  ) {
    return toFiniteNumber(attributes[ATTRIBUTE_ORBIT_RANGE], fallbackValue);
  }
  return toFiniteNumber(
    attributes[ATTRIBUTE_ENTITY_FLY_RANGE],
    toFiniteNumber(attributes[ATTRIBUTE_ORBIT_RANGE], fallbackValue),
  );
}

function buildDamageVector(attributes = {}) {
  return {
    em: Math.max(0, round6(toFiniteNumber(attributes[ATTRIBUTE_EM_DAMAGE], 0))),
    thermal: Math.max(0, round6(toFiniteNumber(attributes[ATTRIBUTE_THERMAL_DAMAGE], 0))),
    kinetic: Math.max(0, round6(toFiniteNumber(attributes[ATTRIBUTE_KINETIC_DAMAGE], 0))),
    explosive: Math.max(0, round6(toFiniteNumber(attributes[ATTRIBUTE_EXPLOSIVE_DAMAGE], 0))),
  };
}

function fingerprintText(value) {
  const text = String(value || "");
  if (!text) {
    return "";
  }
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${text.length}:${hash.toString(36)}`;
}

function collectControllerAbyssalLocationModifierSources(controllerEntity) {
  if (!controllerEntity || typeof controllerEntity !== "object") {
    return [];
  }
  try {
    // Lazy to avoid activity-service -> drone-runtime -> drone-dogma load cycles.
    const abyssalMgrService = require("../../abyssal").weatherPolicy;
    return typeof abyssalMgrService.collectAbyssalLocationModifierSourcesForEntity === "function"
      ? abyssalMgrService.collectAbyssalLocationModifierSourcesForEntity(
        controllerEntity,
      )
      : [];
  } catch (_) {
    // ignored: the Abyssal weather policy is not loaded in this process; no location modifiers
    return [];
  }
}

function resolveDroneDogmaItem(droneEntity) {
  if (!droneEntity) {
    return null;
  }

  const itemID = firstPositiveInt(droneEntity.itemID);
  const storedItem = itemID > 0 ? findItemById(itemID) : null;
  const typeID = firstPositiveInt(
    droneEntity.typeID,
    storedItem && storedItem.typeID,
  );
  if (typeID <= 0) {
    return null;
  }

  const customInfo =
    droneEntity.customInfo !== undefined &&
    droneEntity.customInfo !== null &&
    String(droneEntity.customInfo || "") !== ""
      ? String(droneEntity.customInfo || "")
      : String((storedItem && storedItem.customInfo) || "");

  return {
    ...(storedItem || {}),
    itemID,
    typeID,
    groupID: firstPositiveInt(
      droneEntity.groupID,
      storedItem && storedItem.groupID,
    ),
    categoryID: firstPositiveInt(
      droneEntity.categoryID,
      storedItem && storedItem.categoryID,
    ),
    ownerID: firstPositiveInt(
      droneEntity.ownerID,
      storedItem && storedItem.ownerID,
    ),
    locationID: firstPositiveInt(
      droneEntity.locationID,
      storedItem && storedItem.locationID,
      droneEntity.systemID,
    ),
    flagID:
      droneEntity.flagID !== undefined && droneEntity.flagID !== null
        ? toInt(droneEntity.flagID, 0)
        : toInt(storedItem && storedItem.flagID, 0),
    singleton:
      droneEntity.singleton !== undefined && droneEntity.singleton !== null
        ? toInt(droneEntity.singleton, 1)
        : toInt(storedItem && storedItem.singleton, 1),
    quantity:
      droneEntity.quantity !== undefined && droneEntity.quantity !== null
        ? droneEntity.quantity
        : storedItem && storedItem.quantity !== undefined
          ? storedItem.quantity
          : 1,
    stacksize:
      droneEntity.stacksize !== undefined && droneEntity.stacksize !== null
        ? droneEntity.stacksize
        : storedItem && storedItem.stacksize !== undefined
          ? storedItem.stacksize
          : 1,
    customInfo,
  };
}

function buildDroneSnapshotCacheKey(droneEntity, droneItem = null) {
  const resolvedItem = droneItem || resolveDroneDogmaItem(droneEntity);
  const typeID = firstPositiveInt(
    resolvedItem && resolvedItem.typeID,
    droneEntity && droneEntity.typeID,
  );
  const itemID = firstPositiveInt(
    resolvedItem && resolvedItem.itemID,
    droneEntity && droneEntity.itemID,
  );
  const customInfo = String(
    (resolvedItem && resolvedItem.customInfo) ||
      (droneEntity && droneEntity.customInfo) ||
      "",
  );
  if (itemID > 0) {
    // Do NOT embed the global itemMutationVersion: the enclosing controller
    // context (and its miningByTypeID/operationalByTypeID) is invalidated by the
    // cross-tick dogma fingerprint on any real dogma change, and customInfo
    // captures in-place drone (mutaplasmid) mutation. The global counter is bumped
    // EVERY tick by routine drone-state persistence, which would thrash this
    // per-drone snapshot cache.
    return `item:${itemID}:${typeID}:${fingerprintText(customInfo)}`;
  }
  return `type:${typeID}:${fingerprintText(customInfo)}`;
}

function sumDamageVector(vector = {}) {
  return round6(
    Math.max(0, toFiniteNumber(vector.em, 0)) +
      Math.max(0, toFiniteNumber(vector.thermal, 0)) +
      Math.max(0, toFiniteNumber(vector.kinetic, 0)) +
      Math.max(0, toFiniteNumber(vector.explosive, 0)),
  );
}

// Lazy require: a top-level require of characterState introduces a load-order
// cycle (characterState -> ... -> droneDogma) that leaves sibling modules with
// partial exports. Resolve it on first use and memoize the reference.
let cachedPeekCharacterRecord = null;
function peekCharacterRecord(charId) {
  if (!cachedPeekCharacterRecord) {
    cachedPeekCharacterRecord = require(path.join(
      __dirname,
      "../character/characterState",
    )).peekCharacterRecord;
  }
  return cachedPeekCharacterRecord(charId);
}

function buildControllerDogmaFingerprint(
  controllerEntity,
  fittedItems = [],
  options = {},
) {
  const shipID = toInt(controllerEntity && controllerEntity.itemID, 0);
  const controllerOwnerID = toInt(
    controllerEntity &&
      (
        controllerEntity.session && controllerEntity.session.characterID
      ) ||
      controllerEntity &&
      (
        controllerEntity.pilotCharacterID ??
        controllerEntity.characterID ??
        controllerEntity.ownerID
      ),
    0,
  );
  const systemID = toInt(controllerEntity && controllerEntity.systemID, 0);
  // Read-only raw record reference (no clone). Handed as an OBJECT,
  // getActiveImplants/getActiveBoosters skip the getCharacterRecord clone+
  // serialize that otherwise ran twice per controller per tick just to build this
  // identity key — the record's array-shaped implants/boosters yield the same IDs.
  const controllerCharacterRecord =
    controllerOwnerID > 0 ? peekCharacterRecord(controllerOwnerID) : null;
  const activeEffectFingerprint =
    controllerEntity && controllerEntity.activeModuleEffects instanceof Map
      ? [...controllerEntity.activeModuleEffects.values()]
        .filter(Boolean)
        .map((effectState) => (
          `${toInt(effectState && effectState.moduleID, 0)}:` +
          `${toInt(effectState && effectState.effectID, 0)}:` +
          `${toInt(effectState && effectState.chargeTypeID, 0)}`
        ))
        .sort()
        .join("|")
      : "";
  const activeImplantFingerprint =
    controllerOwnerID > 0
      // Identity only (slot:typeID) — use getActiveImplants, NOT
      // getActiveImplantSourceStates, which deep-clones attribute maps and runs
      // an O(n^2) implant dogma resolution just to build this cache key (~15ms).
      ? getActiveImplants(controllerCharacterRecord)
        .map((implant) => `${toInt(implant && implant.slot, 0)}:${toInt(implant && implant.typeID, 0)}`)
        .join(",")
      : "";
  // CROSS-TICK fingerprint: key on dogma-scoped + skill/expert version counters
  // (stable across ticks; bumped only on a real refit/skill/implant/booster
  // change) instead of the global itemMutationVersion that routine item writes
  // (drone state persistence!) would thrash. Fitted-item IDENTITIES catch
  // fit/unfit; activeEffects catch online/charge; implants and boosters are
  // captured by identity. Known gap: in-place mutaplasmid mutation of a fitted
  // module (rare).
  const fittedIdentityFingerprint = fittedItems
    .map((item) => `${toInt(item && item.itemID, 0)}:${toInt(item && item.flagID, 0)}:${toInt(item && item.typeID, 0)}`)
    .join("|");
  // Booster identity (typeID:slot). getActiveBoosters filters wall-clock-expired
  // boosters, so this changes both on inject AND when a booster expires — closing
  // the booster gap without a discrete expiry hook.
  const activeBoosterFingerprint =
    controllerOwnerID > 0
      ? getActiveBoosters(controllerCharacterRecord)
        .map((booster) => `${toInt(booster && booster.typeID, 0)}:${toInt(booster && booster.slot, 0)}`)
        .join(",")
      : "";
  const abyssalLocationModifierFingerprint = fingerprintText(
    JSON.stringify(
      Array.isArray(options.abyssalLocationModifierSources)
        ? options.abyssalLocationModifierSources
        : [],
    ),
  );
  return [
    "v3",
    getDogmaInvalidationVersion(),
    getSkillMutationVersion(),
    getExpertSystemMutationVersion(),
    systemID,
    fittedIdentityFingerprint,
    activeEffectFingerprint,
    activeImplantFingerprint,
    activeBoosterFingerprint,
    abyssalLocationModifierFingerprint,
    require("../incursion/incursionSystemEffects").damageMultiplier(
      { kind: "drone", ownerID: controllerOwnerID, systemID }, "drone", systemID),
  ].join("#");
}

function buildActiveModuleContexts(controllerEntity, fittedItems = [], characterID = 0) {
  if (!controllerEntity || !(controllerEntity.activeModuleEffects instanceof Map)) {
    return [];
  }

  return [...controllerEntity.activeModuleEffects.values()]
    .filter(Boolean)
    .map((effectState) => {
      const moduleItem = fittedItems.find((item) => (
        toInt(item && item.itemID, 0) === toInt(effectState && effectState.moduleID, 0) ||
        (
          toInt(effectState && effectState.moduleFlagID, 0) > 0 &&
          toInt(item && item.flagID, 0) === toInt(effectState && effectState.moduleFlagID, 0)
        )
      )) || null;
      if (!moduleItem) {
        return null;
      }

      return {
        effectState,
        effectRecord: getEffectTypeRecord(toInt(effectState && effectState.effectID, 0)),
        moduleItem,
        chargeItem:
          characterID > 0 && toInt(moduleItem && moduleItem.flagID, 0) > 0
            ? getLoadedChargeByFlag(
              characterID,
              toInt(controllerEntity && controllerEntity.itemID, 0),
              toInt(moduleItem && moduleItem.flagID, 0),
            )
            : null,
      };
    })
    .filter((entry) => entry && entry.effectRecord && entry.moduleItem);
}

// Monotonic per-tick stamp + an "inside the drone tick" flag.
let dogmaTickEpoch = 0;
let dogmaTickActive = false;

// During a drone tickScene the controller's fitting/skills are invariant, but
// item writes (drone state persistence) bump the GLOBAL itemMutationVersion that
// the dogma fingerprint embeds — so the cross-tick context cache misses on every
// drone, forcing a full ship-dogma rebuild (incl. a ~12ms skill-map deep clone)
// per drone per tick. beginDogmaTick/endDogmaTick bracket the synchronous tick so
// getControllerDogmaContext can memo the context for the whole tick, and fall
// back to the normal fingerprint cache between ticks. The epoch is MONOTONIC (a
// fresh value each tick) so the memo only matches within the tick it was stamped
// in — the context is still recomputed/re-validated once per tick, catching
// refits and skill changes; it just dedupes the ~15 redundant resolves per tick.
function beginDogmaTick() {
  dogmaTickEpoch += 1;
  dogmaTickActive = true;
}

function endDogmaTick() {
  dogmaTickActive = false;
}

// Notified whenever a controller's drone stat cache is REBUILT because its
// fingerprint changed (refit, module on/off, implant, booster, system, or a
// server-wide dogma/skill version bump). The FIRST build — when drones
// launch — does not notify: the launch primes already advertise the bonused
// values. Registered by droneRuntime, which owns the client push; kept as a
// callback so this module stays out of the droneRuntime require cycle.
let controllerDogmaCacheRebuiltHandler = null;
function setControllerDogmaCacheRebuiltHandler(handler) {
  controllerDogmaCacheRebuiltHandler = typeof handler === "function" ? handler : null;
}

// Ship-derived changes must also reach idle drones, which do not resolve stats
// during their normal ticks. Keep ships without a drone cache on the cheap path.
function refreshControllerDroneDogma(controllerEntity) {
  if (controllerEntity && controllerEntity.droneDogmaCache) {
    getControllerDogmaContext(controllerEntity, { validateWithinTick: true });
  }
}

function getControllerDogmaContext(controllerEntity, options = {}) {
  const controllerShipID = toInt(controllerEntity && controllerEntity.itemID, 0);
  if (controllerShipID <= 0) {
    return null;
  }

  if (
    options.validateWithinTick !== true &&
    dogmaTickActive &&
    controllerEntity &&
    controllerEntity.droneDogmaCache &&
    controllerEntity.droneDogmaCache.dogmaTickEpoch === dogmaTickEpoch
  ) {
    return controllerEntity.droneDogmaCache;
  }

  const controllerOwnerID = toInt(
    controllerEntity &&
      (
        controllerEntity.session && controllerEntity.session.characterID
      ) ||
      controllerEntity &&
      (
        controllerEntity.pilotCharacterID ??
        controllerEntity.characterID ??
        controllerEntity.ownerID
      ),
    0,
  );
  // Living Universe: a native NPC hull has no inventory row, fitted items or
  // character skills in the item store; its drones read them from the entity.
  const nativeNpcController = Boolean(
    controllerEntity && controllerEntity.nativeNpc === true,
  );
  const shipItem =
    findShipItemById(controllerShipID) ||
    findItemById(controllerShipID) ||
    (nativeNpcController
      ? {
          itemID: controllerShipID,
          typeID: toInt(controllerEntity.typeID, 0),
          groupID: toInt(controllerEntity.groupID, 0),
          categoryID: toInt(controllerEntity.categoryID, 6),
          itemName: String(
            controllerEntity.itemName || "NPC drone controller",
          ),
          ownerID: controllerOwnerID,
        }
      : null);
  if (!shipItem) {
    return null;
  }

  const fittedItems =
    nativeNpcController && Array.isArray(controllerEntity.fittedItems)
      ? controllerEntity.fittedItems
      : controllerOwnerID > 0
      ? getFittedModuleItems(controllerOwnerID, controllerShipID)
      : [];
  const abyssalLocationModifierSources =
    collectControllerAbyssalLocationModifierSources(controllerEntity);
  const fingerprint = buildControllerDogmaFingerprint(
    controllerEntity,
    fittedItems,
    { abyssalLocationModifierSources },
  );
  const cached =
    controllerEntity &&
    controllerEntity.droneDogmaCache &&
    controllerEntity.droneDogmaCache.fingerprint === fingerprint
      ? controllerEntity.droneDogmaCache
      : null;
  if (cached) {
    cached.dogmaTickEpoch = dogmaTickEpoch;
    return cached;
  }

  const skillMap =
    nativeNpcController && controllerEntity.skillMap instanceof Map // Living Universe
      ? controllerEntity.skillMap
      : controllerOwnerID > 0
      ? getCachedCharacterSkillMap(controllerOwnerID)
      : new Map();
  const activeModuleContexts = buildActiveModuleContexts(
    controllerEntity,
    fittedItems,
    controllerOwnerID,
  );
  const implantShipModifierEntries =
    controllerOwnerID > 0 ? getActiveImplantShipModifierEntries(controllerOwnerID) : [];
  const shipModifierAttributes = collectShipModifierAttributes(
    shipItem,
    skillMap,
    activeModuleContexts,
    {
      additionalDirectModifierEntries: implantShipModifierEntries,
    },
  );
  const additionalLocationModifierSources = [
    ...(controllerOwnerID > 0
      ? getActiveImplantLocationModifierSources(controllerOwnerID)
      : []),
    ...getLocationModifierSourcesForSystem(
      controllerEntity && controllerEntity.systemID,
    ),
    ...abyssalLocationModifierSources,
  ];
  const nextCache = {
    fingerprint,
    shipItem,
    skillMap,
    fittedItems,
    activeModuleContexts,
    shipModifierAttributes,
    additionalLocationModifierSources,
    combatByTypeID: new Map(),
    miningByTypeID: new Map(),
    salvageByTypeID: new Map(),
    repairByTypeID: new Map(),
    operationalByTypeID: new Map(),
  };
  nextCache.dogmaTickEpoch = dogmaTickEpoch;
  const previousCache = controllerEntity.droneDogmaCache || null;
  controllerEntity.droneDogmaCache = nextCache;
  if (previousCache && controllerDogmaCacheRebuiltHandler) {
    // The stat inputs changed since the last build. droneRuntime
    // re-advertises in-space drone dogma from this one notification, so a
    // change is paid once per ship instead of being swept per drone per tick.
    try {
      controllerDogmaCacheRebuiltHandler(controllerEntity);
    } catch (error) {
      // Display-only refresh; never break the tick/launch path it rides on,
      // but say so, or a broken refresh leaves launched-drone tooltips stale
      // with nothing in the logs.
      log.warn(
        `[DroneDogma] Drone tooltip refresh failed after a stat cache rebuild ` +
          `ship=${controllerShipID}: ${error && error.message || error || "UNKNOWN_ERROR"}`,
      );
    }
  }
  return nextCache;
}

function resolveDroneEffectRecord(typeID, acceptedNames = new Set()) {
  for (const effectRecord of getTypeEffectRecords(typeID)) {
    const normalizedName = String(effectRecord && effectRecord.name || "").trim().toLowerCase();
    if (acceptedNames.has(normalizedName)) {
      return effectRecord;
    }
  }
  return null;
}

function resolveDroneRepairEffectRecord(typeID) {
  for (const effectRecord of getTypeEffectRecords(typeID)) {
    const normalizedName = String(effectRecord && effectRecord.name || "").trim().toLowerCase();
    if (REPAIR_EFFECT_DEFINITIONS[normalizedName]) {
      return {
        effectRecord,
        definition: REPAIR_EFFECT_DEFINITIONS[normalizedName],
      };
    }
  }
  return null;
}

function buildDroneOperationalAttributes(droneEntity, controllerEntity) {
  const context = getControllerDogmaContext(controllerEntity);
  if (!context || !droneEntity) {
    return null;
  }

  const droneItem = resolveDroneDogmaItem(droneEntity);
  if (!droneItem) {
    return null;
  }

  // Per-drone operational-attribute cache. The mining/combat/salvage snapshot
  // caches cover the YIELD path, but copyControllerIdentity ->
  // applyDroneOperationalEntityAttributes resolves the full drone attribute map
  // (mass/inertia/velocity) every tick on a path the snapshot caches never
  // touched — buildLocationModifiedAttributeMap was rebuilt per drone per tick.
  // Memoize it in the controller context (same lifetime/invalidation as the
  // snapshot caches): holds cross-tick when the context holds, deduped within a
  // tick otherwise. Keyed on the shared per-drone snapshot key so a refit/
  // mutaplasmid change still rebuilds.
  const cacheKey = buildDroneSnapshotCacheKey(droneEntity, droneItem);
  if (context.operationalByTypeID.has(cacheKey)) {
    return context.operationalByTypeID.get(cacheKey);
  }

  const attributes = buildLocationModifiedAttributeMap(
    droneItem,
    context.shipItem,
    context.skillMap,
    context.shipModifierAttributes,
    context.fittedItems,
    context.activeModuleContexts,
    {
      additionalLocationModifierSources: context.additionalLocationModifierSources,
      // A drone is the character's entity, not part of the ship's attribute
      // location: it takes `charID` modifiers and no `shipID` ones. Without
      // this, ship-MODULE skills that a drone happens to require leak in —
      // Signal Dispersion put +25 % on ECM drone jam strength, Mining +
      // Astrogeology +56 % on mining-drone yield, Salvaging +150 % on a
      // salvage drone's access bonus.
      ownedEntityTarget: true,
    },
  );
  if (!attributes || Object.keys(attributes).length === 0) {
    context.operationalByTypeID.set(cacheKey, null);
    return null;
  }
  const result = { context, attributes };
  context.operationalByTypeID.set(cacheKey, result);
  return result;
}

let homefrontModuleEntry = null;
let homefrontModuleLoader = null;
function resolveHomefrontForDroneWeather() {
  let filename = null;
  let loader = null;
  try {
    filename = path.join(__dirname, "../homefront/homefrontHooks.js");
    loader = NodeModule._load;
    const entry = NodeModule._cache[filename];
    if (typeof loader === "function" && loader === homefrontModuleLoader &&
        entry && entry === homefrontModuleEntry && entry.loaded === true) {
      return entry.exports;
    }
  } catch (_) {
    // Metadata is optional: the original require remains authoritative.
  }
  const homefront = require("../homefront/homefrontHooks");
  try {
    const entry = filename && NodeModule._cache[filename];
    if (typeof loader === "function" && NodeModule._load === loader && entry &&
        entry.loaded === true && entry.exports === homefront &&
        require.resolve("../homefront/homefrontHooks") === filename) {
      homefrontModuleEntry = entry;
      homefrontModuleLoader = loader;
    } else {
      homefrontModuleEntry = null;
      homefrontModuleLoader = null;
    }
  } catch (_) {
    homefrontModuleEntry = null;
    homefrontModuleLoader = null;
  }
  return homefront;
}

function resolveDroneOperationalAttributes(droneEntity, controllerEntity) {
  const operational = buildDroneOperationalAttributes(droneEntity, controllerEntity);
  if (!operational) return null;
  const modifiers = [
    ...resolveHomefrontForDroneWeather().weather.shipModifiers(droneEntity),
    ...require("../../space/modules/hostileModuleRuntime").collectModifierEntriesForTarget(droneEntity)
      // Keep point authority out of the deferred companion motion cache.
      .filter((entry) => entry.modifiedAttributeID !== ATTRIBUTE_WARP_SCRAMBLE_STATUS),
  ];
  if (!modifiers.length) return operational.attributes;
  // The controller caches a shared per-type base. Projected and environmental
  // modifiers are local to this drone and must never mutate that shared cache.
  const attributes = { ...operational.attributes };
  require("../fitting/liveFittingState").applyModifierGroups(attributes, modifiers);
  return attributes;
}

// ---------------------------------------------------------------------------
// Tooltip-grade drone attribute resolution
//
// A drone tooltip must show the operational (skill/ship/module-bonused) map
// whether the drone sits in a drone bay or is already launched into space.
// Both tooltip paths — dogma ItemGetInfo / QueryAllAttributes (dogmaService)
// and the OnGodmaPrimeItem pushes (invBrokerService, droneRuntime) — resolve
// through resolveDroneTooltipAttributes so they cannot drift. A launched
// drone item lives in the solar system (flagID 0, locationID = systemID) and
// names its controlling ship on launcherID, which is how the controller is
// found once the drone-bay flag no longer identifies it.
// ---------------------------------------------------------------------------

function isDroneCategoryItem(item) {
  if (!item) {
    return false;
  }
  const categoryID = toInt(item.categoryID, 0);
  if (categoryID > 0) {
    return categoryID === DRONE_CATEGORY_ID;
  }
  const typeID = toInt(item.typeID, 0);
  if (typeID <= 0) {
    return false;
  }
  const typeRecord = resolveItemByTypeID(typeID);
  return Boolean(
    typeRecord && toInt(typeRecord.categoryID, 0) === DRONE_CATEGORY_ID,
  );
}

let cachedSpaceRuntimeModule = null;
function getSpaceRuntimeModule() {
  if (!cachedSpaceRuntimeModule) {
    // Lazy: a top-level require of space/runtime here would drag the whole
    // scene machinery (and back into droneRuntime) into droneDogma's load
    // order before its own exports exist.
    cachedSpaceRuntimeModule = require(path.join(__dirname, "../../space/runtime"));
  }
  return cachedSpaceRuntimeModule;
}

function resolveSceneForSession(session) {
  if (!session) {
    return null;
  }
  const spaceRuntime = getSpaceRuntimeModule();
  if (!spaceRuntime || typeof spaceRuntime.getSceneForSession !== "function") {
    return null;
  }
  try {
    return spaceRuntime.getSceneForSession(session);
  } catch (error) {
    // ignored: a session whose scene cannot be read has no scene (null)
    return null;
  }
}

function resolveRuntimeControllerShipEntity(session, controllerShipID, options = {}) {
  if (toInt(controllerShipID, 0) <= 0) {
    return null;
  }
  if (
    options.controllerEntity &&
    toInt(options.controllerEntity.itemID, 0) === toInt(controllerShipID, 0)
  ) {
    return options.controllerEntity;
  }
  const scene = options.scene || resolveSceneForSession(session);
  if (!scene || typeof scene.getEntityByID !== "function") {
    return null;
  }
  const sceneEntity = scene.getEntityByID(controllerShipID);
  return sceneEntity && sceneEntity.kind === "ship" ? sceneEntity : null;
}

function resolveDroneTooltipAttributes(item, session = null, options = {}) {
  if (!item || !isDroneCategoryItem(item)) {
    return null;
  }

  const itemFlagID = toInt(item.flagID, 0);
  let controllerShipID = toInt(options.controllerShipID, 0);
  if (controllerShipID <= 0) {
    if (itemFlagID === DRONE_BAY_FLAG_ID) {
      controllerShipID = toInt(item.locationID, 0);
    } else if (itemFlagID === 0) {
      controllerShipID = toInt(item.launcherID, 0);
    }
  }
  if (controllerShipID <= 0) {
    return null;
  }

  const charID = firstPositiveInt(
    item.ownerID,
    options.characterID,
    session && (session.characterID ?? session.charid),
  );
  if (charID <= 0) {
    return null;
  }

  const shipItem =
    findShipItemById(controllerShipID) || findItemById(controllerShipID);
  if (!shipItem) {
    return null;
  }

  const runtimeShipEntity = resolveRuntimeControllerShipEntity(
    session,
    controllerShipID,
    options,
  );
  const systemID = firstPositiveInt(
    runtimeShipEntity && runtimeShipEntity.systemID,
    session && (
      session.solarsystemid2 ??
      session.solarsystemid ??
      (session._space && session._space.systemID)
    ),
    shipItem.spaceState && shipItem.spaceState.systemID,
  );
  // Resolve against the LIVE runtime ship when one exists: getControllerDogmaContext
  // stores its rebuilt context cache on the object it is handed, so a copy here
  // would make every drone re-resolve (and re-pay) the whole ship context. The
  // live entity is read as-is: a ship whose identity fields were empty would
  // resolve empty skills on the combat/mining snapshot paths too, and patching
  // identity here would make the tooltip diverge from the simulation.
  const controllerEntity = runtimeShipEntity || {
    // No live ship in space (pilot docked, item-query path): a synthetic
    // controller stands in. Its context cache is necessarily throwaway —
    // there is no live entity to hang it on — which this infrequent query
    // path already tolerated.
    kind: "ship",
    itemID: controllerShipID,
    typeID: toInt(shipItem.typeID, 0),
    ownerID: charID,
    characterID: charID,
    pilotCharacterID: charID,
    session: session || null,
    systemID,
    // Empty, never stale: without a live ship there are no running-module
    // projections to carry (the Industrial Core's charID-domain rows ride
    // the live entity's map instead).
    activeModuleEffects: new Map(),
  };
  const droneEntity = {
    ...item,
    ...(itemFlagID === 0
      ? (options.scene || resolveSceneForSession(session))?.getEntityByID(item.itemID)
      : null),
    kind: "drone",
    ownerID: charID,
    locationID: controllerShipID,
    systemID,
  };
  const attributes = resolveDroneOperationalAttributes(droneEntity, controllerEntity);
  if (!attributes || !runtimeShipEntity) return attributes;
  const multiplier = require("../incursion/incursionSystemEffects").damageMultiplier(droneEntity, "drone", systemID);
  return multiplier === 1 ? attributes : { ...attributes, [ATTRIBUTE_DAMAGE_MULTIPLIER]:
    toFiniteNumber(attributes[ATTRIBUTE_DAMAGE_MULTIPLIER], 1) * multiplier };
}

// Deterministic identity of a resolved tooltip attribute map. The push path
// compares this against what the client last received, so an irrelevant
// fingerprint change (another character's refit, a module with no drone
// modifiers cycling) costs one string compare and zero primes.
function buildDroneTooltipAttributeStamp(attributes) {
  if (!attributes) {
    return "";
  }
  const parts = [];
  for (const key of Object.keys(attributes).sort((a, b) => Number(a) - Number(b))) {
    const value = attributes[key];
    parts.push(
      key + ":" + (value === null || value === undefined ? "" : String(value)),
    );
  }
  return parts.join("|");
}

// The ECM half of a drone, in one place, so the pure-ECM drones and the faction
// hybrids that also carry `targetAttack` cannot drift apart.
//
// `entityECMFalloff` (6695) declares NO falloffAttributeID — despite the name —
// so a drone jam is a hard cutoff at `ECMRangeOptimal` (936), the same shape a
// burst jammer has. The two durations are genuinely different attributes:
// `ECMDuration` (929, 20 s) is the drone's own cycle, and `ecmJamDuration`
// (2822, 5 s) is how long the victim stays jammed. Strength comes from the four
// `scan*StrengthBonus` attributes (238-241), which every ECM drone declares
// equal — every ECM drone is multispectral, with no racial matchup.
function buildDroneJammerPayload(attributes, jammerEffectRecord) {
  return {
    effectID: toInt(jammerEffectRecord.effectID, 0),
    effectName: String(jammerEffectRecord.name || ""),
    effectGUID: String(jammerEffectRecord.guid || ""),
    durationMs: Math.max(
      1,
      round6(toFiniteNumber(attributes[jammerEffectRecord.durationAttributeID], 20_000)),
    ),
    jamDurationMs: Math.max(
      1,
      round6(toFiniteNumber(attributes[ATTRIBUTE_ECM_JAM_DURATION], 5_000)),
    ),
    optimalRange: Math.max(
      0,
      round6(toFiniteNumber(attributes[jammerEffectRecord.rangeAttributeID], 0)),
    ),
    falloff: Math.max(
      0,
      round6(toFiniteNumber(attributes[jammerEffectRecord.falloffAttributeID], 0)),
    ),
    jammerStrengthBySensorType: Object.freeze({
      gravimetric: Math.max(
        0,
        round6(toFiniteNumber(attributes[ATTRIBUTE_SCAN_GRAVIMETRIC_STRENGTH_BONUS], 0)),
      ),
      ladar: Math.max(
        0,
        round6(toFiniteNumber(attributes[ATTRIBUTE_SCAN_LADAR_STRENGTH_BONUS], 0)),
      ),
      magnetometric: Math.max(
        0,
        round6(toFiniteNumber(attributes[ATTRIBUTE_SCAN_MAGNETOMETRIC_STRENGTH_BONUS], 0)),
      ),
      radar: Math.max(
        0,
        round6(toFiniteNumber(attributes[ATTRIBUTE_SCAN_RADAR_STRENGTH_BONUS], 0)),
      ),
    }),
  };
}

function resolveDroneCombatSnapshot(droneEntity, controllerEntity) {
  const context = getControllerDogmaContext(controllerEntity);
  const droneItem = resolveDroneDogmaItem(droneEntity);
  const typeID = toInt(droneItem && droneItem.typeID, 0);
  if (!context || typeID <= 0) {
    return null;
  }

  const cacheKey = buildDroneSnapshotCacheKey(droneEntity, droneItem);
  if (context.combatByTypeID.has(cacheKey)) {
    return context.combatByTypeID.get(cacheKey);
  }

  const effectRecord = resolveDroneEffectRecord(typeID, COMBAT_EFFECT_NAMES);
  // `targetAttack` and `entityECMFalloff` are not alternatives. The three
  // published faction ECM drones — Inshore EC-300-I (92039), Nertic EC-600-I
  // (92040) and Humboldt EC-900-I (92041) — declare BOTH, and their own SDE
  // description says so: "the combat chassis of this light drone has been
  // adapted to ALSO house ECM". Resolving the combat effect first and then
  // refusing to look for the jammer left half the published ECM-drone roster
  // shooting and never jamming.
  const jammerEffectRecord = resolveDroneEffectRecord(typeID, ECM_EFFECT_NAMES);
  if (!effectRecord && !jammerEffectRecord) {
    context.combatByTypeID.set(cacheKey, null);
    return null;
  }

  const operational = buildDroneOperationalAttributes(droneItem, controllerEntity);
  if (!operational) {
    context.combatByTypeID.set(cacheKey, null);
    return null;
  }

  const attributes = operational.attributes;
  const baseDamage = buildDamageVector(attributes);
  const damageMultiplier = Math.max(
    0,
    round6(toFiniteNumber(attributes[ATTRIBUTE_DAMAGE_MULTIPLIER], 1)),
  );
  const rawShotDamage = {
    em: round6(baseDamage.em * damageMultiplier),
    thermal: round6(baseDamage.thermal * damageMultiplier),
    kinetic: round6(baseDamage.kinetic * damageMultiplier),
    explosive: round6(baseDamage.explosive * damageMultiplier),
  };
  if (!jammerEffectRecord && sumDamageVector(rawShotDamage) <= 0) {
    context.combatByTypeID.set(cacheKey, null);
    return null;
  }

  const jammerPayload = jammerEffectRecord
    ? buildDroneJammerPayload(attributes, jammerEffectRecord)
    : null;

  if (jammerEffectRecord && !effectRecord) {
    const { durationMs, optimalRange, falloff } = jammerPayload;
    const orbitDistanceMeters = Math.max(
      500,
      round6(resolveDroneOrbitAttribute(attributes, droneItem, 500)),
    );
    const attackRangeMeters = Math.max(
      optimalRange,
      round6(optimalRange + falloff),
    );
    const chaseRangeMeters = Math.max(
      attackRangeMeters,
      round6(
        Math.max(
          attackRangeMeters,
          toFiniteNumber(attributes[ATTRIBUTE_ENTITY_ATTACK_RANGE], 0),
        ),
      ),
    );
    const snapshot = {
      ...jammerPayload,
      effectKind: "jammer",
      orbitDistanceMeters,
      attackRangeMeters,
      chaseRangeMeters,
    };
    context.combatByTypeID.set(cacheKey, snapshot);
    return snapshot;
  }

  const durationMs = Math.max(
    1,
    round6(
      toFiniteNumber(
        attributes[ATTRIBUTE_SPEED],
        toFiniteNumber(attributes[ATTRIBUTE_DURATION], 1000),
      ),
    ),
  );
  const optimalRange = Math.max(
    0,
    round6(toFiniteNumber(attributes[ATTRIBUTE_MAX_RANGE], 0)),
  );
  const falloff = Math.max(
    0,
    round6(toFiniteNumber(attributes[ATTRIBUTE_FALLOFF], 0)),
  );
  const trackingSpeed = Math.max(
    0,
    round6(toFiniteNumber(attributes[ATTRIBUTE_TRACKING_SPEED], 0)),
  );
  const optimalSigRadius = Math.max(
    1,
    round6(
      toFiniteNumber(
        attributes[ATTRIBUTE_OPTIMAL_SIG_RADIUS],
        toFiniteNumber(attributes[ATTRIBUTE_SIGNATURE_RADIUS], 25),
      ),
    ),
  );
  const orbitDistanceMeters = Math.max(
    0,
    round6(resolveDroneOrbitAttribute(attributes, droneItem, 500)),
  );
  const attackRangeMeters = Math.max(
    0,
    round6(
      Math.max(
        toFiniteNumber(attributes[ATTRIBUTE_ENTITY_ATTACK_RANGE], 0),
        optimalRange,
      ),
    ),
  );
  const chaseRangeMeters = Math.max(
    attackRangeMeters,
    round6(
      Math.max(
        attackRangeMeters + falloff,
        toFiniteNumber(attributes[ATTRIBUTE_ENTITY_CHASE_MAX_DISTANCE], 0),
      ),
    ),
  );

  const snapshot = {
    effectID: toInt(effectRecord.effectID, 0),
    effectName: String(effectRecord.name || ""),
    effectGUID: String(effectRecord.guid || ""),
    durationMs,
    optimalRange,
    falloff,
    trackingSpeed,
    optimalSigRadius,
    damageMultiplier,
    rawShotDamage,
    orbitDistanceMeters,
    attackRangeMeters,
    chaseRangeMeters,
    // A faction hybrid runs its jammer on its OWN 20 s cycle, independent of the
    // 4 s turret cycle above; the two share only the target.
    ...(jammerPayload ? { jammer: Object.freeze(jammerPayload) } : {}),
  };
  context.combatByTypeID.set(cacheKey, snapshot);
  return snapshot;
}

function resolveDroneMiningSnapshot(droneEntity, controllerEntity) {
  const context = getControllerDogmaContext(controllerEntity);
  const droneItem = resolveDroneDogmaItem(droneEntity);
  const typeID = toInt(droneItem && droneItem.typeID, 0);
  if (!context || typeID <= 0) {
    return null;
  }

  const cacheKey = buildDroneSnapshotCacheKey(droneEntity, droneItem);
  if (context.miningByTypeID.has(cacheKey)) {
    return context.miningByTypeID.get(cacheKey);
  }

  const effectRecord = resolveDroneEffectRecord(typeID, MINING_EFFECT_NAMES);
  if (!effectRecord) {
    context.miningByTypeID.set(cacheKey, null);
    return null;
  }

  const operational = buildDroneOperationalAttributes(droneItem, controllerEntity);
  if (!operational) {
    context.miningByTypeID.set(cacheKey, null);
    return null;
  }

  const attributes = operational.attributes;
  const miningAmountM3 = Math.max(
    0,
    round6(toFiniteNumber(attributes[ATTRIBUTE_MINING_AMOUNT], 0)),
  );
  if (miningAmountM3 <= 0) {
    context.miningByTypeID.set(cacheKey, null);
    return null;
  }

  const durationMs = Math.max(
    1,
    round6(
      toFiniteNumber(
        attributes[ATTRIBUTE_DURATION],
        toFiniteNumber(attributes[ATTRIBUTE_SPEED], 1000),
      ),
    ),
  );
  const snapshot = {
    effectID: toInt(effectRecord.effectID, 0),
    effectName: String(effectRecord.name || ""),
    effectGUID: String(effectRecord.guid || ""),
    durationMs,
    miningAmountM3,
    // Residue, read the same way the mining module snapshot reads it
    // (services/mining/miningDogma.js): a raw percentage for the probability,
    // a multiplier on the cycle's volume for the amount. Mining drones carry
    // both in the SDE -- 34 % on a Mining Drone II, 60 % on an Excavator, all
    // with a 1.0 multiplier -- and Mining Drone I carries 0, so an unpublished
    // or residue-free drone still wastes nothing.
    wasteVolumeMultiplier: Math.max(
      0,
      round6(toFiniteNumber(attributes[ATTRIBUTE_MINING_WASTE_MULTIPLIER], 0)),
    ),
    wasteProbability: Math.max(
      0,
      round6(toFiniteNumber(attributes[ATTRIBUTE_MINING_WASTE_PROBABILITY], 0)),
    ),
    maxRangeMeters: Math.max(
      0,
      round6(toFiniteNumber(attributes[ATTRIBUTE_MAX_RANGE], 0)),
    ),
    orbitDistanceMeters: Math.max(
      0,
      round6(resolveDroneOrbitAttribute(attributes, droneItem, 200)),
    ),
  };
  context.miningByTypeID.set(cacheKey, snapshot);
  return snapshot;
}

function resolveDroneSalvageSnapshot(droneEntity, controllerEntity) {
  const context = getControllerDogmaContext(controllerEntity);
  const droneItem = resolveDroneDogmaItem(droneEntity);
  const typeID = toInt(droneItem && droneItem.typeID, 0);
  if (!context || typeID <= 0) {
    return null;
  }

  const cacheKey = buildDroneSnapshotCacheKey(droneEntity, droneItem);
  if (context.salvageByTypeID.has(cacheKey)) {
    return context.salvageByTypeID.get(cacheKey);
  }

  const effectRecord = resolveDroneEffectRecord(typeID, SALVAGE_EFFECT_NAMES);
  if (!effectRecord) {
    context.salvageByTypeID.set(cacheKey, null);
    return null;
  }

  const operational = buildDroneOperationalAttributes(droneItem, controllerEntity);
  if (!operational) {
    context.salvageByTypeID.set(cacheKey, null);
    return null;
  }

  const attributes = operational.attributes;
  const accessBonusPercent = Math.max(
    0,
    round6(toFiniteNumber(attributes[ATTRIBUTE_ACCESS_DIFFICULTY_BONUS], 0)),
  );
  if (accessBonusPercent <= 0) {
    context.salvageByTypeID.set(cacheKey, null);
    return null;
  }

  const durationMs = Math.max(
    1,
    round6(
      toFiniteNumber(
        attributes[ATTRIBUTE_DURATION],
        toFiniteNumber(attributes[ATTRIBUTE_SPEED], 1000),
      ),
    ),
  );
  const snapshot = {
    effectID: toInt(effectRecord.effectID, 0),
    effectName: String(effectRecord.name || ""),
    effectGUID: String(effectRecord.guid || ""),
    durationMs,
    accessBonusPercent,
    maxRangeMeters: Math.max(
      0,
      round6(toFiniteNumber(attributes[ATTRIBUTE_MAX_RANGE], 0)),
    ),
    orbitDistanceMeters: Math.max(
      0,
      round6(resolveDroneOrbitAttribute(attributes, droneItem, 500)),
    ),
  };
  context.salvageByTypeID.set(cacheKey, snapshot);
  return snapshot;
}

function resolveDroneRepairSnapshot(droneEntity, controllerEntity) {
  const context = getControllerDogmaContext(controllerEntity);
  const droneItem = resolveDroneDogmaItem(droneEntity);
  const typeID = toInt(droneItem && droneItem.typeID, 0);
  if (!context || typeID <= 0) {
    return null;
  }

  const cacheKey = buildDroneSnapshotCacheKey(droneEntity, droneItem);
  if (context.repairByTypeID.has(cacheKey)) {
    return context.repairByTypeID.get(cacheKey);
  }

  const repairEffect = resolveDroneRepairEffectRecord(typeID);
  if (!repairEffect) {
    context.repairByTypeID.set(cacheKey, null);
    return null;
  }

  const operational = buildDroneOperationalAttributes(droneItem, controllerEntity);
  if (!operational) {
    context.repairByTypeID.set(cacheKey, null);
    return null;
  }

  const { effectRecord, definition } = repairEffect;
  const attributes = operational.attributes;
  const repairAmount = Math.max(
    0,
    round6(toFiniteNumber(attributes[definition.amountAttributeID], 0)),
  );
  if (repairAmount <= 0) {
    context.repairByTypeID.set(cacheKey, null);
    return null;
  }

  const durationMs = Math.max(
    1,
    round6(
      toFiniteNumber(
        attributes[effectRecord && effectRecord.durationAttributeID],
        toFiniteNumber(
          attributes[ATTRIBUTE_DURATION],
          toFiniteNumber(attributes[ATTRIBUTE_SPEED], 1000),
        ),
      ),
    ),
  );
  const maxRangeMeters = Math.max(
    0,
    round6(
      toFiniteNumber(
        attributes[effectRecord && effectRecord.rangeAttributeID],
        toFiniteNumber(attributes[ATTRIBUTE_MAX_RANGE], 0),
      ),
    ),
  );
  const orbitDistanceMeters = Math.max(
    0,
    round6(resolveDroneOrbitAttribute(attributes, droneItem, 500)),
  );
  const attackRangeMeters = Math.max(
    orbitDistanceMeters,
    maxRangeMeters,
    round6(toFiniteNumber(attributes[ATTRIBUTE_ENTITY_ATTACK_RANGE], 0)),
  );
  const chaseRangeMeters = Math.max(
    attackRangeMeters,
    round6(toFiniteNumber(attributes[ATTRIBUTE_ENTITY_CHASE_MAX_DISTANCE], attackRangeMeters)),
  );
  const snapshot = {
    effectID: toInt(effectRecord.effectID, 0),
    effectName: String(effectRecord.name || ""),
    effectGUID: String(effectRecord.guid || ""),
    effectKind: "repair",
    repairFamily: definition.family,
    durationMs,
    maxRangeMeters,
    orbitDistanceMeters,
    attackRangeMeters,
    chaseRangeMeters,
    shieldBonusAmount:
      definition.family === "remoteShield" ? repairAmount : 0,
    armorRepairAmount:
      definition.family === "remoteArmor" ? repairAmount : 0,
    hullRepairAmount:
      definition.family === "remoteHull" ? repairAmount : 0,
  };
  context.repairByTypeID.set(cacheKey, snapshot);
  return snapshot;
}

module.exports = {
  beginDogmaTick,
  refreshControllerDroneDogma,
  endDogmaTick,
  resolveDroneOperationalAttributes,
  resolveDroneTooltipAttributes,
  buildDroneTooltipAttributeStamp,
  setControllerDogmaCacheRebuiltHandler,
  resolveDroneCombatSnapshot,
  resolveDroneMiningSnapshot,
  resolveDroneSalvageSnapshot,
  resolveDroneRepairSnapshot,
  _testing: {
    getControllerDogmaContext,
    buildDamageVector,
    buildDroneSnapshotCacheKey,
    resolveDroneDogmaItem,
    sumDamageVector,
    buildControllerDogmaFingerprint,
    isDroneCategoryItem,
  },
};
