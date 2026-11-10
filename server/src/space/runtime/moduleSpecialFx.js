"use strict";

module.exports = {
  broadcastVortonCycleSpecialFx,
  buildGenericModuleSpecialFxGraphicInfo,
  buildSpecialFxDestinyUpdates,
  isEntityUsingAlternateSlimCategory,
  isEntityUsingNpcShipHardpointPresentation,
  resolveGenericModuleControlSpecialFxGuid,
  resolveGenericModuleSpecialFxGuid,
  splitSpecialFxGuids,
};

const runtimeEntryDirname = require("path").resolve(__dirname, "..");
const path = require("path");
const {
  buildCloakBallPresentationUpdates,
  buildCloakDeliveryPresentationUpdates,
  buildDamageStatePresentationUpdates,
  buildDbuffPresentationUpdates,
  buildOwnerUncloakPresentationUpdates,
  buildSingleSpecialFxPresentationUpdates,
  buildSlimItemPresentationUpdates,
  buildStructureLifecyclePresentationUpdates,
  buildTetherPresentationUpdates,
  buildUncloakDeliveryPresentationUpdates,
  createSpecialFxPayloadPresentation,
} = require(path.join(
  runtimeEntryDirname,
  "./destiny/presentation/specialFxPayloads.js",
));
const destiny = require(path.join(runtimeEntryDirname, "./destiny/index.js"));
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
  ATTRIBUTE_DAMAGE_MULTIPLIER_BONUS_CURRENT,
  ATTRIBUTE_DAMAGE_MULTIPLIER_BONUS_MAX_TIMESTAMP,
  isPrecursorTurretFamily,
  initializePrecursorTurretEffectState,
  synchronizePrecursorTurretEffectState,
  advancePrecursorTurretSpool,
  resetPrecursorTurretSpool,
  buildPrecursorTurretGraphicInfo,
  applyPrecursorTurretSpoolToSnapshot,
} = require(path.join(runtimeEntryDirname, "./combat/precursorTurrets"));
const {
  roundNumber,
  toFiniteNumber,
  toInt,
} = require("../../common/numbers");
const {
  isOffensiveWeaponFamily,
} = require("./weaponSnapshot");

const VORTON_CHAIN_VISUAL_GUIDS = new Set([
  "effects.UpwellChainWeaponSmall",
  "effects.UpwellChainWeaponMedium",
  "effects.UpwellChainWeaponLarge",
]);

function splitSpecialFxGuids(guid, options = {}) {
  const normalizedGuid = String(guid || "").trim();
  if (!normalizedGuid) {
    return [];
  }
  const entries = normalizedGuid
    .split(",")
    .map((entry) => String(entry || "").trim())
    .filter(Boolean);
  if (options.preserveSpecialFxGuidOrder === true) {
    return entries;
  }
  if (entries.length > 1) {
    const attackModeIndex = entries.indexOf("effects.AttackMode");
    const trigIndex = entries.indexOf("effects.TriglavianBeam");
    if (attackModeIndex >= 0 && trigIndex >= 0 && attackModeIndex > trigIndex) {
      const reordered = [...entries];
      reordered.splice(attackModeIndex, 1);
      reordered.splice(trigIndex, 0, "effects.AttackMode");
      return reordered;
    }
  }
  return entries;
}

function resolveGenericModuleSpecialFxGuid(effectRecord, options = {}) {
  const capturedNpcGuid = String(
    options.moduleItem && options.moduleItem.npcSpecialFxGuid || "",
  ).trim();
  if (capturedNpcGuid) {
    return capturedNpcGuid;
  }

  const weaponGuid =
    (
      options.weaponSnapshot &&
      typeof options.weaponSnapshot.effectGUID === "string" &&
      options.weaponSnapshot.effectGUID
    ) ||
    resolveWeaponSpecialFxGUID({
      family: options.weaponFamily,
      moduleItem: options.moduleItem,
      chargeItem: options.chargeItem,
      activationEffect: effectRecord,
    }) ||
    "";
  if (weaponGuid) {
    return weaponGuid;
  }

  return String(effectRecord && effectRecord.guid || "");
}

function resolveGenericModuleControlSpecialFxGuid(effectState) {
  const guid = String(effectState && effectState.guid || "");
  if (!isVortonWeaponFamily(effectState && effectState.weaponFamily)) {
    return guid;
  }
  // Chain visuals have their own one-shot lifetime. A terminal Stop can run
  // before the client's queued Shoot, suppressing the shot and orphaning arcs.
  // Start/replacement is explicit; terminal deactivation stops only control FX.
  return splitSpecialFxGuids(guid)
    .filter((entry) => !VORTON_CHAIN_VISUAL_GUIDS.has(entry))
    .join(",");
}

function buildGenericModuleSpecialFxGraphicInfo(effectState) {
  // effects/EMPWave.py Prepare reads graphicInfo.graphicID when graphicInfo is
  // not None, and takes the wave's radius from the module type's
  // empFieldRange. Any other KeyVal raises AttributeError there, the wave never
  // loads, and its Stop then fails with "ShipEffect: no effect defined".
  if (effectState && effectState.smartbombEffect === true) {
    return null;
  }

  if (effectState && effectState.pointDefenseEffect === true) {
    const graphicInfo =
      effectState.pointDefenseGraphicInfo &&
      typeof effectState.pointDefenseGraphicInfo === "object"
        ? { ...effectState.pointDefenseGraphicInfo }
        : {};
    if (!Object.prototype.hasOwnProperty.call(graphicInfo, "candidateTypeListId")) {
      graphicInfo.candidateTypeListId = -1;
    }
    if (!Object.prototype.hasOwnProperty.call(graphicInfo, "trackTargets")) {
      graphicInfo.trackTargets = false;
    }
    if (
      !Object.prototype.hasOwnProperty.call(graphicInfo, "hitRange") &&
      toFiniteNumber(effectState.pointDefenseRangeMeters, 0) > 0
    ) {
      graphicInfo.hitRange = roundNumber(effectState.pointDefenseRangeMeters, 3);
    }
    return graphicInfo;
  }

  // effects/turrets.py#ChainWeaponEffect reads graphicInfo['targets'] and logs
  // "No 'targets' in graphic info... no additional targets used" without it,
  // then draws primary -> targets[0] -> targets[1] ... in the order given. Ship
  // the arc victims even when the list is empty, so the client takes the quiet
  // "no arcs this shot" branch instead of the error branch.
  if (effectState && isVortonWeaponFamily(effectState.weaponFamily)) {
    return {
      targets: Array.isArray(effectState.vortonArcTargetIDs)
        ? effectState.vortonArcTargetIDs.map((targetID) => toInt(targetID, 0))
          .filter((targetID) => targetID > 0)
        : [],
    };
  }

  return buildPrecursorTurretGraphicInfo(effectState);
}

function broadcastVortonCycleSpecialFx(scene, entity, effectState, specialFxOptions = {}) {
  if (
    !scene ||
    typeof scene.broadcastSpecialFx !== "function" ||
    !entity ||
    !effectState ||
    !isVortonWeaponFamily(effectState.weaponFamily) ||
    effectState.suppressStartSpecialFx === true
  ) {
    return;
  }

  const options = {
    moduleID: effectState.moduleID,
    moduleTypeID: effectState.typeID,
    targetID: effectState.targetID || null,
    chargeTypeID: effectState.chargeTypeID || null,
    weaponFamily: effectState.weaponFamily,
    isOffensive: true,
    duration: effectState.durationMs,
    ...specialFxOptions,
    repeat: 0,
    graphicInfo: buildGenericModuleSpecialFxGraphicInfo(effectState),
  };
  for (const guid of splitSpecialFxGuids(effectState.guid)) {
    if (!VORTON_CHAIN_VISUAL_GUIDS.has(guid)) {
      continue;
    }
    // ChainWeaponEffect reads its targets only in the constructor. A stop
    // removes the old instance so the next shot can use the current arc list.
    if (effectState.suppressStopSpecialFx !== true) {
      scene.broadcastSpecialFx(entity.itemID, guid, {
        ...options,
        start: false,
        active: false,
      }, entity);
    }
    scene.broadcastSpecialFx(entity.itemID, guid, {
      ...options,
      start: true,
      active: true,
    }, entity);
  }
}

function isEntityUsingAlternateSlimCategory(entity) {
  if (!entity || entity.kind !== "ship") {
    return false;
  }

  const categoryID = toInt(entity.categoryID, 0);
  const slimCategoryID = toInt(
    entity.slimCategoryID,
    categoryID,
  );
  return categoryID > 0 && slimCategoryID > 0 && slimCategoryID !== categoryID;
}

function isEntityUsingNpcShipHardpointPresentation(entity) {
  return Boolean(
    entity &&
    entity.kind === "ship" &&
    (
      entity.nativeNpc === true ||
      entity.nativeNpcOccupied === true ||
      isEntityUsingAlternateSlimCategory(entity)
    )
  );
}

const {
  buildSpecialFxPayloadsForEntity,
  resolveSpecialFxOptionsForEntity,
} = createSpecialFxPayloadPresentation({
  destiny,
  isEntityUsingNpcShipHardpointPresentation,
  isOffensiveWeaponFamily,
  resolveSpecialFxOptionsForGuid: (guid, options) => (
    isVortonWeaponFamily(options.weaponFamily) &&
    VORTON_CHAIN_VISUAL_GUIDS.has(guid)
      ? { ...options, repeat: 0 }
      : options
  ),
  shouldUseShipKeyedSpecialFxModuleBinding: (visibilityEntity) => (
    isEntityUsingNpcShipHardpointPresentation(visibilityEntity)
  ),
  splitSpecialFxGuids,
});

function buildSpecialFxDestinyUpdates(
  entityID,
  guid,
  specialFxOptions,
  stamp,
  includeStopInSameUpdate = false,
) {
  return buildSingleSpecialFxPresentationUpdates({
    stamp,
    entityID,
    guid,
    specialFxOptions,
    includeStopInSameUpdate,
  });
}

Object.assign(module.exports, {
  buildSpecialFxPayloadsForEntity,
  resolveSpecialFxOptionsForEntity,
});
