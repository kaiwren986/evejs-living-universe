"use strict";

module.exports = {
  collectEntityActiveSelfModifierEffectsByItemID,
  collectEntityActiveShipAttributeModifierEntries,
  collectEntityWormholeLocationModifierSources,
  effectRecordSelfModifiesAttributes,
  effectRecordSelfModifiesProjectedAttributes,
  noteReactiveArmorHardenerDamage,
  resolveActiveShipModifierSourceAttributes,
};

const runtimeEntryDirname = require("path").resolve(__dirname, "..");
const path = require("path");
const {
  getFittedModuleItems,
  listFittedItemsForLocation,
  buildSlimModuleTuples,
  buildCharacterTargetingState,
  buildChargeTupleItemID,
  buildShipResourceState,
  SLOT_FAMILY_FLAGS,
  getAttributeIDByNames,
  getEffectIDByNames,
  getTypeDogmaAttributes,
  getTypeDogmaEffects,
  getTypeEffectRecords,
  getPassiveModifierEffectRecords,
  getTypeAttributeValue,
  getEffectTypeRecord,
  getRequiredSkillRequirements,
  getLoadedChargeByFlag,
  isChargeCompatibleWithModule,
  isModuleOnline,
  isStructureDogmaHost,
  resolveDogmaSkillMapForHost,
  appendDirectModifierEntries,
  buildEffectiveItemAttributeMap,
  indexOverloadEffectRecordsByModuleID,
  buildProjectedModuleSourceAttributeMap,
} = require(path.join(runtimeEntryDirname, "../services/fitting/liveFittingState"));
const commandBurstRuntime = require(path.join(
  runtimeEntryDirname,
  "./modules/commandBurstRuntime",
));
const assistanceModuleRuntime = require(path.join(
  runtimeEntryDirname,
  "./modules/assistanceModuleRuntime",
));
const hostileModuleRuntime = require(path.join(
  runtimeEntryDirname,
  "./modules/hostileModuleRuntime",
));
const reactiveArmorHardenerRuntime = require(path.join(
  runtimeEntryDirname,
  "./modules/reactiveArmorHardenerRuntime",
));
const wormholeEnvironmentRuntime = require(path.join(
  runtimeEntryDirname,
  "../services/exploration/wormholes/wormholeEnvironmentRuntime",
));
const {
  getAbyssalMgrServiceModule,
} = require("./abyssalServicePort");
const {
  getEntityRuntimeActiveModuleContexts,
  getEntityRuntimeFittedItems,
  getEntityRuntimeShipItem,
  getEntityRuntimeSkillMap,
  getShipEntityInventoryCharacterID,
} = require("./entityDogmaView");
const {
  resolveGenericModuleAttributeOverrides,
} = require("./moduleAttributes");
const {
  toFiniteNumber,
  toInt,
} = require("../../common/numbers");

const LIVE_SOURCE_ACTIVE_HARDENER_EFFECT_IDS = new Set([5230, 5231]);

function effectRecordSelfModifiesAttributes(effectRecord) {
  return (effectRecord && effectRecord.modifierInfo ? effectRecord.modifierInfo : [])
    .some((modifierInfo) => (
      modifierInfo &&
      String(modifierInfo.domain || "") === "itemID" &&
      String(modifierInfo.func || "") === "ItemModifier"
    ));
}

// True when activating this module rewrites attributes that its own always-on
// effects hand to the ship — the indirect route by which an activation with no
// ship-domain modifier of its own still changes the hull's numbers.
function effectRecordSelfModifiesProjectedAttributes(effectRecord, moduleItem) {
  if (!effectRecordSelfModifiesAttributes(effectRecord)) {
    return false;
  }
  const projectedAttributeIDs = new Set();
  for (const passiveEffect of getPassiveModifierEffectRecords(
    toInt(moduleItem && moduleItem.typeID, 0),
  )) {
    for (const modifierInfo of passiveEffect.modifierInfo || []) {
      if (modifierInfo && String(modifierInfo.func || "") === "ItemModifier") {
        projectedAttributeIDs.add(toInt(modifierInfo.modifyingAttributeID, 0));
      }
    }
  }
  if (projectedAttributeIDs.size === 0) {
    return false;
  }
  return (effectRecord.modifierInfo || []).some((modifierInfo) => (
    modifierInfo &&
    String(modifierInfo.domain || "") === "itemID" &&
    projectedAttributeIDs.has(toInt(modifierInfo.modifiedAttributeID, 0))
  ));
}

// Which running modules are currently rewriting their own attributes, keyed by
// module item. A module's always-on effects read its live attributes, not its
// declared ones, so an activation that self-assigns (the Assault Damage Control
// post-assigning resistanceMultiplier onto its own resonances) has to be visible
// to them or the whole active half of the module does nothing.
function collectEntityActiveSelfModifierEffectsByItemID(entity) {
  const effectsByItemID = new Map();
  for (const context of getEntityRuntimeActiveModuleContexts(entity)) {
    const moduleID = toInt(context && context.moduleItem && context.moduleItem.itemID, 0);
    const effectRecord = context && context.effectRecord;
    if (moduleID <= 0 || !effectRecord) {
      continue;
    }
    const selfModifies = (effectRecord.modifierInfo || []).some((modifierInfo) => (
      modifierInfo &&
      String(modifierInfo.domain || "") === "itemID" &&
      String(modifierInfo.func || "") === "ItemModifier"
    ));
    if (!selfModifies) {
      continue;
    }
    const existing = effectsByItemID.get(moduleID);
    if (existing) {
      existing.push(effectRecord);
    } else {
      effectsByItemID.set(moduleID, [effectRecord]);
    }
  }
  return effectsByItemID;
}

// Feed a Reactive Armor Hardener the damage its armour just took, per type.
// This is the module's only input: at the end of each cycle it ranks the four
// damage types by these totals and shifts resistance toward the ones on top.
function noteReactiveArmorHardenerDamage(targetEntity, damageResult) {
  if (
    !targetEntity ||
    !(targetEntity.activeModuleEffects instanceof Map) ||
    targetEntity.activeModuleEffects.size === 0 ||
    !damageResult ||
    !damageResult.data ||
    !Array.isArray(damageResult.data.perLayer)
  ) {
    return;
  }
  const armorLayer = damageResult.data.perLayer.find(
    (layer) => layer && layer.layer === "armor",
  );
  if (!armorLayer || !armorLayer.appliedRaw) {
    return;
  }
  const attributes =
    (targetEntity.passiveDerivedState && targetEntity.passiveDerivedState.attributes) || {};
  // Same declared order the module ranks by: EM, Explosive, Kinetic, Thermal.
  const [emID, explosiveID, kineticID, thermalID] =
    reactiveArmorHardenerRuntime.RESONANCE_ATTRIBUTE_IDS;
  const readResonance = (attributeID) => Math.max(
    0,
    toFiniteNumber(attributes[String(attributeID)] ?? attributes[attributeID], 1),
  );
  reactiveArmorHardenerRuntime.noteArmorDamageForReactiveHardener(
    targetEntity,
    armorLayer.appliedRaw,
    {
      em: readResonance(emID),
      explosive: readResonance(explosiveID),
      kinetic: readResonance(kineticID),
      thermal: readResonance(thermalID),
    },
  );
}

function resolveActiveShipModifierSourceAttributes(
  entity,
  activeModuleContext,
  activeModuleContexts,
  options = {},
) {
  const baseAttributes = buildEffectiveItemAttributeMap(
    activeModuleContext && activeModuleContext.moduleItem,
    activeModuleContext && activeModuleContext.chargeItem,
  );
  const effectID = toInt(
    activeModuleContext && activeModuleContext.effectRecord &&
      activeModuleContext.effectRecord.effectID,
    0,
  );
  // A Reactive Armor Hardener's resonances are not the module type's declared
  // 15% across the board — they are wherever this cycle's redistribution has
  // moved them, and they live on the effect state.
  if (effectID === reactiveArmorHardenerRuntime.EFFECT_ID_ADAPTIVE_ARMOR_HARDENER) {
    const resonanceOverrides =
      reactiveArmorHardenerRuntime.getReactiveArmorHardenerResonanceOverrides(
        activeModuleContext && activeModuleContext.effectState,
      );
    return resonanceOverrides
      ? { ...baseAttributes, ...resonanceOverrides }
      : baseAttributes;
  }

  // Everything that is not one of the two whitelisted hardener effects projects
  // from its own effective map — type attributes plus charge overrides — and
  // that map has no overload in it. An overloaded module would therefore go on
  // projecting its cold strength for ever, which is what a Sensor Booster did:
  // its own panel read 28.75% while the ship it was boosting still moved 25%.
  // `buildProjectedModuleSourceAttributeMap` is the same helper the three other
  // projection loops use (`weaponDogma#buildLocationModifiedAttributeMap`,
  // `weaponDogma#buildWeaponModuleSnapshot`, `liveModuleAttributes`), and it
  // returns the plain effective map untouched when the module is not
  // overloaded, so every cold path is unchanged.
  //
  // Cross-tabbed rather than assumed: exactly three effects in the SDE carry
  // `ItemModifier`+`shipID` rows fed by an attribute their own overload effect
  // raises - 5230 (108 types) and 5231 (152 types), both whitelisted below, and
  // 2670 `sensorBoosterActivePercentage` (16 types), which is the only one that
  // reaches this branch. Nothing else in the game changes value here.
  if (!LIVE_SOURCE_ACTIVE_HARDENER_EFFECT_IDS.has(effectID)) {
    const overloadEffectRecords =
      options.overloadEffectRecordsByModuleID instanceof Map
        ? options.overloadEffectRecordsByModuleID.get(toInt(
          activeModuleContext && activeModuleContext.moduleItem &&
            activeModuleContext.moduleItem.itemID,
          0,
        )) || null
        : null;
    if (!overloadEffectRecords) {
      return baseAttributes;
    }
    return buildProjectedModuleSourceAttributeMap(
      activeModuleContext.moduleItem,
      activeModuleContext.chargeItem,
      overloadEffectRecords,
    );
  }

  const shipItem = options.shipItem || getEntityRuntimeShipItem(entity);
  const moduleID = toInt(
    activeModuleContext && activeModuleContext.moduleItem &&
      activeModuleContext.moduleItem.itemID,
    0,
  );
  if (!shipItem || moduleID <= 0) {
    return baseAttributes;
  }

  const sourceContexts = activeModuleContexts.filter((context) => (
    toInt(context && context.moduleItem && context.moduleItem.itemID, 0) !== moduleID ||
    Boolean(context && context.effectState && context.effectState.isOverload === true)
  ));
  return resolveGenericModuleAttributeOverrides(
    getShipEntityInventoryCharacterID(entity, 0),
    shipItem,
    activeModuleContext.moduleItem,
    activeModuleContext.chargeItem,
    {
      fittedItems: options.fittedItems || getEntityRuntimeFittedItems(entity),
      skillMap: options.skillMap || getEntityRuntimeSkillMap(entity),
      activeModuleContexts: sourceContexts,
      additionalLocationModifierSources:
        options.additionalLocationModifierSources ||
        collectEntityWormholeLocationModifierSources(entity),
    },
  ) || baseAttributes;
}

function collectEntityActiveShipAttributeModifierEntries(entity, nowMs = Date.now()) {
  const modifierEntries =
    require("../../services/homefront/homefrontHooks").weather.shipModifiers(
      entity,
    );
  // Authored Traffic Stop flight response: twice normal speed after player
  // aggression. Keeping this in Dogma preserves ordinary web interactions.
  if (
    entity.nativeNpc &&
    entity.homefrontTrafficFleeing &&
    ["civilian", "smuggler"].includes(entity.homefrontRole)
  ) {
    modifierEntries.push({
      modifiedAttributeID: 37,
      operation: 6,
      value: 100,
      stackingPenalized: false,
      modifierSourceKey: `homefront-traffic:${entity.itemID}`,
    });
  }
  modifierEntries.push(...require("../../services/seasons/eventHooks").fabricatorBonuses.shipModifiers(entity));
  modifierEntries.push(...require("../../services/seasons/gallenteEventBonuses").shipModifiers(entity));

  const shipItem = getEntityRuntimeShipItem(entity);
  const activeModuleContexts = getEntityRuntimeActiveModuleContexts(entity);
  const hasLiveSourceActiveHardener = activeModuleContexts.some((context) => (
    LIVE_SOURCE_ACTIVE_HARDENER_EFFECT_IDS.has(toInt(
      context && context.effectRecord && context.effectRecord.effectID,
      0,
    ))
  ));
  const fittedItems = hasLiveSourceActiveHardener
    ? getEntityRuntimeFittedItems(entity)
    : null;
  const skillMap = hasLiveSourceActiveHardener
    ? getEntityRuntimeSkillMap(entity)
    : null;
  const additionalLocationModifierSources = hasLiveSourceActiveHardener
    ? collectEntityWormholeLocationModifierSources(entity)
    : null;
  // Indexed once for the whole rack rather than per module: the source map each
  // running module projects from has to carry its own overload.
  const overloadEffectRecordsByModuleID = indexOverloadEffectRecordsByModuleID(
    activeModuleContexts,
  );

  modifierEntries.push(
    ...wormholeEnvironmentRuntime.collectShipAttributeModifierEntriesForSystem(
      entity && entity.systemID,
    ),
  );
  const abyssalMgrService = getAbyssalMgrServiceModule();
  // Spawn-time weather summaries are replaced on every derived-state refresh.
  // Feed NPC weather through the same modifier pipeline as webs and repairs so
  // recomputing the hull preserves weather and composes it with live effects.
  if (
    entity && entity.nativeNpc === true &&
    abyssalMgrService &&
    typeof abyssalMgrService.collectAbyssalNpcShipAttributeModifierEntriesForEntity === "function"
  ) {
    modifierEntries.push(
      ...abyssalMgrService.collectAbyssalNpcShipAttributeModifierEntriesForEntity(entity),
    );
  }
  if (
    abyssalMgrService &&
    typeof abyssalMgrService.collectAbyssalShipAttributeModifierEntriesForShipID === "function"
  ) {
    modifierEntries.push(
      ...abyssalMgrService.collectAbyssalShipAttributeModifierEntriesForShipID(
        toInt(entity && entity.itemID, 0),
      ),
    );
  }

  for (const activeModuleContext of activeModuleContexts) {
    appendDirectModifierEntries(
      modifierEntries,
      resolveActiveShipModifierSourceAttributes(
        entity,
        activeModuleContext,
        activeModuleContexts,
        {
          shipItem,
          fittedItems,
          skillMap,
          additionalLocationModifierSources,
          overloadEffectRecordsByModuleID,
        },
      ),
      [activeModuleContext.effectRecord],
      "fittedModule",
    );
  }

  if (shipItem) {
    modifierEntries.push(
      ...commandBurstRuntime.collectModifierEntriesForItem(
        entity,
        shipItem,
        nowMs,
      ),
    );
  }

  modifierEntries.push(
    ...hostileModuleRuntime.collectModifierEntriesForTarget(entity),
  );
  modifierEntries.push(
    ...assistanceModuleRuntime.collectModifierEntriesForTarget(entity),
  );

  return modifierEntries;
}

function collectEntityWormholeLocationModifierSources(entity) {
  const locationModifierSources = [
    ...require("../../services/homefront/homefrontHooks").weather.locationModifiers(entity),
    ...wormholeEnvironmentRuntime.getLocationModifierSourcesForSystem(
      entity && entity.systemID,
    ),
  ];
  const abyssalMgrService = getAbyssalMgrServiceModule();
  if (
    abyssalMgrService &&
    typeof abyssalMgrService.collectAbyssalLocationModifierSourcesForEntity === "function"
  ) {
    locationModifierSources.push(
      ...abyssalMgrService.collectAbyssalLocationModifierSourcesForEntity(entity),
    );
  }
  locationModifierSources.push(...require("../../services/seasons/eventHooks").fabricatorBonuses.moduleSources(entity));
  locationModifierSources.push(...require("../../services/seasons/gallenteEventBonuses").moduleSources(entity));
  return locationModifierSources;
}

Object.assign(module.exports, {
  LIVE_SOURCE_ACTIVE_HARDENER_EFFECT_IDS,
});
