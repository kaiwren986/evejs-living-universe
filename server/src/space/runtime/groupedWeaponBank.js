"use strict";

module.exports = {
  buildBankedWeaponSnapshot,
  buildGroupedTurretBankPresentationEffectStates,
  cloneEffectStateForRuntimeModule,
  getStoredTurretEffectBankModuleIDs,
  reconcileActiveTurretWeaponBankEffectStates,
  resolveGroupedTurretBankModuleIDs,
  resolveGroupedWeaponBankContext,
  scaleDamageVector,
};

const runtimeEntryDirname = require("path").resolve(__dirname, "..");
const path = require("path");
const {
  getModulesInBank: getGroupedWeaponBankModuleIDs,
  getMasterModuleID: getGroupedWeaponBankMasterID,
} = require(path.join(runtimeEntryDirname, "../services/moduleGrouping/moduleGroupingRuntime"));
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
const {
  buildWeaponModuleSnapshot,
  isChargeOptionalTurretWeapon,
  isMissileWeaponFamily,
  isVortonWeaponFamily,
  isTurretCycleWeaponFamily,
  isDefenderMissileWeaponSnapshot,
  resolveWeaponFamily,
  resolveWeaponSpecialFxGUID,
} = require(path.join(runtimeEntryDirname, "./combat/weaponDogma"));
const {
  getEntityRuntimeLoadedCharge,
  getEntityRuntimeModuleItem,
} = require("./entityDogmaView");
const {
  roundNumber,
  toFiniteNumber,
  toInt,
} = require("../../common/numbers");

function scaleDamageVector(rawDamage, multiplier = 1) {
  const resolvedDamage =
    rawDamage && typeof rawDamage === "object"
      ? rawDamage
      : {};
  const resolvedMultiplier = Math.max(0, toFiniteNumber(multiplier, 0));
  return {
    em: roundNumber(toFiniteNumber(resolvedDamage.em, 0) * resolvedMultiplier, 6),
    thermal: roundNumber(toFiniteNumber(resolvedDamage.thermal, 0) * resolvedMultiplier, 6),
    kinetic: roundNumber(toFiniteNumber(resolvedDamage.kinetic, 0) * resolvedMultiplier, 6),
    explosive: roundNumber(toFiniteNumber(resolvedDamage.explosive, 0) * resolvedMultiplier, 6),
  };
}

function resolveGroupedWeaponBankContext(
  attackerEntity,
  effectState,
  moduleItem,
  options = {},
) {
  const fallbackModuleItem = moduleItem || null;
  const fallbackChargeItem = getEntityRuntimeLoadedCharge(
    attackerEntity,
    fallbackModuleItem,
  );
  const expectedFamily =
    typeof options.family === "string" && options.family
      ? options.family
      : resolveWeaponFamily(fallbackModuleItem, fallbackChargeItem);
  const shipID = toInt(attackerEntity && attackerEntity.itemID, 0);
  const requestedModuleID = toInt(fallbackModuleItem && fallbackModuleItem.itemID, 0);
  const resolvedMasterModuleID =
    shipID > 0 && requestedModuleID > 0
      ? (
        getGroupedWeaponBankMasterID(shipID, requestedModuleID) ||
        requestedModuleID
      )
      : requestedModuleID;
  const resolvedBankModuleIDs =
    shipID > 0 && resolvedMasterModuleID > 0
      ? getGroupedWeaponBankModuleIDs(shipID, resolvedMasterModuleID)
      : [];
  const candidateModuleIDs =
    Array.isArray(resolvedBankModuleIDs) && resolvedBankModuleIDs.length > 0
      ? resolvedBankModuleIDs
      : [requestedModuleID];
  const allEntries = [];
  const fallbackTypeID = toInt(fallbackModuleItem && fallbackModuleItem.typeID, 0);

  for (const candidateModuleID of candidateModuleIDs) {
    const candidateModuleItem = getEntityRuntimeModuleItem(
      attackerEntity,
      candidateModuleID,
    );
    if (!candidateModuleItem || !isModuleOnline(candidateModuleItem)) {
      continue;
    }
    if (
      fallbackTypeID > 0 &&
      toInt(candidateModuleItem.typeID, 0) !== fallbackTypeID
    ) {
      continue;
    }
    const candidateChargeItem = getEntityRuntimeLoadedCharge(
      attackerEntity,
      candidateModuleItem,
    );
    const candidateFamily = resolveWeaponFamily(
      candidateModuleItem,
      candidateChargeItem,
    );
    if (expectedFamily && candidateFamily !== expectedFamily) {
      continue;
    }
    allEntries.push({
      moduleItem: candidateModuleItem,
      chargeItem: candidateChargeItem,
    });
  }

  const fallbackEntry = {
    moduleItem: fallbackModuleItem,
    chargeItem: fallbackChargeItem,
  };
  const normalizedAllEntries = allEntries.length > 0 ? allEntries : [fallbackEntry];
  const entriesWithCharge = normalizedAllEntries.filter(
    (entry) => entry && entry.chargeItem,
  );
  let primaryEntry =
    entriesWithCharge.find(
      (entry) =>
        toInt(entry && entry.moduleItem && entry.moduleItem.itemID, 0) ===
        resolvedMasterModuleID,
    ) ||
    entriesWithCharge[0] ||
    normalizedAllEntries.find(
      (entry) =>
        toInt(entry && entry.moduleItem && entry.moduleItem.itemID, 0) ===
        resolvedMasterModuleID,
    ) ||
    normalizedAllEntries[0] ||
    fallbackEntry;
  const primaryChargeTypeID = toInt(
    primaryEntry && primaryEntry.chargeItem && primaryEntry.chargeItem.typeID,
    0,
  );
  const contributingEntries =
    primaryChargeTypeID > 0
      ? normalizedAllEntries.filter(
        (entry) =>
          toInt(entry && entry.chargeItem && entry.chargeItem.typeID, 0) ===
          primaryChargeTypeID,
      )
      : entriesWithCharge;
  if (contributingEntries.length > 0) {
    primaryEntry =
      contributingEntries.find(
        (entry) =>
          toInt(entry && entry.moduleItem && entry.moduleItem.itemID, 0) ===
          resolvedMasterModuleID,
      ) ||
      contributingEntries[0];
  }
  const launchModuleIDs = contributingEntries
    .map((entry) => toInt(entry && entry.moduleItem && entry.moduleItem.itemID, 0))
    .filter((moduleID) => moduleID > 0);

  return {
    masterModuleID: resolvedMasterModuleID,
    allEntries: normalizedAllEntries,
    contributingEntries,
    primaryEntry,
    launchModuleIDs,
    banked: launchModuleIDs.length > 1,
  };
}

function buildBankedWeaponSnapshot(weaponSnapshot, bankContext) {
  if (!weaponSnapshot) {
    return null;
  }
  const bankModuleIDs =
    bankContext && Array.isArray(bankContext.launchModuleIDs)
      ? bankContext.launchModuleIDs
      : [];
  const bankSize = Math.max(bankModuleIDs.length, 1);
  if (bankSize <= 1) {
    return {
      ...weaponSnapshot,
      isBanked: false,
      bankSize: 1,
      bankModuleIDs: bankModuleIDs.length > 0
        ? bankModuleIDs.map((moduleID) => toInt(moduleID, 0))
        : [toInt(weaponSnapshot.moduleID, 0)].filter((moduleID) => moduleID > 0),
    };
  }

  if (weaponSnapshot.npcCapitalHullDamageAuthority === true) {
    // A capital hull targetAttack profile already describes the whole attack.
    // Its fitted bank is retained for hardpoint presentation only.
    return {
      ...weaponSnapshot,
      isBanked: true,
      bankSize,
      bankModuleIDs: bankModuleIDs.map((moduleID) => toInt(moduleID, 0)),
    };
  }

  return {
    ...weaponSnapshot,
    damageMultiplier: roundNumber(
      toFiniteNumber(weaponSnapshot.damageMultiplier, 0) * bankSize,
      6,
    ),
    rawShotDamage: scaleDamageVector(weaponSnapshot.rawShotDamage, bankSize),
    isBanked: true,
    bankSize,
    bankModuleIDs: bankModuleIDs.map((moduleID) => toInt(moduleID, 0)),
  };
}

function resolveGroupedTurretBankModuleIDs(entity, moduleID, expectedTypeID = 0) {
  const shipID = toInt(entity && entity.itemID, 0);
  const normalizedModuleID = toInt(moduleID, 0);
  if (shipID <= 0 || normalizedModuleID <= 0) {
    return [];
  }

  const resolvedModuleIDs = [];
  const seenModuleIDs = new Set();
  for (const rawModuleID of getGroupedWeaponBankModuleIDs(shipID, normalizedModuleID)) {
    const numericModuleID = toInt(rawModuleID, 0);
    if (numericModuleID <= 0 || seenModuleIDs.has(numericModuleID)) {
      continue;
    }
    const moduleItem = getEntityRuntimeModuleItem(entity, numericModuleID);
    if (!moduleItem) {
      continue;
    }
    if (
      expectedTypeID > 0 &&
      toInt(moduleItem.typeID, 0) !== expectedTypeID
    ) {
      continue;
    }
    seenModuleIDs.add(numericModuleID);
    resolvedModuleIDs.push(numericModuleID);
  }
  return resolvedModuleIDs;
}

function buildGroupedTurretBankPresentationEffectStates(entity, effectState) {
  if (
    !entity ||
    !effectState ||
    !isTurretCycleWeaponFamily(effectState.weaponFamily)
  ) {
    return [effectState];
  }

  const effectModuleID = toInt(effectState.moduleID, 0);
  const effectTypeID = toInt(effectState.typeID, 0);
  const rawBankModuleIDs =
    Array.isArray(effectState.bankModuleIDs) && effectState.bankModuleIDs.length > 1
      ? effectState.bankModuleIDs
      : resolveGroupedTurretBankModuleIDs(entity, effectModuleID, effectTypeID);
  const normalizedBankModuleIDs = [...new Set(
    rawBankModuleIDs
      .map((moduleID) => toInt(moduleID, 0))
      .filter((moduleID) => moduleID > 0),
  )];
  if (normalizedBankModuleIDs.length <= 1) {
    return [effectState];
  }

  const presentationEffectStates = [];
  const seenModuleIDs = new Set();
  for (const bankModuleID of normalizedBankModuleIDs) {
    if (seenModuleIDs.has(bankModuleID)) {
      continue;
    }
    seenModuleIDs.add(bankModuleID);
    if (bankModuleID === effectModuleID) {
      presentationEffectStates.push(effectState);
      continue;
    }
    const moduleItem = getEntityRuntimeModuleItem(entity, bankModuleID);
    const chargeItem = moduleItem
      ? getEntityRuntimeLoadedCharge(entity, moduleItem)
      : null;
    presentationEffectStates.push({
      ...effectState,
      moduleID: bankModuleID,
      moduleFlagID: toInt(
        moduleItem && moduleItem.flagID,
        effectState.moduleFlagID,
      ),
      typeID: toInt(
        moduleItem && moduleItem.typeID,
        effectState.typeID,
      ),
      chargeTypeID: toInt(
        (chargeItem && chargeItem.typeID) || effectState.chargeTypeID,
        0,
      ),
    });
  }

  if (!seenModuleIDs.has(effectModuleID)) {
    presentationEffectStates.unshift(effectState);
  }

  return presentationEffectStates.length > 0
    ? presentationEffectStates
    : [effectState];
}

function cloneEffectStateForRuntimeModule(entity, effectState, moduleID, bankModuleIDs = null) {
  const moduleItem = getEntityRuntimeModuleItem(entity, moduleID);
  const chargeItem = moduleItem
    ? getEntityRuntimeLoadedCharge(entity, moduleItem)
    : null;
  const normalizedBankModuleIDs = Array.isArray(bankModuleIDs)
    ? [...new Set(
      bankModuleIDs
        .map((candidateModuleID) => toInt(candidateModuleID, 0))
        .filter((candidateModuleID) => candidateModuleID > 0),
    )]
    : null;

  return {
    ...effectState,
    moduleID: toInt(moduleID, 0),
    moduleFlagID: toInt(
      moduleItem && moduleItem.flagID,
      effectState && effectState.moduleFlagID,
    ),
    typeID: toInt(
      moduleItem && moduleItem.typeID,
      effectState && effectState.typeID,
    ),
    chargeTypeID: toInt(
      (chargeItem && chargeItem.typeID) ||
        (effectState && effectState.chargeTypeID),
      0,
    ),
    moduleItemSnapshot:
      moduleItem && typeof moduleItem === "object" ? { ...moduleItem } : null,
    chargeItemSnapshot:
      chargeItem && typeof chargeItem === "object" ? { ...chargeItem } : null,
    bankModuleIDs:
      normalizedBankModuleIDs && normalizedBankModuleIDs.length > 1
        ? normalizedBankModuleIDs
        : null,
    missileBankCycleContext: null,
    pendingMissileBankReloads: null,
  };
}

function getStoredTurretEffectBankModuleIDs(effectState) {
  const moduleIDs = Array.isArray(effectState && effectState.bankModuleIDs)
    ? effectState.bankModuleIDs
    : [];
  const normalizedModuleIDs = [...new Set(
    [
      toInt(effectState && effectState.moduleID, 0),
      ...moduleIDs,
    ]
      .map((moduleID) => toInt(moduleID, 0))
      .filter((moduleID) => moduleID > 0),
  )];
  return normalizedModuleIDs;
}

function reconcileActiveTurretWeaponBankEffectStates(entity, touchedModuleIDs = []) {
  if (!entity || !(entity.activeModuleEffects instanceof Map)) {
    return { changed: false, activeModuleIDs: [] };
  }

  const shipID = toInt(entity.itemID, 0);
  const touchedSet = new Set(
    (Array.isArray(touchedModuleIDs) ? touchedModuleIDs : [touchedModuleIDs])
      .map((moduleID) => toInt(moduleID, 0))
      .filter((moduleID) => moduleID > 0),
  );
  if (shipID <= 0 || touchedSet.size <= 0) {
    return { changed: false, activeModuleIDs: [] };
  }

  let changed = false;
  const activeModuleIDs = [];
  const consumedModuleIDs = new Set();
  const originalEffectStates = [...entity.activeModuleEffects.values()];

  for (const effectState of originalEffectStates) {
    if (
      !effectState ||
      effectState.isGeneric !== true ||
      !isTurretCycleWeaponFamily(effectState.weaponFamily)
    ) {
      continue;
    }

    const previousModuleIDs = getStoredTurretEffectBankModuleIDs(effectState)
      .filter((moduleID) => !consumedModuleIDs.has(moduleID));
    if (
      previousModuleIDs.length <= 0 ||
      !previousModuleIDs.some((moduleID) => touchedSet.has(moduleID))
    ) {
      continue;
    }

    for (const moduleID of previousModuleIDs) {
      consumedModuleIDs.add(moduleID);
    }

    const groupsByKey = new Map();
    for (const moduleID of previousModuleIDs) {
      const currentMasterID = getGroupedWeaponBankMasterID(shipID, moduleID);
      const currentBankModuleIDs =
        currentMasterID > 0
          ? getGroupedWeaponBankModuleIDs(shipID, currentMasterID)
            .map((candidateModuleID) => toInt(candidateModuleID, 0))
            .filter((candidateModuleID) => candidateModuleID > 0)
          : [];
      const activeCurrentBankModuleIDs = previousModuleIDs.filter(
        (candidateModuleID) => currentBankModuleIDs.includes(candidateModuleID),
      );
      const shouldRemainBanked =
        currentMasterID > 0 &&
        activeCurrentBankModuleIDs.length > 1 &&
        activeCurrentBankModuleIDs.includes(currentMasterID);
      const key = shouldRemainBanked
        ? `bank:${currentMasterID}`
        : `module:${moduleID}`;
      if (!groupsByKey.has(key)) {
        groupsByKey.set(key, {
          masterModuleID: shouldRemainBanked ? currentMasterID : moduleID,
          moduleIDs: shouldRemainBanked ? activeCurrentBankModuleIDs : [moduleID],
        });
      }
    }

    for (const moduleID of previousModuleIDs) {
      entity.activeModuleEffects.delete(moduleID);
    }

    for (const group of groupsByKey.values()) {
      const moduleIDs = [...new Set(
        (group.moduleIDs || [])
          .map((moduleID) => toInt(moduleID, 0))
          .filter((moduleID) => moduleID > 0),
      )].sort((left, right) => left - right);
      const masterModuleID = toInt(group.masterModuleID, moduleIDs[0]);
      if (masterModuleID <= 0 || moduleIDs.length <= 0) {
        continue;
      }
      entity.activeModuleEffects.set(
        masterModuleID,
        cloneEffectStateForRuntimeModule(
          entity,
          effectState,
          masterModuleID,
          moduleIDs.length > 1 ? moduleIDs : null,
        ),
      );
      activeModuleIDs.push(masterModuleID);
      changed = true;
    }
  }

  return {
    changed,
    activeModuleIDs: [...new Set(activeModuleIDs)].sort((left, right) => left - right),
  };
}
