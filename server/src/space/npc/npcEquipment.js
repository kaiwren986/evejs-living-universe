"use strict";

const {
  round6,
  toFiniteNumber,
} = require("../../common/numbers");

const path = require("path");

const {
  getFittedModuleItems,
  getLoadedChargeByFlag,
  isModuleOnline,
  getAttributeIDByNames,
  getEffectIDByNames,
  getEffectTypeRecord,
  getTypeDogmaEffects,
  getTypeAttributeMap,
  typeHasEffectName,
} = require(path.join(__dirname, "../../services/fitting/liveFittingState"));
const {
  compareModuleSortOrder,
  isGroupableModuleItem,
} = require(path.join(__dirname, "../../services/moduleGrouping/moduleGroupingRules"));
const {
  resolveItemByTypeID,
} = require(path.join(__dirname, "../../services/inventory/itemTypeRegistry"));
const {
  isMissileWeaponFamily,
  isTurretWeaponFamily,
  resolveWeaponFamily,
  buildWeaponModuleSnapshot,
} = require(path.join(__dirname, "../combat/weaponDogma"));
const {
  getLocationModifierSourcesForSystem,
} = require(path.join(
  __dirname,
  "../../services/exploration/wormholes/wormholeEnvironmentRuntime",
));
const {
  buildLiveModuleAttributeMap,
} = require(path.join(__dirname, "../modules/liveModuleAttributes"));
const assistanceModuleRuntime = require(path.join(
  __dirname,
  "../modules/assistanceModuleRuntime",
));
const hostileModuleRuntime = require(path.join(
  __dirname,
  "../modules/hostileModuleRuntime",
));
const jammerModuleRuntime = require(path.join(
  __dirname,
  "../modules/jammerModuleRuntime",
));
const nativeNpcStore = require(path.join(__dirname, "./nativeNpcStore"));
const { resolveEntityEwarSpecs } = require(path.join(__dirname, "./npcEntityEwarCatalog"));
const {
  buildNpcEffectiveModuleItem,
  getNpcCapabilityTypeID,
  resolveNpcPropulsionEffectName: resolveNpcCapabilityPropulsionEffectName,
  NPC_ENABLE_FITTED_PROPULSION_MODULES,
} = require(path.join(__dirname, "./npcCapabilityResolver"));

const PROPULSION_EFFECT_AFTERBURNER = "moduleBonusAfterburner";
const PROPULSION_EFFECT_MICROWARPDRIVE = "moduleBonusMicrowarpdrive";
// The NPC hull effects own the mechanics. These published module types supply
// only the client-side graphic identity for their matching presentation.
const NPC_CHAIN_LIGHTNING_PRESENTATION_MODULE_TYPE_ID = 54739;
const NPC_REMOTE_SHIELD_PRESENTATION_MODULE_TYPE_ID = 3586;
const ATTRIBUTE_SPEED = getAttributeIDByNames("speed") || 51;
const ATTRIBUTE_MISSILE_LAUNCH_DURATION =
  getAttributeIDByNames("missileLaunchDuration") || 506;
const ATTRIBUTE_ENTITY_ATTACK_DELAY_MIN =
  getAttributeIDByNames("entityAttackDelayMin") || 475;
const ATTRIBUTE_ENTITY_ATTACK_DELAY_MAX =
  getAttributeIDByNames("entityAttackDelayMax") || 476;
const ATTRIBUTE_MISSILE_DAMAGE_MULTIPLIER =
  getAttributeIDByNames("missileDamageMultiplier") || 212;
const ATTRIBUTE_DAMAGE_MULTIPLIER = getAttributeIDByNames("damageMultiplier") || 64;
const ATTRIBUTE_EM_DAMAGE = getAttributeIDByNames("emDamage") || 114;
const ATTRIBUTE_EXPLOSIVE_DAMAGE = getAttributeIDByNames("explosiveDamage") || 116;
const ATTRIBUTE_KINETIC_DAMAGE = getAttributeIDByNames("kineticDamage") || 117;
const ATTRIBUTE_THERMAL_DAMAGE = getAttributeIDByNames("thermalDamage") || 118;
const ATTRIBUTE_MAX_VELOCITY = getAttributeIDByNames("maxVelocity") || 37;
const ATTRIBUTE_EXPLOSION_DELAY = getAttributeIDByNames("explosionDelay") || 281;
const ATTRIBUTE_AOE_VELOCITY = getAttributeIDByNames("aoeVelocity") || 653;
const ATTRIBUTE_AOE_CLOUD_SIZE = getAttributeIDByNames("aoeCloudSize") || 654;
const ATTRIBUTE_AOE_DAMAGE_REDUCTION_FACTOR =
  getAttributeIDByNames("aoeDamageReductionFactor") || 1353;
function getAbyssalMgrService() {
  return require("../../abyssal").weatherPolicy;
}

const ATTRIBUTE_AOE_DAMAGE_REDUCTION_SENSITIVITY =
  getAttributeIDByNames("aoeDamageReductionSensitivity") || 1354;
const ATTRIBUTE_ENTITY_MISSILE_TYPE_ID =
  getAttributeIDByNames("entityMissileTypeID") || 507;
const ATTRIBUTE_MISSILE_ENTITY_VELOCITY_MULTIPLIER =
  getAttributeIDByNames("missileEntityVelocityMultiplier") || 645;
const ATTRIBUTE_MISSILE_ENTITY_FLIGHT_TIME_MULTIPLIER =
  getAttributeIDByNames("missileEntityFlightTimeMultiplier") || 646;
const ATTRIBUTE_MISSILE_ENTITY_AOE_VELOCITY_MULTIPLIER =
  getAttributeIDByNames("missileEntityAoeVelocityMultiplier") || 647;
const ATTRIBUTE_MISSILE_ENTITY_AOE_CLOUD_SIZE_MULTIPLIER =
  getAttributeIDByNames("missileEntityAoeCloudSizeMultiplier") || 648;
const DEFAULT_MISSILE_DAMAGE_REDUCTION_SENSITIVITY = 5.5;
const ATTRIBUTE_MAX_RANGE = getAttributeIDByNames("maxRange") || 54;
const ATTRIBUTE_FALLOFF_EFFECTIVENESS =
  getAttributeIDByNames("falloffEffectiveness") || 2044;
const NPC_SELF_EFFECT_DEFINITIONS_BY_NAME = Object.freeze({
  entityarmorrepairing: Object.freeze({
    family: "armorRepair",
    activateWhen: "combat",
  }),
  entityarmorrepairingsmall: Object.freeze({
    family: "armorRepair",
    activateWhen: "combat",
  }),
  entityarmorrepairingmedium: Object.freeze({
    family: "armorRepair",
    activateWhen: "combat",
  }),
  entityarmorrepairinglarge: Object.freeze({
    family: "armorRepair",
    activateWhen: "combat",
  }),
  armorrepairforentities: Object.freeze({
    family: "armorRepair",
    activateWhen: "combat",
  }),
  npcbehaviorarmorrepairer: Object.freeze({
    family: "armorRepair",
    activateWhen: "combat",
  }),
  entityshieldboosting: Object.freeze({
    family: "shieldBoosting",
    activateWhen: "combat",
  }),
  shieldboostingforentities: Object.freeze({
    family: "shieldBoosting",
    activateWhen: "combat",
  }),
  entityshieldboostingsmall: Object.freeze({
    family: "shieldBoosting",
    activateWhen: "combat",
  }),
  entityshieldboostingmedium: Object.freeze({
    family: "shieldBoosting",
    activateWhen: "combat",
  }),
  entityshieldboostinglarge: Object.freeze({
    family: "shieldBoosting",
    activateWhen: "combat",
  }),
  npcbehaviorshieldbooster: Object.freeze({
    family: "shieldBoosting",
    activateWhen: "combat",
  }),
  npcbehaviorsiege: Object.freeze({
    family: "siege",
    activateWhen: "combat",
  }),
});

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function isNativeNpcEntity(entity) {
  return Boolean(
    entity &&
    entity.kind === "ship" &&
    entity.nativeNpc === true,
  );
}

function getScopedNpcLocationModifierSources(entity) {
  const modifierSources = [
    ...require("../../services/homefront/homefrontHooks").weather.locationModifiers(entity),
    ...getLocationModifierSourcesForSystem(entity && entity.systemID),
  ];
  const abyssalMgrService = getAbyssalMgrService();
  if (
    abyssalMgrService &&
    typeof abyssalMgrService.collectAbyssalLocationModifierSourcesForEntity === "function"
  ) {
    modifierSources.push(
      ...abyssalMgrService.collectAbyssalLocationModifierSourcesForEntity(entity),
    );
  }
  return modifierSources;
}

function getNpcShipID(entity) {
  return toPositiveInt(entity && entity.itemID, 0);
}

function getNpcPilotCharacterID(entity) {
  return toPositiveInt(
    entity && (
      entity.pilotCharacterID ??
      entity.characterID
    ),
    0,
  );
}

function getNativeNpcFittedModuleItems(entity) {
  if (Array.isArray(entity && entity.fittedItems)) {
    return entity.fittedItems.map((moduleItem) => ({ ...moduleItem }));
  }
  const entityID = getNpcShipID(entity);
  if (!entityID) {
    return [];
  }
  return nativeNpcStore.buildNativeFittedItems(entityID);
}

function getNativeNpcCargoItems(entity) {
  if (Array.isArray(entity && entity.nativeCargoItems)) {
    return entity.nativeCargoItems.map((cargoItem) => ({
      ...cargoItem,
      moduleState:
        cargoItem && cargoItem.moduleState && typeof cargoItem.moduleState === "object"
          ? { ...cargoItem.moduleState }
          : cargoItem && cargoItem.moduleState ? cargoItem.moduleState : null,
    }));
  }
  const entityID = getNpcShipID(entity);
  if (!entityID) {
    return [];
  }
  return nativeNpcStore.buildNativeCargoItems(entityID);
}

function getNpcFittedModuleItems(entity) {
  if (isNativeNpcEntity(entity)) {
    return getNativeNpcFittedModuleItems(entity);
  }

  const characterID = getNpcPilotCharacterID(entity);
  const shipID = getNpcShipID(entity);
  if (!characterID || !shipID) {
    return [];
  }

  return getFittedModuleItems(characterID, shipID);
}

function getNpcLoadedChargeForModule(entity, moduleItem) {
  const shipID = getNpcShipID(entity);
  const moduleID = toPositiveInt(moduleItem && moduleItem.itemID, 0);
  const flagID = toPositiveInt(moduleItem && moduleItem.flagID, 0);
  if (!shipID || !moduleID || !flagID) {
    return null;
  }

  if (isNativeNpcEntity(entity)) {
    const cargoItem = getNativeNpcCargoItems(entity).find(
      (entry) => toPositiveInt(entry && entry.moduleID, 0) === moduleID,
    ) || null;
    if (!cargoItem) {
      return null;
    }
    return {
      ...cargoItem,
      flagID,
    };
  }

  const characterID = getNpcPilotCharacterID(entity);
  if (!characterID) {
    return null;
  }
  return getLoadedChargeByFlag(characterID, shipID, flagID);
}

function buildNpcWeaponBankCacheSignature(entity) {
  const fittedSignature = getNpcFittedModuleItems(entity)
    .map((moduleItem) => {
      const chargeItem = isNativeNpcEntity(entity)
        ? null
        : getNpcLoadedChargeForModule(entity, moduleItem);
      return [
        toPositiveInt(moduleItem && moduleItem.itemID, 0),
        toPositiveInt(moduleItem && moduleItem.typeID, 0),
        toPositiveInt(moduleItem && moduleItem.groupID, 0),
        toPositiveInt(moduleItem && moduleItem.flagID, 0),
        toPositiveInt(chargeItem && chargeItem.typeID, 0),
        isModuleOnline(moduleItem) ? 1 : 0,
      ].join(":");
    })
    .join("|");
  const chargeSignature = getNativeNpcCargoItems(entity)
    .map((chargeItem) => [
      toPositiveInt(chargeItem && chargeItem.moduleID, 0),
      toPositiveInt(chargeItem && chargeItem.typeID, 0),
    ].join(":"))
    .join("|");
  return `${fittedSignature}#${chargeSignature}`;
}

function buildNpcWeaponBankCache(entity) {
  const signature = buildNpcWeaponBankCacheSignature(entity);
  if (
    entity &&
    entity._npcWeaponBankCache &&
    entity._npcWeaponBankCache.signature === signature
  ) {
    return entity._npcWeaponBankCache;
  }

  const cargoByModuleID = new Map();
  for (const chargeItem of getNativeNpcCargoItems(entity)) {
    const moduleID = toPositiveInt(chargeItem && chargeItem.moduleID, 0);
    if (moduleID > 0 && !cargoByModuleID.has(moduleID)) {
      cargoByModuleID.set(moduleID, chargeItem);
    }
  }

  const groupsByKey = new Map();
  const fittedItems = getNpcFittedModuleItems(entity)
    .filter((moduleItem) => isGroupableModuleItem(moduleItem, { requireOnline: true }))
    .sort((left, right) => compareModuleSortOrder(left, right));
  for (const moduleItem of fittedItems) {
    const moduleID = toPositiveInt(moduleItem && moduleItem.itemID, 0);
    const chargeItem =
      cargoByModuleID.get(moduleID) ||
      getNpcLoadedChargeForModule(entity, moduleItem);
    const family = resolveWeaponFamily(moduleItem, chargeItem);
    if (!isTurretWeaponFamily(family) && !isMissileWeaponFamily(family)) {
      continue;
    }
    const chargeTypeID = toPositiveInt(chargeItem && chargeItem.typeID, 0);
    const key = [
      toPositiveInt(moduleItem && moduleItem.typeID, 0),
      chargeTypeID,
      family,
    ].join(":");
    if (!groupsByKey.has(key)) {
      groupsByKey.set(key, []);
    }
    groupsByKey.get(key).push({
      moduleItem,
      chargeItem,
      family,
    });
  }

  const moduleGroupsByID = new Map();
  for (const entries of groupsByKey.values()) {
    if (!Array.isArray(entries) || entries.length <= 1) {
      continue;
    }
    const sortedEntries = [...entries].sort((left, right) => (
      compareModuleSortOrder(left.moduleItem, right.moduleItem)
    ));
    const masterEntry = sortedEntries[0];
    const moduleIDs = sortedEntries
      .map((entry) => toPositiveInt(entry && entry.moduleItem && entry.moduleItem.itemID, 0))
      .filter((moduleID) => moduleID > 0);
    if (moduleIDs.length <= 1) {
      continue;
    }
    const group = {
      masterModuleID: toPositiveInt(masterEntry && masterEntry.moduleItem && masterEntry.moduleItem.itemID, 0),
      masterModuleItem: {
        ...masterEntry.moduleItem,
      },
      moduleIDs,
      family: String(masterEntry && masterEntry.family || ""),
    };
    for (const moduleID of moduleIDs) {
      moduleGroupsByID.set(moduleID, group);
    }
  }

  const cache = {
    signature,
    moduleGroupsByID,
  };
  if (entity && typeof entity === "object") {
    entity._npcWeaponBankCache = cache;
  }
  return cache;
}

function getNpcWeaponBankGroupForModule(entity, moduleItem) {
  const moduleID = toPositiveInt(moduleItem && moduleItem.itemID, 0);
  if (!entity || moduleID <= 0) {
    return null;
  }
  const moduleBankIDs = Array.isArray(moduleItem && moduleItem.npcWeaponBankModuleIDs)
    ? moduleItem.npcWeaponBankModuleIDs
        .map((candidateModuleID) => toPositiveInt(candidateModuleID, 0))
        .filter((candidateModuleID) => candidateModuleID > 0)
    : [];
  const moduleBankMasterID = toPositiveInt(moduleItem && moduleItem.npcWeaponBankMasterID, 0);
  if (moduleBankMasterID > 0 && moduleBankIDs.length > 1) {
    return {
      masterModuleID: moduleBankMasterID,
      masterModuleItem:
        moduleBankMasterID === moduleID
          ? { ...moduleItem }
          : null,
      moduleIDs: moduleBankIDs,
      family: String(moduleItem && moduleItem.npcWeaponBankFamily || ""),
    };
  }
  const cache = buildNpcWeaponBankCache(entity);
  return cache.moduleGroupsByID.get(moduleID) || null;
}

function buildNpcSyntheticHullModuleID(entityID, slotIndex = 0) {
  const normalizedEntityID = toPositiveInt(entityID, 0);
  const normalizedSlotIndex = Math.max(0, toPositiveInt(slotIndex, 0));
  return normalizedEntityID > 0
    ? (normalizedEntityID * 10000) + normalizedSlotIndex
    : 0;
}

function buildNpcSyntheticHullEffectModuleItem(entity, effectRecord, slotIndex = 0, options = {}) {
  const entityID = getNpcShipID(entity);
  const typeID = toPositiveInt(entity && entity.typeID, 0);
  if (!entityID || !typeID || !effectRecord) {
    return null;
  }

  const slotToken = Math.max(
    1,
    toPositiveInt(options.slotBase, 0) + toPositiveInt(effectRecord && effectRecord.effectID, slotIndex),
  );

  return {
    itemID: buildNpcSyntheticHullModuleID(entityID, slotToken),
    typeID,
    groupID: toPositiveInt(entity && entity.groupID, 0),
    categoryID: toPositiveInt(entity && entity.categoryID, 0),
    flagID: 0,
    locationID: entityID,
    ownerID: toPositiveInt(
      entity && (
        entity.pilotCharacterID ??
        entity.characterID ??
        entity.ownerID ??
        entity.corporationID
      ),
      0,
    ),
    singleton: 1,
    quantity: 1,
    stacksize: 1,
    itemName: String(entity && entity.itemName || entity && entity.slimName || "NPC Hull"),
    npcSyntheticHullModule: true,
    npcSyntheticHullWeapon: options.syntheticWeapon === true,
    npcCapitalHullDamageAuthority:
      options.capitalHullDamageAuthority === true,
    npcSyntheticHullSuperweapon: options.syntheticSuperweapon === true,
    npcEffectID: toPositiveInt(effectRecord && effectRecord.effectID, 0) || null,
    npcEffectName: String(effectRecord && effectRecord.name || "").trim(),
    // The SDE effect this module IS. `Scene.activateGenericModule` resolves an effect by name
    // against the module type's own dogma, and a synthetic hull module's type is the rat hull —
    // which is right for a family the hull declares and impossible for one it expresses only as
    // attributes. Carrying the effect ID lets the activation lane bind the record directly
    // instead of silently falling back to the hull's first activatable effect.
    npcSyntheticHullEffectID: toPositiveInt(effectRecord && effectRecord.effectID, 0),
    npcWeaponFamily: String(options.weaponFamily || "").trim() || null,
    npcSpecialFxGuid:
      String(entity && entity.evejsAbyssalNpcSpecialFxGuid || "").trim() || null,
    npcSpecialFxModuleTypeID:
      toPositiveInt(options.specialFxModuleTypeID, 0) || null,
    npcPreserveSpecialFxGuidOrder:
      entity && entity.evejsAbyssalNpcPreserveSpecialFxGuidOrder === true,
    npcPrecursorSpoolPerCycle: Number.isFinite(
      Number(entity && entity.evejsAbyssalNpcPrecursorSpoolPerCycle),
    )
      ? Math.max(0, Number(entity.evejsAbyssalNpcPrecursorSpoolPerCycle))
      : null,
    npcPrecursorSpoolMax: Number.isFinite(
      Number(entity && entity.evejsAbyssalNpcPrecursorSpoolMax),
    )
      ? Math.max(0, Number(entity.evejsAbyssalNpcPrecursorSpoolMax))
      : null,
    moduleState: {
      online: true,
      isOnline: true,
      active: false,
      isActive: false,
    },
  };
}

function getNpcWeaponModules(entity) {
  const weaponBankCache = buildNpcWeaponBankCache(entity);
  const fittedWeaponModules = getNpcFittedModuleItems(entity)
    .filter((moduleItem) => {
      const chargeItem = getNpcLoadedChargeForModule(entity, moduleItem);
      const family = resolveWeaponFamily(moduleItem, chargeItem);
      return (
        isTurretWeaponFamily(family) ||
        isMissileWeaponFamily(family)
      );
    })
    .sort(compareModuleSortOrder)
    .map((moduleItem) => {
      const moduleID = toPositiveInt(moduleItem && moduleItem.itemID, 0);
      const bankGroup = weaponBankCache.moduleGroupsByID.get(moduleID) || null;
      if (!bankGroup) {
        return moduleItem;
      }
      return {
        ...moduleItem,
        npcWeaponBankMasterID: bankGroup.masterModuleID,
        npcWeaponBankModuleIDs: [...bankGroup.moduleIDs],
        npcWeaponBankFamily: bankGroup.family,
      };
    });

  const hullTargetAttackEffect = isNativeNpcEntity(entity)
    ? getTypeEffectRecords(toPositiveInt(entity && entity.typeID, 0))
      .find((effectRecord) => (
        String(effectRecord && effectRecord.name || "").trim().toLowerCase() ===
        "targetattack"
      )) || null
    : null;
  // Capital NPC hulls carry their authoritative targetAttack damage profile on
  // the hull. Keep a real fitted turret bank as the presentation surface so
  // hardpoint IDs, banking, charges, and faction-specific FX remain intact.
  const useCapitalHullDamage =
    isNativeNpcEntity(entity) &&
    entity.capitalNpc === true &&
    hullTargetAttackEffect &&
    typeHasNonzeroTargetAttackDamage(toPositiveInt(entity && entity.typeID, 0));
  const presentationModule = useCapitalHullDamage
    ? fittedWeaponModules.find((moduleItem) => isTurretWeaponFamily(
      resolveWeaponFamily(
        moduleItem,
        getNpcLoadedChargeForModule(entity, moduleItem),
      ),
    )) || null
    : null;

  if (presentationModule) {
    const presentationModuleID = toPositiveInt(presentationModule.itemID, 0);
    const presentationBank =
      weaponBankCache.moduleGroupsByID.get(presentationModuleID) || null;
    const presentationModuleIDs = new Set(
      presentationBank && Array.isArray(presentationBank.moduleIDs)
        ? presentationBank.moduleIDs
        : [presentationModuleID],
    );
    const presentationFamily = resolveWeaponFamily(
      presentationModule,
      getNpcLoadedChargeForModule(entity, presentationModule),
    );
    return fittedWeaponModules
      .filter((moduleItem) => presentationModuleIDs.has(
        toPositiveInt(moduleItem && moduleItem.itemID, 0),
      ))
      .map((moduleItem) => ({
        ...moduleItem,
        npcCapitalHullDamageAuthority: true,
        npcHullTargetAttackEffectName: String(
          hullTargetAttackEffect && hullTargetAttackEffect.name || "targetAttack",
        ),
        npcWeaponFamily: presentationFamily,
      }))
      .sort(compareModuleSortOrder);
  }

  const hullWeaponModules = isNativeNpcEntity(entity)
    ? getTypeEffectRecords(toPositiveInt(entity && entity.typeID, 0))
      .filter((effectRecord) => {
        const effectName = String(effectRecord && effectRecord.name || "").trim().toLowerCase();
        return effectName === "entitychainlightning" || (
          (fittedWeaponModules.length <= 0 || useCapitalHullDamage) &&
          (
            effectName === "targetattack" ||
            effectName === "targetdisintegratorattack"
          )
        );
      })
      .filter(() => typeHasNonzeroTargetAttackDamage(toPositiveInt(entity && entity.typeID, 0)))
      .map((effectRecord, index) => {
        const guid = String(effectRecord && effectRecord.guid || "").trim().toLowerCase();
        const effectName = String(effectRecord && effectRecord.name || "")
          .trim()
          .toLowerCase();
        let weaponFamily = "";
        if (effectName === "entitychainlightning") {
          weaponFamily = "vortonProjector";
        } else if (guid.includes("triglavianbeam")) {
          weaponFamily = "precursorTurret";
        } else if (guid.includes("laser")) {
          weaponFamily = "laserTurret";
        } else if (guid.includes("hybrid") || guid.includes("rail") || guid.includes("blaster")) {
          weaponFamily = "hybridTurret";
        } else if (guid.includes("projectile") || guid.includes("artillery") || guid.includes("autocannon")) {
          weaponFamily = "projectileTurret";
        }
        if (!weaponFamily) {
          return null;
        }
        return buildNpcSyntheticHullEffectModuleItem(entity, effectRecord, index, {
          syntheticWeapon: true,
          capitalHullDamageAuthority: useCapitalHullDamage,
          weaponFamily,
          specialFxModuleTypeID:
            effectName === "entitychainlightning"
              ? NPC_CHAIN_LIGHTNING_PRESENTATION_MODULE_TYPE_ID
              : null,
          slotBase: 100,
        });
      })
      .filter(Boolean)
    : [];

  if (useCapitalHullDamage && hullWeaponModules.length > 0) {
    return hullWeaponModules.sort(compareModuleSortOrder);
  }

  return [
    ...fittedWeaponModules,
    ...hullWeaponModules,
  ].sort(compareModuleSortOrder);
}

function getTypeEffectRecords(typeID) {
  return [...(getTypeDogmaEffects(typeID) || new Set())]
    .map((effectID) => getEffectTypeRecord(effectID))
    .filter(Boolean);
}

function typeHasNonzeroTargetAttackDamage(typeID) {
  const attributes = getTypeAttributeMap(typeID);
  if (!attributes || typeof attributes !== "object") {
    return false;
  }
  const baseDamage =
    Math.max(0, toFiniteNumber(attributes[ATTRIBUTE_EM_DAMAGE], 0)) +
    Math.max(0, toFiniteNumber(attributes[ATTRIBUTE_THERMAL_DAMAGE], 0)) +
    Math.max(0, toFiniteNumber(attributes[ATTRIBUTE_KINETIC_DAMAGE], 0)) +
    Math.max(0, toFiniteNumber(attributes[ATTRIBUTE_EXPLOSIVE_DAMAGE], 0));
  if (baseDamage <= 0) {
    return false;
  }
  return Math.max(0, toFiniteNumber(attributes[ATTRIBUTE_DAMAGE_MULTIPLIER], 1)) > 0;
}

function resolveNpcModuleEffectRecord(moduleItem, resolver = null) {
  const effectiveModuleItem = buildNpcEffectiveModuleItem(moduleItem);
  if (!effectiveModuleItem || !effectiveModuleItem.typeID) {
    return null;
  }

  if (
    moduleItem &&
    Object.prototype.hasOwnProperty.call(moduleItem, "_npcResolvedEffectRecord") &&
    moduleItem._npcResolvedEffectRecord
  ) {
    return moduleItem._npcResolvedEffectRecord;
  }

  const explicitEffectName = String(moduleItem && moduleItem.npcEffectName || "").trim().toLowerCase();
  let resolvedEffectRecord = null;
  for (const effectRecord of getTypeEffectRecords(toPositiveInt(effectiveModuleItem.typeID, 0))) {
    if (
      explicitEffectName &&
      String(effectRecord && effectRecord.name || "").trim().toLowerCase() !== explicitEffectName
    ) {
      continue;
    }
    if (typeof resolver === "function" && !resolver(effectRecord)) {
      continue;
    }
    resolvedEffectRecord = effectRecord;
    break;
  }

  if (moduleItem && typeof moduleItem === "object") {
    moduleItem._npcResolvedEffectRecord = resolvedEffectRecord || null;
  }
  return resolvedEffectRecord;
}

function resolveNpcAssistanceModuleDefinition(moduleItem) {
  const effectRecord = resolveNpcModuleEffectRecord(
    moduleItem,
    (candidateEffectRecord) => Boolean(
      assistanceModuleRuntime.resolveAssistanceDefinition(candidateEffectRecord),
    ),
  );
  if (!effectRecord) {
    return null;
  }

  const resolvedDefinition = assistanceModuleRuntime.resolveAssistanceDefinition(effectRecord);
  if (moduleItem && typeof moduleItem === "object") {
    moduleItem._npcAssistanceDefinition = resolvedDefinition || null;
  }
  return resolvedDefinition;
}

function resolveNpcSelfEffectDefinition(effectRecord) {
  const normalizedEffectName = String(effectRecord && effectRecord.name || "")
    .trim()
    .toLowerCase();
  return NPC_SELF_EFFECT_DEFINITIONS_BY_NAME[normalizedEffectName] || null;
}

function resolveNpcSelfModuleDefinition(moduleItem) {
  const effectRecord = resolveNpcModuleEffectRecord(
    moduleItem,
    (candidateEffectRecord) => Boolean(
      resolveNpcSelfEffectDefinition(candidateEffectRecord),
    ),
  );
  if (!effectRecord) {
    return null;
  }

  const resolvedDefinition = resolveNpcSelfEffectDefinition(effectRecord);
  if (moduleItem && typeof moduleItem === "object") {
    moduleItem._npcSelfDefinition = resolvedDefinition || null;
  }
  return resolvedDefinition;
}

function resolveNpcHostileModuleDefinition(moduleItem) {
  const effectiveModuleItem = buildNpcEffectiveModuleItem(moduleItem);
  if (!effectiveModuleItem || !effectiveModuleItem.typeID) {
    return null;
  }

  const cacheKey = toPositiveInt(
    getNpcCapabilityTypeID(effectiveModuleItem, effectiveModuleItem.typeID),
    0,
  );
  if (!cacheKey) {
    return null;
  }

  if (
    moduleItem &&
    Object.prototype.hasOwnProperty.call(moduleItem, "_npcHostileDefinition") &&
    moduleItem._npcHostileDefinition
  ) {
    return moduleItem._npcHostileDefinition;
  }

  const effectRecord = resolveNpcModuleEffectRecord(
    {
      ...moduleItem,
      typeID: cacheKey,
    },
    (candidateEffectRecord) => Boolean(
      hostileModuleRuntime.resolveHostileDefinition(candidateEffectRecord) ||
      jammerModuleRuntime.resolveJammerDefinition(candidateEffectRecord),
    ),
  );
  let resolvedDefinition = null;
  if (effectRecord) {
    resolvedDefinition = hostileModuleRuntime.resolveHostileDefinition(effectRecord);
    if (!resolvedDefinition) {
      resolvedDefinition = jammerModuleRuntime.resolveJammerDefinition(effectRecord);
    }
  }

  if (moduleItem && typeof moduleItem === "object") {
    moduleItem._npcHostileDefinition = resolvedDefinition || null;
  }
  return resolvedDefinition;
}

function getNpcSelfModules(entity) {
  const fittedItems =
    isNativeNpcEntity(entity) && Array.isArray(entity && entity.fittedItems)
      ? entity.fittedItems
      : getNpcFittedModuleItems(entity);

  const fittedSelfModules = fittedItems
    .map((moduleItem) => ({
      moduleItem,
      effectName: String(moduleItem && moduleItem.npcEffectName || "").trim() || null,
      definition: resolveNpcSelfModuleDefinition(moduleItem),
    }))
    .filter((entry) => Boolean(entry.definition))
    .sort((left, right) => (
      toPositiveInt(left.moduleItem && left.moduleItem.flagID, 0) -
      toPositiveInt(right.moduleItem && right.moduleItem.flagID, 0)
    ));

  const hullSelfModules = isNativeNpcEntity(entity)
    ? getTypeEffectRecords(toPositiveInt(entity && entity.typeID, 0))
      .map((effectRecord, index) => {
        const definition = resolveNpcSelfEffectDefinition(effectRecord);
        if (!definition) {
          return null;
        }
        return {
          moduleItem: buildNpcSyntheticHullEffectModuleItem(entity, effectRecord, index, {
            slotBase: 1100,
          }),
          effectName: String(effectRecord && effectRecord.name || "").trim(),
          definition,
        };
      })
      .filter(Boolean)
    : [];

  return [
    ...fittedSelfModules,
    ...hullSelfModules,
  ].sort((left, right) => (
    toPositiveInt(left.moduleItem && left.moduleItem.flagID, 0) -
    toPositiveInt(right.moduleItem && right.moduleItem.flagID, 0)
  ));
}

function buildNpcAssistanceModuleAttributeMap(entity, moduleItem) {
  const shipID = getNpcShipID(entity);
  const shipTypeID = toPositiveInt(entity && entity.typeID, 0);
  if (!shipID || !shipTypeID || !moduleItem) {
    return null;
  }

  return buildLiveModuleAttributeMap(
    {
      itemID: shipID,
      typeID: shipTypeID,
    },
    buildNpcEffectiveModuleItem(moduleItem),
    null,
    null,
    getNpcFittedModuleItems(entity),
    [],
    {
      additionalLocationModifierSources: getScopedNpcLocationModifierSources(entity),
    },
  );
}

function estimateNpcAssistanceEffectiveRange(entity, moduleItem) {
  if (
    moduleItem &&
    Number(moduleItem._npcAssistanceEffectiveRangeMeters) > 0
  ) {
    return Number(moduleItem._npcAssistanceEffectiveRangeMeters);
  }

  const attributeMap = buildNpcAssistanceModuleAttributeMap(entity, moduleItem);
  const effectRecord = resolveNpcModuleEffectRecord(
    moduleItem,
    (candidateEffectRecord) => Boolean(
      assistanceModuleRuntime.resolveAssistanceDefinition(candidateEffectRecord),
    ),
  );
  const rangeAttributeID = toPositiveInt(
    effectRecord && effectRecord.rangeAttributeID,
    ATTRIBUTE_MAX_RANGE,
  );
  const falloffAttributeID = toPositiveInt(
    effectRecord && effectRecord.falloffAttributeID,
    ATTRIBUTE_FALLOFF_EFFECTIVENESS,
  );
  const effectiveRange = Math.max(
    0,
    round6(
      toFiniteNumber(attributeMap && attributeMap[rangeAttributeID], 0) +
      toFiniteNumber(attributeMap && attributeMap[falloffAttributeID], 0),
    ),
  );

  if (moduleItem && typeof moduleItem === "object") {
    moduleItem._npcAssistanceEffectiveRangeMeters = effectiveRange;
  }
  return effectiveRange;
}

function buildNpcHostileModuleAttributeMap(entity, moduleItem) {
  const shipID = getNpcShipID(entity);
  const shipTypeID = toPositiveInt(entity && entity.typeID, 0);
  if (!shipID || !shipTypeID || !moduleItem) {
    return null;
  }

  return buildLiveModuleAttributeMap(
    {
      itemID: shipID,
      typeID: shipTypeID,
    },
    buildNpcEffectiveModuleItem(moduleItem),
    null,
    null,
    getNpcFittedModuleItems(entity),
    [],
    {
      additionalLocationModifierSources: getScopedNpcLocationModifierSources(entity),
    },
  );
}

function estimateNpcHostileEffectiveRange(entity, moduleItem) {
  if (
    moduleItem &&
    Number(moduleItem._npcHostileEffectiveRangeMeters) > 0
  ) {
    return Number(moduleItem._npcHostileEffectiveRangeMeters);
  }

  const attributeMap = buildNpcHostileModuleAttributeMap(entity, moduleItem);
  const effectRecord = resolveNpcModuleEffectRecord(
    moduleItem,
    (candidateEffectRecord) => Boolean(
      hostileModuleRuntime.resolveHostileDefinition(candidateEffectRecord) ||
      jammerModuleRuntime.resolveJammerDefinition(candidateEffectRecord),
    ),
  );
  const definition = effectRecord
    ? (
        hostileModuleRuntime.resolveHostileDefinition(effectRecord) ||
        jammerModuleRuntime.resolveJammerDefinition(effectRecord)
      )
    : null;
  // Use the same effect-specific reach as activation, rather than the hull's gun range.
  // Adapted from ciefa/evejs-ciefa-fork 97cf914b9 (EVE-198).
  const reach = jammerModuleRuntime.resolveJammerDefinition(effectRecord)
    ? jammerModuleRuntime.resolveJammerReach(effectRecord, attributeMap)
    : hostileModuleRuntime.resolveHostileReach(definition, effectRecord, attributeMap);
  const effectiveRange = Math.max(
    0,
    round6(
      toFiniteNumber(reach.range.value, 0) +
      toFiniteNumber(reach.falloff.value, 0),
    ),
  );

  if (moduleItem && typeof moduleItem === "object") {
    moduleItem._npcHostileEffectiveRangeMeters = effectiveRange;
  }
  return effectiveRange;
}

function getNpcHostileModules(entity) {
  const fittedItems =
    isNativeNpcEntity(entity) && Array.isArray(entity && entity.fittedItems)
      ? entity.fittedItems
      : getNpcFittedModuleItems(entity);

  const fittedHostileModules = fittedItems
    .map((moduleItem) => ({
      moduleItem,
      effectName: String(moduleItem && moduleItem.npcEffectName || "").trim() || null,
      definition: resolveNpcHostileModuleDefinition(moduleItem),
    }))
    .filter((entry) => Boolean(entry.definition))
    .sort((left, right) => (
      toPositiveInt(left.moduleItem && left.moduleItem.flagID, 0) -
      toPositiveInt(right.moduleItem && right.moduleItem.flagID, 0)
    ));

  const hullHostileModules = isNativeNpcEntity(entity)
    ? getTypeEffectRecords(toPositiveInt(entity && entity.typeID, 0))
      .map((effectRecord, index) => {
        const definition =
          hostileModuleRuntime.resolveHostileDefinition(effectRecord) ||
          jammerModuleRuntime.resolveJammerDefinition(effectRecord);
        if (!definition) {
          return null;
        }
        return {
          moduleItem: buildNpcSyntheticHullEffectModuleItem(entity, effectRecord, index, {
            slotBase: 500,
          }),
          effectName: String(effectRecord && effectRecord.name || "").trim(),
          definition,
        };
      })
      .filter(Boolean)
    : [];

  // Third source: entity-EWAR expressed purely as SDE hull ATTRIBUTES (entity*Chance families)
  // with no corresponding dogma effect — the classic mission-rat case. Synthesize a hull-effect
  // module per active family so the same hostile/jammer runtimes activate it, gated on the rat's
  // own SDE activation chance and ranged/timed by its SDE companion attributes.
  const entityEwarModules = isNativeNpcEntity(entity)
    ? getNpcEntityEwarModules(entity)
    : [];

  return [
    ...fittedHostileModules,
    ...hullHostileModules,
    ...entityEwarModules,
  ].sort((left, right) => (
    toPositiveInt(left.moduleItem && left.moduleItem.flagID, 0) -
    toPositiveInt(right.moduleItem && right.moduleItem.flagID, 0)
  ));
}

// The SDE effect a synthetic entity-EWAR module runs, and the attribute the activation lane
// should read its range from.
//
// The effect record is looked up GLOBALLY by name rather than on the rat hull. That is the whole
// point of this path: these rats express the family as attributes and declare no matching dogma
// effect, so a hull-scoped lookup can never succeed (0 of 327 candidate rows match, by name or by
// guid). The record travels to the activation lane on the module item as `npcSyntheticHullEffectID`
// and is bound there — see `resolveNpcSyntheticHullEffectRecord` in runtime.js.
//
// These authoritative inputs have to exist before a module is worth building:
//
//  1. RANGE. `resolveHostileModuleActivation` reads range through
//     `getPreferredAttributeValue(map, [effectRecord.rangeAttributeID, maxRange(54)])`, so a hull
//     that does not declare the family's range attribute gets the hull's TURRET optimal instead —
//     a Khanid Mashtori scrambling at 250 km. Refuse instead. The SDE agrees: every entity-EWAR
//     range attribute defaults to 0 (`warpScrambleRange`, `entityTargetPaintMaxRange`,
//     `entityCapacitorDrainMaxRange`, `ECMRangeOptimal`) except `modifyTargetSpeedRange`, whose
//     one affected carrier declares no `speedFactor` and is inert either way.
//  2. The neut record binds range to 98 `energyNeutralizerRangeOptimal`, the module flavour, which
//     the five `entityCapacitorDrainAmount` rats do not declare — they carry 937. Rebind to the
//     range attribute the catalog actually read for this hull when the record's own is absent.
//  3. STRENGTH. The jammer lane requires at least one positive sensor-specific ECM strength.
//     Refuse a synthetic jammer that would only reach `UNSUPPORTED_MODULE`; this keeps the
//     `concordTargetJam` Customs hulls out of the attribute-only lane until that distinct effect's
//     max-locked-targets semantics are implemented.
function resolveEntityEwarEffectBinding(spec, attributeMap, runsThroughHostileLane) {
  const effectRecord = getEffectTypeRecord(getEffectIDByNames(spec && spec.effectName));
  if (!effectRecord) {
    return null;
  }

  const declaredValue = (attributeID) => (
    toPositiveInt(attributeID, 0) > 0
      ? toFiniteNumber(attributeMap && attributeMap[attributeID], 0)
      : 0
  );
  const recordRangeAttributeID = toPositiveInt(effectRecord.rangeAttributeID, 0);
  const rangeAttributeID = declaredValue(recordRangeAttributeID) > 0
    ? recordRangeAttributeID
    : (
      declaredValue(spec && spec.rangeAttributeID) > 0
        ? toPositiveInt(spec.rangeAttributeID, 0)
        : recordRangeAttributeID
    );

  if (!(declaredValue(rangeAttributeID) > 0)) {
    return null;
  }
  if (
    !runsThroughHostileLane &&
    !jammerModuleRuntime.hasUsableJammerStrength(attributeMap)
  ) {
    return null;
  }

  return {
    effectRecord,
    rangeAttributeID,
  };
}

// Build synthetic hostile modules from a rat hull's entity-EWAR attributes (SDE dogma).
// Dedupes against families the hull already supplies via a real dogma effect, so a rat that
// carries BOTH the effect and the chance attribute is not double-fitted.
function getNpcEntityEwarModules(entity) {
  const typeID = toPositiveInt(entity && entity.typeID, 0);
  if (!typeID) {
    return [];
  }
  const attributeMap = getTypeAttributeMap(typeID);
  const specs = resolveEntityEwarSpecs(attributeMap);
  if (!specs || specs.length <= 0) {
    return [];
  }

  // Families already covered by a real hull dogma effect (avoid duplicates).
  const coveredFamilies = new Set();
  for (const effectRecord of getTypeEffectRecords(typeID)) {
    const definition =
      hostileModuleRuntime.resolveHostileDefinition(effectRecord) ||
      jammerModuleRuntime.resolveJammerDefinition(effectRecord);
    if (definition && definition.family) {
      coveredFamilies.add(String(definition.family));
    }
  }

  const modules = [];
  specs.forEach((spec, index) => {
    const hostileDefinition =
      hostileModuleRuntime.resolveHostileDefinition({ name: spec.effectName });
    const definition =
      hostileDefinition ||
      jammerModuleRuntime.resolveJammerDefinition({ name: spec.effectName });
    if (!definition) {
      return;
    }
    if (definition.family && coveredFamilies.has(String(definition.family))) {
      return;
    }
    const effectBinding = resolveEntityEwarEffectBinding(
      spec,
      attributeMap,
      Boolean(hostileDefinition),
    );
    if (!effectBinding) {
      return;
    }
    const moduleItem = buildNpcSyntheticHullEffectModuleItem(
      entity,
      effectBinding.effectRecord,
      index,
      { slotBase: 700 },
    );
    if (!moduleItem) {
      return;
    }
    if (
      effectBinding.rangeAttributeID > 0 &&
      effectBinding.rangeAttributeID !== toPositiveInt(effectBinding.effectRecord.rangeAttributeID, 0)
    ) {
      moduleItem.npcSyntheticHullRangeAttributeID = effectBinding.rangeAttributeID;
    }
    // Stamp the SDE-derived range and activation chance. Range feeds
    // `estimateNpcHostileEffectiveRange`, the NPC-side approach gate; chance feeds the
    // per-attempt roll in `syncNpcHostileModules`. There is deliberately NO duration stamp:
    // the cycle time is the effect record's business, and every entity-EWAR effect in the SDE
    // already names the family's own duration attribute (`modifyTargetSpeed2` 513,
    // `warpScrambleForEntity` 505, `entityTargetPaint` 945, `npcEntityTrackingDisruptor` 2515,
    // `entitySensorDampen` 943, `entityECMFalloff` 929, `entityEnergyNeutralizerFalloff` 942),
    // which `resolveHostileModuleActivation` reads off this module's attribute map — the rat
    // hull's own. A `_npcEntityEwarDurationMs` field on the module item had no reader anywhere
    // and could not have had one that mattered: the runtime resolves duration from
    // `effectRecord.durationAttributeID`, never from the module item.
    if (spec.rangeMeters > 0) {
      moduleItem._npcHostileEffectiveRangeMeters = spec.rangeMeters;
    }
    moduleItem._npcEntityEwarFamily = spec.family;
    moduleItem._npcEntityEwarActivationChance = spec.activationChance;
    modules.push({
      moduleItem,
      // The SDE's own spelling, not the catalog's lowercase key, so the activation lane and the
      // client FX see the effect the module actually runs.
      effectName: String(effectBinding.effectRecord.name || spec.effectName),
      definition,
    });
  });
  return modules;
}

function getNpcAssistanceModules(entity) {
  const fittedItems =
    isNativeNpcEntity(entity) && Array.isArray(entity && entity.fittedItems)
      ? entity.fittedItems
      : getNpcFittedModuleItems(entity);

  const fittedAssistanceModules = fittedItems
    .map((moduleItem) => ({
      moduleItem,
      effectName: String(moduleItem && moduleItem.npcEffectName || "").trim() || null,
      definition: resolveNpcAssistanceModuleDefinition(moduleItem),
    }))
    .filter((entry) => Boolean(entry.definition))
    .sort((left, right) => (
      toPositiveInt(left.moduleItem && left.moduleItem.flagID, 0) -
      toPositiveInt(right.moduleItem && right.moduleItem.flagID, 0)
    ));

  const hullAssistanceModules = isNativeNpcEntity(entity)
    ? getTypeEffectRecords(toPositiveInt(entity && entity.typeID, 0))
      .map((effectRecord, index) => {
        const definition = assistanceModuleRuntime.resolveAssistanceDefinition(effectRecord);
        if (!definition) {
          return null;
        }
        const effectName = String(effectRecord && effectRecord.name || "").trim();
        return {
          moduleItem: buildNpcSyntheticHullEffectModuleItem(entity, effectRecord, index, {
            specialFxModuleTypeID:
              effectName.toLowerCase() === "npcbehaviorremoteshieldbooster"
                ? NPC_REMOTE_SHIELD_PRESENTATION_MODULE_TYPE_ID
                : null,
            slotBase: 700,
          }),
          effectName,
          definition,
        };
      })
      .filter(Boolean)
    : [];

  return [
    ...fittedAssistanceModules,
    ...hullAssistanceModules,
  ].sort((left, right) => (
    toPositiveInt(left.moduleItem && left.moduleItem.flagID, 0) -
    toPositiveInt(right.moduleItem && right.moduleItem.flagID, 0)
  ));
}

function getNpcSuperweaponModules(entity) {
  return isNativeNpcEntity(entity)
    ? getTypeEffectRecords(toPositiveInt(entity && entity.typeID, 0))
      .filter((effectRecord) => {
        const normalizedName = String(effectRecord && effectRecord.name || "")
          .trim()
          .toLowerCase();
        return (
          normalizedName === "entitysuperweapon" ||
          normalizedName === "entitysuperweaponlanceallraces"
        );
      })
      .map((effectRecord, index) => (
        buildNpcSyntheticHullEffectModuleItem(entity, effectRecord, index, {
          syntheticSuperweapon: true,
          slotBase: 900,
        })
      ))
      .filter(Boolean)
    : [];
}

function buildNpcWeaponModuleSnapshot(entity, moduleItem, options = {}) {
  if (!entity || !moduleItem) {
    return null;
  }

  const shipID = getNpcShipID(entity);
  const shipTypeID = toPositiveInt(entity && entity.typeID, 0);
  if (!shipID || !shipTypeID) {
    return null;
  }

  const shipItem = options.shipItem || {
    itemID: shipID,
    typeID: shipTypeID,
  };
  const hasExplicitCharge = Object.prototype.hasOwnProperty.call(
    options,
    "chargeItem",
  );
  const chargeItem = hasExplicitCharge
    ? options.chargeItem
    : getNpcLoadedChargeForModule(entity, moduleItem);
  const snapshotOptions = {
    characterID: getNpcPilotCharacterID(entity),
    shipItem,
    moduleItem,
    chargeItem,
    fittedItems: Array.isArray(options.fittedItems)
      ? options.fittedItems
      : getNpcFittedModuleItems(entity),
    activeModuleContexts: Array.isArray(options.activeModuleContexts)
      ? options.activeModuleContexts
      : [],
    additionalLocationModifierSources:
      Array.isArray(options.additionalLocationModifierSources)
        ? options.additionalLocationModifierSources
        : getScopedNpcLocationModifierSources(entity),
    ...(options.skillMap instanceof Map ? { skillMap: options.skillMap } : {}),
    ...(Array.isArray(options.directModuleModifierEntries)
      ? { directModuleModifierEntries: options.directModuleModifierEntries }
      : {}),
    ...(Array.isArray(options.directChargeModifierEntries)
      ? { directChargeModifierEntries: options.directChargeModifierEntries }
      : {}),
    ...(Array.isArray(options.hiddenModifierItems)
      ? { hiddenModifierItems: options.hiddenModifierItems }
      : {}),
  };
  const presentationSnapshot = buildWeaponModuleSnapshot(snapshotOptions);
  if (
    !presentationSnapshot ||
    moduleItem.npcCapitalHullDamageAuthority !== true ||
    moduleItem.npcSyntheticHullWeapon === true
  ) {
    return presentationSnapshot;
  }

  const targetAttackEffect = getTypeEffectRecords(shipTypeID)
    .find((effectRecord) => (
      String(effectRecord && effectRecord.name || "").trim().toLowerCase() ===
      "targetattack"
    )) || null;
  const hullModuleItem = targetAttackEffect
    ? buildNpcSyntheticHullEffectModuleItem(entity, targetAttackEffect, 0, {
      syntheticWeapon: true,
      capitalHullDamageAuthority: true,
      weaponFamily: presentationSnapshot.family,
      slotBase: 100,
    })
    : null;
  const hullSnapshot = hullModuleItem
    ? buildWeaponModuleSnapshot({
      ...snapshotOptions,
      moduleItem: hullModuleItem,
      chargeItem: null,
      directChargeModifierEntries: [],
    })
    : null;
  if (!hullSnapshot) {
    return presentationSnapshot;
  }

  return {
    ...presentationSnapshot,
    durationMs: hullSnapshot.durationMs,
    capNeed: hullSnapshot.capNeed,
    optimalRange: hullSnapshot.optimalRange,
    falloff: hullSnapshot.falloff,
    trackingSpeed: hullSnapshot.trackingSpeed,
    optimalSigRadius: hullSnapshot.optimalSigRadius,
    damageMultiplier: hullSnapshot.damageMultiplier,
    baseDamage: hullSnapshot.baseDamage,
    rawShotDamage: hullSnapshot.rawShotDamage,
    npcCapitalHullDamageAuthority: true,
    hullModuleAttributes: hullSnapshot.moduleAttributes,
  };
}

function estimateNpcWeaponEffectiveRange(entity, moduleItem) {
  const snapshot = buildNpcWeaponModuleSnapshot(entity, moduleItem);
  if (!snapshot) {
    return 0;
  }
  if (isMissileWeaponFamily(snapshot.family)) {
    return Math.max(0, round6(toFiniteNumber(snapshot.approxRange, 0)));
  }
  return Math.max(
    0,
    round6(
      toFiniteNumber(snapshot.optimalRange, 0) +
      toFiniteNumber(snapshot.falloff, 0),
    ),
  );
}

function getNpcEntityAttackDelayWindow(entity) {
  const shipTypeID = toPositiveInt(entity && entity.typeID, 0);
  if (!shipTypeID) {
    return {
      minMs: 0,
      maxMs: 0,
    };
  }
  const shipAttributes = getTypeAttributeMap(shipTypeID);
  const minMs = Math.max(
    0,
    round6(toFiniteNumber(shipAttributes && shipAttributes[ATTRIBUTE_ENTITY_ATTACK_DELAY_MIN], 0)),
  );
  const rawMaxMs = Math.max(
    0,
    round6(toFiniteNumber(shipAttributes && shipAttributes[ATTRIBUTE_ENTITY_ATTACK_DELAY_MAX], 0)),
  );
  return {
    minMs,
    maxMs: Math.max(minMs, rawMaxMs),
  };
}

function getNpcEntityAttackDelayMs(entity, salt = 0, fallbackMs = 0) {
  const window = getNpcEntityAttackDelayWindow(entity);
  if (window.maxMs <= 0) {
    return Math.max(0, round6(toFiniteNumber(fallbackMs, 0)));
  }
  if (window.maxMs <= window.minMs) {
    return window.minMs;
  }

  const entityID = toPositiveInt(entity && entity.itemID, 0);
  const typeID = toPositiveInt(entity && entity.typeID, 0);
  const seed = (
    (entityID * 31) +
    (typeID * 17) +
    (toPositiveInt(salt, 0) * 13)
  ) >>> 0;
  const spreadMs = Math.max(1, Math.floor(window.maxMs - window.minMs + 1));
  return round6(window.minMs + (seed % spreadMs));
}

function getNpcEntityMissileWeaponSource(entity) {
  const shipTypeID = toPositiveInt(entity && entity.typeID, 0);
  if (
    !entity ||
    entity.kind !== "ship" ||
    shipTypeID <= 0 ||
    !typeHasEffectName(shipTypeID, "missileLaunchingForEntity")
  ) {
    return null;
  }

  const shipAttributes = getTypeAttributeMap(shipTypeID);
  const missileTypeID = toPositiveInt(
    shipAttributes && shipAttributes[ATTRIBUTE_ENTITY_MISSILE_TYPE_ID],
    0,
  );
  if (missileTypeID <= 0) {
    return null;
  }

  const missileType = resolveItemByTypeID(missileTypeID);
  const missileAttributes = getTypeAttributeMap(missileTypeID);
  const damageMultiplier = Math.max(
    0,
    toFiniteNumber(shipAttributes[ATTRIBUTE_MISSILE_DAMAGE_MULTIPLIER], 1),
  );
  const velocityMultiplier = Math.max(
    0,
    toFiniteNumber(shipAttributes[ATTRIBUTE_MISSILE_ENTITY_VELOCITY_MULTIPLIER], 1),
  );
  const flightTimeMultiplier = Math.max(
    0,
    toFiniteNumber(shipAttributes[ATTRIBUTE_MISSILE_ENTITY_FLIGHT_TIME_MULTIPLIER], 1),
  );
  const aoeVelocityMultiplier = Math.max(
    0,
    toFiniteNumber(shipAttributes[ATTRIBUTE_MISSILE_ENTITY_AOE_VELOCITY_MULTIPLIER], 1),
  );
  const aoeCloudSizeMultiplier = Math.max(
    0,
    toFiniteNumber(shipAttributes[ATTRIBUTE_MISSILE_ENTITY_AOE_CLOUD_SIZE_MULTIPLIER], 1),
  );
  const baseDamage = {
    em: Math.max(0, toFiniteNumber(missileAttributes[ATTRIBUTE_EM_DAMAGE], 0)),
    thermal: Math.max(0, toFiniteNumber(missileAttributes[ATTRIBUTE_THERMAL_DAMAGE], 0)),
    kinetic: Math.max(0, toFiniteNumber(missileAttributes[ATTRIBUTE_KINETIC_DAMAGE], 0)),
    explosive: Math.max(0, toFiniteNumber(missileAttributes[ATTRIBUTE_EXPLOSIVE_DAMAGE], 0)),
  };
  const maxVelocity = Math.max(
    0,
    round6(toFiniteNumber(missileAttributes[ATTRIBUTE_MAX_VELOCITY], 0) * velocityMultiplier),
  );
  const flightTimeMs = Math.max(
    1,
    round6(
      toFiniteNumber(missileAttributes[ATTRIBUTE_EXPLOSION_DELAY], 1000) * flightTimeMultiplier,
    ),
  );

  return {
    family: "missileLauncher",
    sourceKind: "npcEntityMissile",
    moduleID: 0,
    moduleTypeID: 0,
    chargeTypeID: missileTypeID,
    chargeGroupID: toPositiveInt(missileType && missileType.groupID, 0),
    chargeCategoryID: toPositiveInt(missileType && missileType.categoryID, 8),
    chargeName: String(missileType && missileType.name || "Missile"),
    durationMs: Math.max(
      1,
      round6(toFiniteNumber(
        shipAttributes[ATTRIBUTE_MISSILE_LAUNCH_DURATION],
        toFiniteNumber(shipAttributes[ATTRIBUTE_SPEED], 1000),
      )),
    ),
    damageMultiplier,
    rawShotDamage: {
      em: round6(baseDamage.em * damageMultiplier),
      thermal: round6(baseDamage.thermal * damageMultiplier),
      kinetic: round6(baseDamage.kinetic * damageMultiplier),
      explosive: round6(baseDamage.explosive * damageMultiplier),
    },
    maxVelocity,
    flightTimeMs,
    explosionRadius: Math.max(
      1,
      round6(toFiniteNumber(missileAttributes[ATTRIBUTE_AOE_CLOUD_SIZE], 1) * aoeCloudSizeMultiplier),
    ),
    explosionVelocity: Math.max(
      0.001,
      round6(toFiniteNumber(missileAttributes[ATTRIBUTE_AOE_VELOCITY], 0.001) * aoeVelocityMultiplier),
    ),
    damageReductionFactor: Math.max(
      0.000001,
      Math.min(1, toFiniteNumber(missileAttributes[ATTRIBUTE_AOE_DAMAGE_REDUCTION_FACTOR], 1)),
    ),
    damageReductionSensitivity: Math.max(
      0.000001,
      round6(toFiniteNumber(
        missileAttributes[ATTRIBUTE_AOE_DAMAGE_REDUCTION_SENSITIVITY],
        DEFAULT_MISSILE_DAMAGE_REDUCTION_SENSITIVITY,
      )),
    ),
    approxRange: round6(maxVelocity * (flightTimeMs / 1000)),
    launchModules: [0],
  };
}

function resolveNpcPropulsionEffectName(moduleItem) {
  return resolveNpcCapabilityPropulsionEffectName(moduleItem);
}

function getNpcPropulsionModules(entity) {
  if (NPC_ENABLE_FITTED_PROPULSION_MODULES !== true) {
    return [];
  }

  return getNpcFittedModuleItems(entity)
    .map((moduleItem) => ({
      moduleItem,
      effectName: resolveNpcPropulsionEffectName(moduleItem),
    }))
    .filter((entry) => Boolean(entry.effectName))
    .sort((left, right) => {
      const leftPriority =
        left.effectName === PROPULSION_EFFECT_MICROWARPDRIVE ? 0 : 1;
      const rightPriority =
        right.effectName === PROPULSION_EFFECT_MICROWARPDRIVE ? 0 : 1;
      if (leftPriority !== rightPriority) {
        return leftPriority - rightPriority;
      }
      return (
        toPositiveInt(left.moduleItem && left.moduleItem.flagID, 0) -
        toPositiveInt(right.moduleItem && right.moduleItem.flagID, 0)
      );
    });
}

module.exports = {
  PROPULSION_EFFECT_AFTERBURNER,
  PROPULSION_EFFECT_MICROWARPDRIVE,
  isNativeNpcEntity,
  getNpcShipID,
  getNpcPilotCharacterID,
  getNpcFittedModuleItems,
  getNpcLoadedChargeForModule,
  getNpcWeaponBankGroupForModule,
  getNpcWeaponModules,
  getNpcHostileModules,
  getNpcAssistanceModules,
  getNpcSelfModules,
  getNpcSuperweaponModules,
  buildNpcWeaponModuleSnapshot,
  estimateNpcWeaponEffectiveRange,
  estimateNpcHostileEffectiveRange,
  estimateNpcAssistanceEffectiveRange,
  getNpcEntityAttackDelayWindow,
  getNpcEntityAttackDelayMs,
  getNpcEntityMissileWeaponSource,
  resolveNpcPropulsionEffectName,
  getNpcPropulsionModules,
};
