"use strict";

module.exports = {
  executeMissileCycle,
  executeTurretCycle,
  queueAutomaticNpcTurretReload,
};

const runtimeEntryDirname = require("path").resolve(__dirname, "..");
const path = require("path");
const log = require(path.join(runtimeEntryDirname, "../utils/logger"));
const {
  applyDamageToEntity,
  applyResolvedDamageAmountToEntity,
  buildLiveDamageState,
  hasDamageableHealth,
  getEntityCurrentHealthLayers,
  getEntityMaxHealthLayers,
  sumDamageVector,
} = require(path.join(runtimeEntryDirname, "./combat/damage"));
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
  resolveVortonShot,
  resolveVortonArcShot,
  selectVortonArcTargets,
  isVortonArcTargetKind,
} = require(path.join(runtimeEntryDirname, "./combat/vortonProjectors"));
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
  queueAutomaticLocalModuleReload,
  resolvePendingLocalModuleReload,
} = require(path.join(runtimeEntryDirname, "./modules/localCycleReloads"));
const {
  noteDamage: noteKillmailDamage,
  resolveHighestDamageAttacker,
  enqueueKillmailFromDestruction: recordKillmailFromDestruction,
  recoverPendingKillmailWork,
} = require(path.join(runtimeEntryDirname, "./combat/killmailTracker"));
const {
  getAutoTargetingMissileRangeMeters,
  isAutoTargetingMissileCharge,
  isAutoTargetingMissileHostileCandidate,
  resolveAutoTargetingMissileNpcPackKey,
  resolveAutoTargetingMissileTarget,
} = require("./autoTargetingMissiles");
const {
  getAppliedDamageAmount,
  getCombatMessageHitQuality,
  notifyWeaponDamageMessages,
} = require("./combatDamageMessages");
const {
  recordCrimewatchOffensiveAggression,
} = require("./crimewatchAdapter");
const {
  resolveInvalidDestinyMissileFollowReason,
} = require("./destinyMovementEngine");
const {
  getEntitySurfaceDistance,
} = require("./entityDistance");
const {
  getEntityRuntimeLoadedCharge,
  getEntityRuntimeModuleItem,
  getEntityRuntimeShipItem,
} = require("./entityDogmaView");
const {
  getOwningSessionForEntity,
} = require("./entityOwnerSession");
const {
  buildBankedWeaponSnapshot,
  resolveGroupedWeaponBankContext,
} = require("./groupedWeaponBank");
const {
  applyCrystalVolatilityDamage,
  consumeTurretAmmoCharge,
} = require("./loadedChargeState");
const { buildCrystalDurabilitySnapshot, isCrystalBurnedOut } = require("../../services/dogma/crystalDurability");
const { getTypeDogmaAttributes } = require("../../services/fitting/liveFittingState");
const {
  resolveEffectiveModuleReloadTimeMs,
} = require("./moduleAttributes");
const {
  broadcastVortonCycleSpecialFx,
} = require("./moduleSpecialFx");
const {
  queueGroupedMissileReloadStates,
} = require("./moduleChargeReload");
const {
  roundNumber,
  toFiniteNumber,
  toInt,
} = require("../../common/numbers");
const {
  buildMissileLaunchRangeDebugContext,
  logMissileDebug,
  normalizeTraceValue,
  summarizeRuntimeEntityForMissileDebug,
} = require("./runtimeDebugInstrumentation");
const {
  lazyRequire,
} = require("./runtimeModuleBoundary");
const {
  applyWeaponDamageToTarget,
} = require("./targetDamageApplication");
const {
  isEntityLockedTarget,
} = require("./targeting");
const {
  consumeVortonArcPlan,
  resolveVortonArcChain,
} = require("./vortonArcChain");
const {
  buildWeaponSnapshotForEntity,
  isValidWeaponSnapshotTarget,
  resolveTurretShotWithConfiguredAdditive,
} = require("./weaponSnapshot");

function executeTurretCycle(scene, attackerEntity, effectState, cycleBoundaryMs) {
  const moduleItem = getEntityRuntimeModuleItem(
    attackerEntity,
    toInt(effectState && effectState.moduleID, 0),
    toInt(effectState && effectState.moduleFlagID, 0),
  );
  if (!attackerEntity || !effectState || !moduleItem) {
    return {
      success: false,
      errorMsg: "MODULE_NOT_FOUND",
      stopReason: "module",
    };
  }

  const chargeItem = getEntityRuntimeLoadedCharge(attackerEntity, moduleItem);
  const family = resolveWeaponFamily(moduleItem, chargeItem);
  const chargeOptionalTurretWeapon = isChargeOptionalTurretWeapon(
    moduleItem,
    chargeItem,
  );
  if (!isTurretCycleWeaponFamily(family)) {
    return {
      success: false,
      errorMsg: "UNSUPPORTED_WEAPON",
      stopReason: "weapon",
    };
  }
  const bankContext = resolveGroupedWeaponBankContext(
    attackerEntity,
    effectState,
    moduleItem,
    {
      family,
    },
  );
  const armedEntries = bankContext.contributingEntries.filter(
    (entry) => entry && entry.chargeItem,
  );
  if (
    !chargeOptionalTurretWeapon &&
    (armedEntries.length <= 0 || !chargeItem)
  ) {
    const reloadState = queueAutomaticNpcTurretReload(
      scene,
      attackerEntity,
      moduleItem,
      toInt(effectState && effectState.chargeTypeID, 0),
      cycleBoundaryMs,
    );
    return {
      success: true,
      data: {
        moduleItem,
        chargeItem: null,
        targetEntity: null,
        weaponSnapshot: null,
        shotResult: null,
        damageResult: null,
        destroyResult: null,
        crystalResult: null,
        ammoResult: null,
        reloadState,
      stopReason: reloadState ? null : "ammo",
      },
    };
  }
  const activeTurretEntries =
    armedEntries.length > 0
      ? armedEntries
      : [{
        moduleItem,
        chargeItem: null,
      }];

  const targetEntity = scene.getEntityByID(effectState.targetID);
  if (
    !targetEntity ||
    !isEntityLockedTarget(attackerEntity, effectState.targetID)
  ) {
    return {
      success: false,
      errorMsg: "TARGET_NOT_FOUND",
      stopReason: "target",
    };
  }

  const invalidMissileTargetReason = resolveInvalidDestinyMissileFollowReason(
    attackerEntity,
    targetEntity,
  );
  if (invalidMissileTargetReason) {
    return {
      success: false,
      errorMsg: "TARGET_NOT_FOUND",
      stopReason: "target",
      data: {
        invalidMissileTargetReason,
      },
    };
  }

  const shipRecord = getEntityRuntimeShipItem(attackerEntity);
  if (!shipRecord) {
    return {
      success: false,
      errorMsg: "SHIP_NOT_FOUND",
      stopReason: "ship",
    };
  }

  const weaponSnapshot = buildWeaponSnapshotForEntity(
    attackerEntity,
    bankContext.primaryEntry && bankContext.primaryEntry.moduleItem
      ? bankContext.primaryEntry.moduleItem
      : moduleItem,
    bankContext.primaryEntry && bankContext.primaryEntry.chargeItem
      ? bankContext.primaryEntry.chargeItem
      : chargeItem,
    {
      shipItem: shipRecord,
    },
  );
  if (!weaponSnapshot) {
    return {
      success: false,
      errorMsg: "UNSUPPORTED_WEAPON",
      stopReason: "weapon",
    };
  }
  const resolvedWeaponSnapshot = buildBankedWeaponSnapshot(
    weaponSnapshot,
    bankContext,
  );
  if (resolvedWeaponSnapshot.chargeMode === "crystal") {
    for (const entry of activeTurretEntries) {
      const crystal = entry.chargeItem;
      if (isCrystalBurnedOut(crystal, buildCrystalDurabilitySnapshot(crystal?.typeID, getTypeDogmaAttributes(crystal?.typeID)))) {
        applyCrystalVolatilityDamage(scene, attackerEntity, entry.moduleItem, crystal, cycleBoundaryMs, { cycleState: effectState });
        return { success: false, errorMsg: "NO_AMMO", stopReason: "ammo" };
      }
    }
  }
  if (isPrecursorTurretFamily(resolvedWeaponSnapshot.family)) {
    synchronizePrecursorTurretEffectState(
      effectState,
      resolvedWeaponSnapshot,
      cycleBoundaryMs,
    );
    const surfaceDistance = getEntitySurfaceDistance(attackerEntity, targetEntity);
    if (surfaceDistance > toFiniteNumber(resolvedWeaponSnapshot.optimalRange, 0) + 1e-6) {
      return {
        success: true,
        data: {
          moduleItem,
          chargeItem,
          targetEntity,
          weaponSnapshot: resolvedWeaponSnapshot,
          shotResult: null,
          damageResult: null,
          destroyResult: null,
          crystalResult: null,
          ammoResult: null,
          reloadState: null,
          stopReason: "range",
        },
      };
    }
  }
  const presentedWeaponSnapshot = isPrecursorTurretFamily(resolvedWeaponSnapshot.family)
    ? applyPrecursorTurretSpoolToSnapshot(resolvedWeaponSnapshot, effectState)
    : resolvedWeaponSnapshot;

  const isVortonCycle = isVortonWeaponFamily(presentedWeaponSnapshot.family);
  const shotResult = isVortonCycle
    ? resolveVortonShot({
      attackerEntity,
      targetEntity,
      weaponSnapshot: presentedWeaponSnapshot,
    })
    : resolveTurretShotWithConfiguredAdditive({
      attackerEntity,
      targetEntity,
      weaponSnapshot: presentedWeaponSnapshot,
    });
  let vortonArcChain = [];
  if (isVortonCycle) {
    const activationArcPlan = consumeVortonArcPlan(
      scene, effectState, targetEntity, cycleBoundaryMs,
    );
    if (shotResult.hit) {
      vortonArcChain = activationArcPlan || resolveVortonArcChain(
        scene, attackerEntity, targetEntity, presentedWeaponSnapshot,
      );
    }
    effectState.vortonArcTargetIDs = vortonArcChain.map(
      (link) => toInt(link.entity.itemID, 0),
    );
    // Activation already published the first shot's plan. Later shots need a
    // new ChainWeaponEffect: the client caches targets in its constructor and
    // ignores graphicInfo updates on an existing activation. Publish before
    // damage can destroy a target and remove its ball from observers' clients.
    if (activationArcPlan === null) {
      broadcastVortonCycleSpecialFx(scene, attackerEntity, effectState);
    }
  }
  let damageResult = null;
  let destroyResult = null;

  if (shotResult.hit && hasDamageableHealth(targetEntity)) {
    const weaponDamageResult = applyWeaponDamageToTarget(
      scene,
      attackerEntity,
      targetEntity,
      shotResult.shotDamage,
      cycleBoundaryMs,
      {fabricatorDamageKind:resolvedWeaponSnapshot.family === "vortonProjector" ? "vorton" : null},
    );
    damageResult = weaponDamageResult.damageResult;
    destroyResult = weaponDamageResult.destroyResult;
    const appliedDamageAmount = getAppliedDamageAmount(damageResult);
    if (appliedDamageAmount > 0) {
      noteKillmailDamage(attackerEntity, targetEntity, appliedDamageAmount, {
        whenMs: cycleBoundaryMs,
        weaponSnapshot: presentedWeaponSnapshot,
        moduleItem,
        chargeItem,
      });
    }
    if (destroyResult && destroyResult.success) {
      recordKillmailFromDestruction(targetEntity, destroyResult, {
        attackerEntity,
        victimSession: weaponDamageResult.victimSession,
        whenMs: cycleBoundaryMs,
        weaponSnapshot: presentedWeaponSnapshot,
        moduleItem,
        chargeItem,
      });
    }
  }

  notifyWeaponDamageMessages(
    attackerEntity,
    targetEntity,
    moduleItem,
    shotResult && shotResult.shotDamage,
    getAppliedDamageAmount(damageResult),
    getCombatMessageHitQuality(shotResult),
    {
      isBanked: bankContext.banked,
    },
  );
  // Chain lightning: every arc victim is picked by its distance to the PRIMARY
  // target, not to the previous link, and the bolt does not cascade onward.
  // Arcs are indiscriminate - anything damageable nearby is a candidate - so
  // each one carries the same security and NPC-aggro consequence a directly
  // fired shot would, exactly as the smartbomb's collateral damage does.
  const vortonArcResults = [];
  if (isVortonCycle && shotResult.hit) {
    for (const link of vortonArcChain) {
      const arcShotResult = resolveVortonArcShot({
        targetEntity: link.entity,
        weaponSnapshot: presentedWeaponSnapshot,
      });
      if (!arcShotResult.hit) {
        continue;
      }

      const arcDamage = applyWeaponDamageToTarget(
        scene,
        attackerEntity,
        link.entity,
        arcShotResult.shotDamage,
        cycleBoundaryMs,
        {fabricatorDamageKind:"vorton"},
      );
      const arcAppliedAmount = getAppliedDamageAmount(arcDamage.damageResult);
      if (arcAppliedAmount > 0) {
        noteKillmailDamage(attackerEntity, link.entity, arcAppliedAmount, {
          whenMs: cycleBoundaryMs,
          weaponSnapshot: presentedWeaponSnapshot,
          moduleItem,
          chargeItem,
        });
      }
      if (arcDamage.destroyResult && arcDamage.destroyResult.success) {
        recordKillmailFromDestruction(link.entity, arcDamage.destroyResult, {
          attackerEntity,
          victimSession: arcDamage.victimSession,
          whenMs: cycleBoundaryMs,
          weaponSnapshot: presentedWeaponSnapshot,
          moduleItem,
          chargeItem,
        });
      }
      notifyWeaponDamageMessages(
        attackerEntity,
        link.entity,
        moduleItem,
        arcShotResult.shotDamage,
        arcAppliedAmount,
        getCombatMessageHitQuality(arcShotResult),
        {
          isBanked: bankContext.banked,
        },
      );
      // A bounce is aggression even though the pilot never locked the victim.
      // EVE University records bounces initiating limited engagements with
      // ships that "were not targeted", and CCP shipped a fix for NPC kills by
      // a bounce that "wasn't targeted by any player directly" - so the arc has
      // to reach the same two authorities an ordinary shot does.
      recordCrimewatchOffensiveAggression(
        scene,
        attackerEntity,
        link.entity,
        cycleBoundaryMs,
      );
      try {
        const npcService = lazyRequire("./npc");
        if (npcService && typeof npcService.noteNpcIncomingAggression === "function") {
          npcService.noteNpcIncomingAggression(
            link.entity,
            attackerEntity,
            cycleBoundaryMs,
          );
        }
      } catch (error) {
        log.warn(`[SpaceRuntime] Vorton arc NPC aggression hook failed: ${error.message}`);
      }
      vortonArcResults.push({
        targetEntityID: toInt(link.entity.itemID, 0),
        linkIndex: link.linkIndex,
        distanceFromPrimaryTarget: link.distanceFromPrimaryTarget,
        shotResult: arcShotResult,
        damageResult: arcDamage.damageResult,
        destroyResult: arcDamage.destroyResult,
      });
    }
  }
  if (isPrecursorTurretFamily(resolvedWeaponSnapshot.family)) {
    advancePrecursorTurretSpool(effectState, resolvedWeaponSnapshot, cycleBoundaryMs);
  }

  const chargeResults = [];
  let resolvedChargeItem = chargeItem;
  let reloadState = null;
  let groupedAmmoFailure = false;
  let groupedAmmoStopReason = null;
  for (const entry of activeTurretEntries) {
    const currentModuleItem = entry.moduleItem;
    const currentChargeItem = entry.chargeItem;
    if (!currentChargeItem && chargeOptionalTurretWeapon) {
      chargeResults.push({
        success: true,
        data: {
          chargeItem: null,
          depleted: false,
          burnedOut: false,
          stopReason: null,
        },
      });
      if (
        !reloadState &&
        currentModuleItem &&
        toInt(currentModuleItem.itemID, 0) === toInt(moduleItem.itemID, 0)
      ) {
        resolvedChargeItem = null;
      }
      continue;
    }
    const chargeResult = resolvedWeaponSnapshot.chargeMode === "crystal"
      ? applyCrystalVolatilityDamage(
        scene,
        attackerEntity,
        currentModuleItem,
        currentChargeItem,
        cycleBoundaryMs,
        { cycleState: effectState },
      )
      : consumeTurretAmmoCharge(
        attackerEntity,
        currentModuleItem,
        currentChargeItem,
        cycleBoundaryMs,
      );
    chargeResults.push(chargeResult);
    if (
      !reloadState &&
      currentModuleItem &&
      toInt(currentModuleItem.itemID, 0) === toInt(moduleItem.itemID, 0)
    ) {
      resolvedChargeItem =
        chargeResult && chargeResult.success === true && chargeResult.data
          ? (
            Object.prototype.hasOwnProperty.call(chargeResult.data, "chargeItem")
              ? chargeResult.data.chargeItem
              : currentChargeItem
          )
          : currentChargeItem;
    }
    if (!chargeResult.success) {
      groupedAmmoFailure = true;
      groupedAmmoStopReason = groupedAmmoStopReason || "ammo";
      continue;
    }
    if (
      !reloadState &&
      attackerEntity.nativeNpc === true &&
      chargeResult.data &&
      (chargeResult.data.depleted || chargeResult.data.burnedOut)
    ) {
      reloadState = queueAutomaticNpcTurretReload(
        scene,
        attackerEntity,
        currentModuleItem,
        toInt(currentChargeItem && currentChargeItem.typeID, 0),
        cycleBoundaryMs,
      );
    }
    if (
      chargeResult.data &&
      (
        chargeResult.data.burnedOut ||
        chargeResult.data.depleted
      ) &&
      !reloadState
    ) {
      groupedAmmoStopReason = groupedAmmoStopReason || "ammo";
    }
  }
  if (!reloadState && !resolvedChargeItem) {
    resolvedChargeItem =
      chargeResults[0] && chargeResults[0].success && chargeResults[0].data
        ? (
          Object.prototype.hasOwnProperty.call(chargeResults[0].data, "chargeItem")
            ? chargeResults[0].data.chargeItem
            : chargeItem
        )
        : chargeItem;
  }

  return {
    success: true,
    data: {
      moduleItem,
      chargeItem: resolvedChargeItem,
      targetEntity,
      weaponSnapshot: presentedWeaponSnapshot,
      shotResult,
      damageResult,
      destroyResult,
      vortonArcResults: isVortonCycle ? vortonArcResults : null,
      crystalResult: resolvedWeaponSnapshot.chargeMode === "crystal" ? chargeResults : null,
      ammoResult: resolvedWeaponSnapshot.chargeMode === "stack" ? chargeResults : null,
      reloadState,
      stopReason:
        groupedAmmoFailure
          ? "ammo"
          : (
            groupedAmmoStopReason ||
            (
              chargeResults.some(
                (chargeResult) =>
                  chargeResult &&
                  chargeResult.success === true &&
                  chargeResult.data &&
                  (
                    chargeResult.data.burnedOut ||
                    chargeResult.data.depleted
                  ),
              )
                ? (reloadState ? null : "ammo")
                : null
            ) ||
            (
              chargeResults[0] &&
              chargeResults[0].data &&
              chargeResults[0].stopReason
            ) ||
            null
          ),
    },
  };
}

function queueAutomaticNpcTurretReload(
  scene,
  attackerEntity,
  moduleItem,
  chargeTypeID,
  startedAtMs,
) {
  if (
    !scene ||
    !attackerEntity ||
    attackerEntity.nativeNpc !== true ||
    !moduleItem ||
    toInt(chargeTypeID, 0) <= 0
  ) {
    return null;
  }

  const ownerSession = getOwningSessionForEntity(scene, attackerEntity);
  const reloadResult = queueAutomaticLocalModuleReload({
    session: ownerSession,
    entity: attackerEntity,
    moduleItem,
    chargeTypeID: toInt(chargeTypeID, 0),
    reloadTimeMs: Math.max(
      0,
      resolveEffectiveModuleReloadTimeMs(moduleItem, attackerEntity),
    ),
    startedAtMs,
    shipID: toInt(attackerEntity.itemID, 0),
    ammoLocationID: toInt(attackerEntity.itemID, 0),
    resumeMode: "start",
  });
  return reloadResult.success && reloadResult.data
    ? reloadResult.data.reloadState || null
    : null;
}

function executeMissileCycle(
  scene,
  attackerEntity,
  effectState,
  cycleBoundaryMs,
  options = {},
) {
  const moduleItem = getEntityRuntimeModuleItem(
    attackerEntity,
    toInt(effectState && effectState.moduleID, 0),
    toInt(effectState && effectState.moduleFlagID, 0),
  );
  if (!attackerEntity || !effectState || !moduleItem) {
    return {
      success: false,
      errorMsg: "MODULE_NOT_FOUND",
      stopReason: "module",
    };
  }

  const chargeItem = getEntityRuntimeLoadedCharge(attackerEntity, moduleItem);
  const family = resolveWeaponFamily(moduleItem, chargeItem);
  if (!isMissileWeaponFamily(family) || !chargeItem) {
    return {
      success: false,
      errorMsg: "NO_AMMO",
      stopReason: "ammo",
    };
  }
  const bankContext = resolveGroupedWeaponBankContext(
    attackerEntity,
    effectState,
    moduleItem,
    {
      family,
    },
  );
  const armedEntries = bankContext.contributingEntries.filter(
    (entry) => entry && entry.chargeItem,
  );
  if (armedEntries.length <= 0) {
    const reloadStates = queueGroupedMissileReloadStates(
      scene,
      attackerEntity,
      effectState,
      bankContext.allEntries,
      cycleBoundaryMs,
    );
    if (reloadStates.length > 0) {
      return {
        success: true,
        data: {
          moduleItem,
          chargeItem: null,
          targetEntity: null,
          weaponSnapshot: null,
          missileEntity: null,
          ammoResult: [],
          reloadState: reloadStates[0] || null,
          bankReloadStates: reloadStates.length > 1 ? reloadStates : null,
          stopReason: null,
        },
      };
    }
    return {
      success: false,
      errorMsg: "NO_AMMO",
      stopReason: "ammo",
    };
  }
  const primaryEntry = bankContext.primaryEntry && bankContext.primaryEntry.chargeItem
    ? bankContext.primaryEntry
    : armedEntries[0];

  const shipRecord = getEntityRuntimeShipItem(attackerEntity);
  if (!shipRecord) {
    return {
      success: false,
      errorMsg: "SHIP_NOT_FOUND",
      stopReason: "ship",
    };
  }
  const weaponSnapshot = buildWeaponSnapshotForEntity(
    attackerEntity,
    primaryEntry.moduleItem,
    primaryEntry.chargeItem,
    {
      shipItem: shipRecord,
    },
  );
  if (!weaponSnapshot || !isMissileWeaponFamily(weaponSnapshot.family)) {
    return {
      success: false,
      errorMsg: "UNSUPPORTED_WEAPON",
      stopReason: "weapon",
    };
  }

  const autoTargetingMissileCharge =
    isAutoTargetingMissileCharge(primaryEntry.chargeItem);
  const previousTargetID = toInt(effectState.targetID, 0);
  const hostilePackKey = String(
    effectState.autoTargetingMissileHostilePackKey || "",
  ).trim();
  let targetEntity = scene.getEntityByID(effectState.targetID);
  const autoTargetCanUseCurrentTarget =
    autoTargetingMissileCharge &&
    targetEntity &&
    isAutoTargetingMissileHostileCandidate(
      targetEntity,
      attackerEntity,
      hostilePackKey,
    ) &&
    getEntitySurfaceDistance(attackerEntity, targetEntity) <=
      getAutoTargetingMissileRangeMeters(primaryEntry.chargeItem) + 1;
  if (
    autoTargetingMissileCharge &&
    !autoTargetCanUseCurrentTarget
  ) {
    targetEntity = resolveAutoTargetingMissileTarget(
      scene,
      attackerEntity,
      weaponSnapshot,
      primaryEntry.chargeItem,
      hostilePackKey,
    );
    effectState.targetID = toInt(targetEntity && targetEntity.itemID, 0);
  }
  if (
    !targetEntity ||
    (autoTargetingMissileCharge
      ? !(
          isAutoTargetingMissileHostileCandidate(
            targetEntity,
            attackerEntity,
            hostilePackKey,
          ) &&
          getEntitySurfaceDistance(attackerEntity, targetEntity) <=
            getAutoTargetingMissileRangeMeters(primaryEntry.chargeItem) + 1
        )
      : !isEntityLockedTarget(attackerEntity, effectState.targetID))
  ) {
    return {
      success: false,
      errorMsg: "TARGET_NOT_FOUND",
      stopReason: "target",
    };
  }
  if (!isValidWeaponSnapshotTarget(attackerEntity, targetEntity, weaponSnapshot)) {
    return {
      success: false,
      errorMsg: "TARGET_NOT_FOUND",
      stopReason: "target",
    };
  }
  const resolvedWeaponSnapshot = buildBankedWeaponSnapshot(
    weaponSnapshot,
    bankContext,
  );

  logMissileDebug("missile.cycle.context", () => ({
    sceneSystemID: scene.systemID,
    cycleBoundaryMs: roundNumber(toFiniteNumber(cycleBoundaryMs, 0), 3),
    attacker: summarizeRuntimeEntityForMissileDebug(attackerEntity),
    target: summarizeRuntimeEntityForMissileDebug(targetEntity),
    effectState: normalizeTraceValue({
      moduleID: effectState.moduleID,
      moduleFlagID: effectState.moduleFlagID,
      effectName: effectState.effectName,
      targetID: effectState.targetID,
      chargeTypeID: effectState.chargeTypeID,
    }),
    rangeContext: buildMissileLaunchRangeDebugContext(
      attackerEntity,
      targetEntity,
      resolvedWeaponSnapshot,
      moduleItem,
      primaryEntry.chargeItem,
    ),
  }));

  const chargeResults = [];
  let groupedAmmoFailure = false;
  const depletedEntries = [];
  if (resolvedWeaponSnapshot.family === "breacherPodLauncher" && armedEntries.length !== 1) {
    return { success: false, errorMsg: "UNSUPPORTED_BREACHER_BANK", stopReason: "weapon" };
  }
  // A breacher pod is launched, accepted, charged and published by
  // breacherPods; its charge use stands in for the bank's.
  const breacherLaunch = resolvedWeaponSnapshot.family === "breacherPodLauncher"
    ? require("../combat/breacherPods").stageLaunch({ scene, attacker: attackerEntity, target: targetEntity,
      snapshot: resolvedWeaponSnapshot, moduleItem: primaryEntry.moduleItem, chargeItem: primaryEntry.chargeItem,
      nowMs: cycleBoundaryMs, callbacks: require("./moduleRuntimeCallbacks").buildBombRuntimeCallbacks(scene) })
    : null;
  if (breacherLaunch && !breacherLaunch.success) return { ...breacherLaunch, stopReason: "weapon" };
  for (const entry of armedEntries) {
    const chargeResult = breacherLaunch ? breacherLaunch.data.consumption : consumeTurretAmmoCharge(
      attackerEntity,
      entry.moduleItem,
      entry.chargeItem,
      cycleBoundaryMs,
    );
    chargeResults.push({
      moduleItem: entry.moduleItem,
      chargeItem: entry.chargeItem,
      result: chargeResult,
    });
    if (!chargeResult.success) {
      groupedAmmoFailure = true;
      continue;
    }
    if (chargeResult.data && chargeResult.data.depleted) {
      depletedEntries.push(entry);
    }
  }
  if (groupedAmmoFailure && chargeResults.every((entry) => !entry.result || !entry.result.success)) {
    return {
      success: false,
      errorMsg: "NO_AMMO",
      stopReason: "ammo",
    };
  }

  logMissileDebug("missile.cycle.consume", () => ({
    sceneSystemID: scene.systemID,
    cycleBoundaryMs: roundNumber(toFiniteNumber(cycleBoundaryMs, 0), 3),
    banked: bankContext.banked,
    moduleIDs: bankContext.launchModuleIDs,
    consumeResults: normalizeTraceValue(
      chargeResults.map((entry) => ({
        moduleID: toInt(entry && entry.moduleItem && entry.moduleItem.itemID, 0),
        chargeTypeID: toInt(entry && entry.chargeItem && entry.chargeItem.typeID, 0),
        result: entry && entry.result ? entry.result : null,
      })),
    ),
  }));

  const launchResult = breacherLaunch || scene.launchMissile(
    attackerEntity,
    targetEntity.itemID,
    resolvedWeaponSnapshot,
    {
      launchTimeMs: cycleBoundaryMs,
      chargeItem: primaryEntry.chargeItem,
      moduleItem: primaryEntry.moduleItem,
      launchModules: bankContext.launchModuleIDs,
      // CCP parity: once a missile module is actively cycling, missiles are
      // always launched regardless of current distance to target.  Range is
      // validated once on initial Activate; after that the module keeps
      // firing.  The missile flies toward the target and expires after its
      // flightTime if it cannot reach.  Without this, an NPC orbiting at
      // high speed can temporarily drift outside approxRange, causing
      // launchMissile to fail with TARGET_OUT_OF_RANGE, which cascades to
      // module deactivation — breaking the cycle prematurely.
      skipRangeCheck: true,
      broadcastOptions:
        options && options.deferUntilVisibilitySync === true
          ? {
              deferUntilVisibilitySync: true,
            }
          : null,
    },
  );
  if (!launchResult.success || !launchResult.data) {
    return {
      success: false,
      errorMsg: launchResult.errorMsg || "MISSILE_SPAWN_FAILED",
      stopReason:
        launchResult.errorMsg === "TARGET_OUT_OF_RANGE"
          ? "target"
        : "weapon",
    };
  }

  if (autoTargetingMissileCharge) {
    effectState.autoTargetingMissileHostilePackKey =
      resolveAutoTargetingMissileNpcPackKey(targetEntity) || null;
  }

  const launchedTargetID = toInt(targetEntity.itemID, 0);
  if (
    autoTargetingMissileCharge &&
    launchedTargetID > 0 &&
    launchedTargetID !== previousTargetID
  ) {
    // A FOF cycle can acquire a replacement after its prior target explodes.
    // Treat that successful launch as a new offensive interaction so the
    // shared security and NPC aggro authorities cannot retain the old target.
    recordCrimewatchOffensiveAggression(
      scene,
      attackerEntity,
      targetEntity,
      cycleBoundaryMs,
    );
    try {
      const npcService = lazyRequire("./npc");
      if (npcService && typeof npcService.noteNpcIncomingAggression === "function") {
        npcService.noteNpcIncomingAggression(
          targetEntity,
          attackerEntity,
          cycleBoundaryMs,
        );
      }
    } catch (error) {
      log.warn(`[SpaceRuntime] NPC aggression FOF retarget hook failed: ${error.message}`);
    }
  }

  const reloadStates =
    depletedEntries.length > 0
      ? queueGroupedMissileReloadStates(
        scene,
        attackerEntity,
        effectState,
        depletedEntries,
        cycleBoundaryMs,
      )
      : [];
  const primaryChargeResult = chargeResults.find(
    (entry) =>
      toInt(entry && entry.moduleItem && entry.moduleItem.itemID, 0) ===
      toInt(primaryEntry && primaryEntry.moduleItem && primaryEntry.moduleItem.itemID, 0),
  );

  return {
    success: true,
    data: {
      moduleItem: primaryEntry.moduleItem,
      chargeItem:
        primaryChargeResult &&
        primaryChargeResult.result &&
        primaryChargeResult.result.success === true &&
        primaryChargeResult.result.data
          ? primaryChargeResult.result.data.chargeItem
          : primaryEntry.chargeItem,
      targetEntity,
      weaponSnapshot: resolvedWeaponSnapshot,
      missileEntity: launchResult.data.entity,
      ammoResult: chargeResults,
      reloadState: reloadStates[0] || null,
      bankReloadStates: reloadStates.length > 1 ? reloadStates : null,
      stopReason:
        groupedAmmoFailure && reloadStates.length <= 0
          ? "ammo"
          : (
            chargeResults.some(
              (entry) =>
                entry &&
                entry.result &&
                entry.result.data &&
                entry.result.data.depleted,
            ) &&
            reloadStates.length <= 0
          )
            ? "ammo"
            : null,
    },
  };
}
