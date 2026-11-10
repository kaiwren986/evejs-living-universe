"use strict";

const path = require("path");

const {
  getTypeEffectRecords,
  isPassiveModifierSource,
  appendSelfItemModifierEntries,
  appendLocationModifierEntries,
  buildEffectiveItemAttributeMap,
  indexOverloadEffectRecordsByModuleID,
  buildProjectedModuleSourceAttributeMap,
  isStructureDogmaHost,
  resolveDogmaSkillMapForHost,
  applyModifierGroups,
} = require(path.join(__dirname, "../../services/fitting/liveFittingState"));
const {
  peekSkillEffectiveAttributes,
  collectShipModifierAttributes,
} = require(path.join(__dirname, "../combat/weaponDogma"));
const {
  buildNpcEffectiveModuleItem,
} = require(path.join(__dirname, "../npc/npcCapabilityResolver"));

function toInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function buildLiveModuleAttributeMap(
  shipItem,
  moduleItem,
  chargeItem,
  skillMap,
  fittedItems,
  activeModuleContexts,
  options = {},
) {
  if (!shipItem || !moduleItem) {
    return null;
  }

  const effectiveModuleItem = buildNpcEffectiveModuleItem(moduleItem);
  const attributes = buildEffectiveItemAttributeMap(effectiveModuleItem, chargeItem);
  // Callers may repair missing base data before the normal modifier chain.
  if (options.baseAttributeOverrides) {
    Object.assign(attributes, options.baseAttributeOverrides);
  }
  const modifierEntries = [];
  const overloadSelfEffectRecords = [];
  const isStructureHost = isStructureDogmaHost(shipItem);
  const resolvedSkillMap = resolveDogmaSkillMapForHost(0, shipItem, {
    skillMap: skillMap instanceof Map ? skillMap : new Map(),
  });
  const resolvedFittedItems = Array.isArray(fittedItems) ? fittedItems : [];
  const resolvedActiveModuleContexts = Array.isArray(activeModuleContexts)
    ? activeModuleContexts
    : [];
  const additionalLocationModifierSources = Array.isArray(
    options.additionalLocationModifierSources,
  )
    ? options.additionalLocationModifierSources
    : [];
  const additionalShipModifierEntries = !isStructureHost && Array.isArray(
    options.additionalShipModifierEntries,
  )
    ? options.additionalShipModifierEntries
    : [];
  const additionalDirectModifierEntries = Array.isArray(
    options.additionalDirectModifierEntries,
  )
    ? options.additionalDirectModifierEntries
    : [];
  const hiddenModifierItems = Array.isArray(options.hiddenModifierItems)
    ? options.hiddenModifierItems
    : null;
  const locationModifierDomains = isStructureHost
    ? new Set(["structureID", "charID"])
    : new Set(["shipID", "charID"]);
  const shipModifierAttributes = collectShipModifierAttributes(
    shipItem,
    resolvedSkillMap,
    resolvedActiveModuleContexts,
    {
      fittedItems: resolvedFittedItems,
      additionalDirectModifierEntries: additionalShipModifierEntries,
      ...(hiddenModifierItems ? { hiddenModifierItems } : {}),
    },
  );

  for (const skillRecord of resolvedSkillMap.values()) {
    appendLocationModifierEntries(
      modifierEntries,
      peekSkillEffectiveAttributes(skillRecord),
      getTypeEffectRecords(skillRecord.typeID),
      "skill",
      effectiveModuleItem,
      { allowedDomains: locationModifierDomains },
    );
  }

  appendLocationModifierEntries(
    modifierEntries,
    shipModifierAttributes,
    getTypeEffectRecords(shipItem.typeID),
    "ship",
    effectiveModuleItem,
    { allowedDomains: locationModifierDomains },
  );

  for (const fittedItem of resolvedFittedItems) {
    if (
      !isPassiveModifierSource(fittedItem) ||
      toInt(fittedItem && fittedItem.itemID, 0) === toInt(moduleItem.itemID, 0)
    ) {
      continue;
    }

    const effectiveFittedItem = buildNpcEffectiveModuleItem(fittedItem);
    appendLocationModifierEntries(
      modifierEntries,
      buildEffectiveItemAttributeMap(effectiveFittedItem),
      getTypeEffectRecords(effectiveFittedItem.typeID),
      "fittedModule",
      effectiveModuleItem,
      { allowedDomains: locationModifierDomains },
    );
  }

  // A module projecting onto another module (a Tracking Computer feeding a
  // turret, say) must project its overloaded strength when it is overloaded.
  const overloadEffectRecordsByModuleID = indexOverloadEffectRecordsByModuleID(
    resolvedActiveModuleContexts,
  );

  for (const activeModuleContext of resolvedActiveModuleContexts) {
    const activeModuleItem = buildNpcEffectiveModuleItem(
      activeModuleContext && activeModuleContext.moduleItem,
    );
    const activeEffectRecord =
      activeModuleContext && activeModuleContext.effectRecord
        ? activeModuleContext.effectRecord
        : null;
    if (!activeModuleItem || !activeEffectRecord) {
      continue;
    }

    if (
      (
        activeModuleContext &&
        activeModuleContext.effectState &&
        activeModuleContext.effectState.isOverload === true
      ) ||
      toInt(activeEffectRecord.effectCategoryID, 0) === 5
    ) {
      if (
        toInt(activeModuleItem.itemID, 0) ===
        toInt(effectiveModuleItem.itemID || moduleItem.itemID, 0)
      ) {
        overloadSelfEffectRecords.push(activeEffectRecord);
      }
    }

    appendLocationModifierEntries(
      modifierEntries,
      buildProjectedModuleSourceAttributeMap(
        activeModuleItem,
        activeModuleContext && activeModuleContext.chargeItem,
        overloadEffectRecordsByModuleID.get(toInt(activeModuleItem.itemID, 0)),
      ),
      [activeEffectRecord],
      "fittedModule",
      effectiveModuleItem,
      { allowedDomains: locationModifierDomains },
    );
  }

  for (const source of isStructureHost ? [] : additionalLocationModifierSources) {
    if (!source || typeof source !== "object") {
      continue;
    }
    appendLocationModifierEntries(
      modifierEntries,
      source.sourceAttributes,
      source.sourceEffects,
      String(source.sourceKind || "system"),
      effectiveModuleItem,
      { allowedDomains: locationModifierDomains },
    );
  }

  if (overloadSelfEffectRecords.length > 0) {
    const effectiveSourceAttributes = { ...attributes };
    applyModifierGroups(effectiveSourceAttributes, [
      ...modifierEntries,
      ...additionalDirectModifierEntries,
    ]);
    appendSelfItemModifierEntries(
      modifierEntries,
      effectiveSourceAttributes,
      overloadSelfEffectRecords,
      "fittedModule",
    );
  }

  applyModifierGroups(attributes, [
    ...modifierEntries,
    ...additionalDirectModifierEntries,
  ]);
  return attributes;
}

module.exports = {
  buildLiveModuleAttributeMap,
};
