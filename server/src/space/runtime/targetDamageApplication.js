"use strict";

module.exports = {
  applyResolvedEnvironmentalDamageToTarget,
  applyWeaponDamageToTarget,
  blockCrossSceneCombatIfNeeded,
  openStructureDamageWindow,
  recordStructureDamageWindow,
  resolveCombatSceneKey,
};

const runtimeEntryDirname = require("path").resolve(__dirname, "..");
const path = require("path");
const log = require(path.join(runtimeEntryDirname, "../utils/logger"));
const {
  CAPSULE_TYPE_ID,
  CAPSULE_TYPE_ID_GOLDEN,
  ITEM_FLAGS,
  updateShipItem,
  updateInventoryItem,
  removeInventoryItem,
  getShipConditionState,
  normalizeShipConditionState,
  getItemMetadata,
  pruneExpiredSpaceItems,
} = require(path.join(runtimeEntryDirname, "../services/inventory/itemStore"));
const planetOrbitalState = require(path.join(runtimeEntryDirname, "../services/planet/planetOrbitalState"));
const mobileDepotRuntime = require(path.join(runtimeEntryDirname, "../services/ship/mobileDepotRuntime"));
const mercenaryDenRuntime = require(path.join(runtimeEntryDirname, "../services/ship/mercenaryDenRuntime"));
const structureState = require(path.join(
  runtimeEntryDirname,
  "../services/structure/structureState",
));
const {
  STRUCTURE_VULNERABLE_STATES,
} = require(path.join(
  runtimeEntryDirname,
  "../services/structure/structureConstants",
));
const structureTethering = require(path.join(
  runtimeEntryDirname,
  "./structureTethering",
));
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
  noteReactiveArmorHardenerDamage,
} = require("./activeShipModifiers");
const {
  getAppliedDamageAmount,
  notifyEnvironmentalDamageMessage,
} = require("./combatDamageMessages");
const {
  buildCombatDestructionOwnerContext,
  destroyCombatEntity,
  isRuntimeEntityDestroyingOrDestroyed,
} = require("./combatDestruction");
const {
  getOwningSessionForEntity,
} = require("./entityOwnerSession");
const {
  persistDynamicEntity,
} = require("./entitySpacePersistence");
const {
  toFiniteNumber,
  toInt,
} = require("../../common/numbers");
const {
  lazyRequire,
} = require("./runtimeModuleBoundary");
const {
  getSceneKeyForSession,
  normalizeSceneText,
} = require("./sceneIdentity");
const {
  broadcastDamageStateChange,
  notifyShipHealthAttributesToSession,
} = require("./shipHealthState");
const {
  applyDamageToFighterSquadronSafe,
  handleDroneDestroyedSafe,
  handleFighterDestroyedSafe,
  handleFighterPostDamageSafe,
} = require("./squadronRuntimeBridge");
const {
  TARGET_LOSS_REASON_ATTEMPT_CANCELLED,
} = require("./targeting");
const { resolveLayerResonanceOverrides } = require("../combat/visionsCombatPolicy");
const incursionHooks = require("../../services/incursion/incursionHooks");

function applyResolvedEnvironmentalDamageToTarget(
  scene,
  sourceEntity,
  targetEntity,
  resolvedDamageAmount,
  whenMs,
  options = {},
) {
  const amount = Math.max(0, toFiniteNumber(resolvedDamageAmount, 0));
  const sourceID = toInt(sourceEntity && sourceEntity.itemID, 0);
  const targetID = toInt(targetEntity && targetEntity.itemID, 0);
  const sourceRegistered = Boolean(
    scene &&
    scene.dynamicEntities instanceof Map &&
    scene.dynamicEntities.get(sourceID) === sourceEntity
  );
  const targetRegistered = Boolean(
    scene &&
    scene.dynamicEntities instanceof Map &&
    scene.dynamicEntities.get(targetID) === targetEntity
  );
  if (
    !scene ||
    !sourceRegistered ||
    !targetRegistered ||
    sourceEntity.evejsAbyssalEnvironmentalObject !== true ||
    !hasDamageableHealth(targetEntity) ||
    isRuntimeEntityDestroyingOrDestroyed(targetEntity) ||
    !(amount > 0)
  ) {
    return {
      success: false,
      errorMsg: "ENVIRONMENTAL_DAMAGE_CONTEXT_INVALID",
      damageResult: null,
      destroyResult: null,
      notified: false,
    };
  }

  if (require("../../services/sovereignty/skyhookRaidRuntime").blocksSiloDamage(targetEntity)) {
    return { success: false, errorMsg: "SKYHOOK_SILO_INVULNERABLE", damageResult: null, destroyResult: null, notified: false };
  }
  if (targetEntity.incursionHealthPending || targetEntity.incursionWaveHeld || sourceEntity?.incursionWaveHeld) {
    return { success: false, errorMsg: "INCURSION_HEALTH_PENDING" };
  }
  const incursionBefore = targetEntity.incursionOperationID ? { ...targetEntity.conditionState } : null;
  const damageResult = applyResolvedDamageAmountToEntity(targetEntity,
    targetEntity.evejsSkyhookReagentSilo
      ? Math.min(amount, targetEntity.shieldCapacity * targetEntity.conditionState.shieldCharge) : amount);
  if (!damageResult.success) {
    return {
      success: false,
      errorMsg: damageResult.errorMsg,
      damageResult,
      destroyResult: null,
      notified: false,
    };
  }
  const incursion = incursionHooks.commitDamage(scene, sourceEntity, targetEntity, damageResult, incursionBefore, whenMs, options);
  if (!incursion.success || incursion.pending) return { success: false, pending: incursion.pending,
    errorMsg: incursion.errorMsg || "INCURSION_HEALTH_PENDING", damageResult: null, destroyResult: null, notified: false };
  require("../../services/sovereignty/skyhookRaidRuntime").applySiloDamage(targetEntity, damageResult);

  persistDynamicEntity(targetEntity);
  const targetSession = getOwningSessionForEntity(scene, targetEntity);
  if (targetSession) {
    notifyShipHealthAttributesToSession(
      targetSession,
      targetEntity,
      damageResult,
      whenMs,
    );
  }
  const notified = notifyEnvironmentalDamageMessage(
    scene,
    sourceEntity,
    targetEntity,
    options.sourceName || "Environmental Hazard",
    getAppliedDamageAmount(damageResult),
  );

  let destroyResult = null;
  if (damageResult.data && damageResult.data.destroyed) {
    const destructionReason = String(
      options.destructionReason || "abyssal-boundary",
    );
    targetEntity.destructionState = "destroying";
    targetEntity.destroying = true;
    targetEntity.destroyingAtMs = whenMs || Date.now();
    broadcastDamageStateChange(scene, targetEntity);
    destroyResult = destroyCombatEntity(scene, targetEntity, {
      attackerEntity: null,
      destructionNowMs: whenMs,
      destructionReason,
      sessionChangeReason:
        options.sessionChangeReason ||
        (destructionReason.trim().toLowerCase().replace(/_/g, "-") ===
          "abyssal-boundary"
          ? "abyssal_boundary"
          : undefined),
      skipInsurance: options.skipInsurance === true,
      insuranceSuppressedReason: options.insuranceSuppressedReason,
    });
    if (!destroyResult || destroyResult.success !== true) {
      targetEntity.destructionState = "alive";
      targetEntity.destroying = false;
      targetEntity.destroyingAtMs = 0;
    }
  } else {
    broadcastDamageStateChange(scene, targetEntity);
  }

  const destructionFailed = Boolean(
    damageResult.data &&
    damageResult.data.destroyed &&
    (!destroyResult || destroyResult.success !== true)
  );
  return {
    success: !destructionFailed,
    errorMsg: destructionFailed ? "ENVIRONMENTAL_DESTRUCTION_FAILED" : undefined,
    damageResult,
    destroyResult,
    destroyed: Boolean(
      damageResult.data &&
      damageResult.data.destroyed &&
      destroyResult &&
      destroyResult.success === true
    ),
    notified,
    sourceName: String(options.sourceName || "Environmental Hazard"),
    damageQuality: "Hits",
    weapon: null,
    damageType: null,
  };
}

// Retail limits the damage each layer of an Upwell structure takes per second
// (shieldDamageLimit, armorDamageLimit, structureDamageLimit; 0 means no limit),
// and the same second's damage decides whether its repair countdown pauses.
// The window follows the scene clock one whole second at a time.
function openStructureDamageWindow(entity, whenMs) {
  const second = Math.floor(toFiniteNumber(whenMs, Date.now()) / 1000);
  let damageWindow = entity._structureDamageWindow;
  if (!damageWindow || damageWindow.second !== second) {
    damageWindow = {
      second,
      applied: { shield: 0, armor: 0, structure: 0 },
    };
    entity._structureDamageWindow = damageWindow;
  }
  const limits = structureState.resolveStructureLayerDamageLimits(entity);
  const remaining = {};
  for (const layer of ["shield", "armor", "structure"]) {
    remaining[layer] = limits[layer] > 0
      ? Math.max(0, limits[layer] - damageWindow.applied[layer])
      : Infinity;
  }
  return { window: damageWindow, remaining };
}

function recordStructureDamageWindow(damageWindow, damageResult) {
  const perLayer =
    damageResult && damageResult.data && Array.isArray(damageResult.data.perLayer)
      ? damageResult.data.perLayer
      : [];
  for (const layerResult of perLayer) {
    if (Object.prototype.hasOwnProperty.call(damageWindow.applied, layerResult.layer)) {
      damageWindow.applied[layerResult.layer] += Math.max(
        0,
        toFiniteNumber(layerResult.appliedEffective, 0),
      );
    }
  }
}

function applyWeaponDamageToTarget(
  scene,
  attackerEntity,
  targetEntity,
  shotDamage,
  whenMs,
  options = {},
) {
  if ((targetEntity?.incursionControlKey || targetEntity?.incursionLogisticsStation) &&
      !require("../../services/incursion/incursionLogistics").canDamage(targetEntity)) {
    return { damageResult: null, destroyResult: null, errorMsg: "INCURSION_CONTROL_INVULNERABLE" };
  }
  if (targetEntity?.incursionStructureObjectiveKey && !require("../../services/incursion/incursionStructures").canDamage(targetEntity)) {
    return { damageResult: null, destroyResult: null, errorMsg: "INCURSION_STRUCTURE_INVULNERABLE" };
  }
  if (targetEntity?.incursionHealthPending || targetEntity?.incursionWaveHeld || attackerEntity?.incursionWaveHeld) {
    return { damageResult: null, destroyResult: null, errorMsg: "INCURSION_HEALTH_PENDING" };
  }
  const breacher = require("../combat/breacherPods");
  const breacherTick = breacher.isAuthorizedTick(scene, targetEntity, options.breacherTickToken);
  if (options.breacherTickToken && !breacherTick) return { damageResult: null, destroyResult: null };
  const raidRuntime = require("../../services/sovereignty/skyhookRaidRuntime");
  if (raidRuntime.blocksSiloDamage(targetEntity)) {
    return { damageResult: null, destroyResult: null, errorMsg: "SKYHOOK_SILO_INVULNERABLE" };
  }
  let resolvedShotDamage =
    targetEntity?.homefrontKey && !require("../../services/homefront/homefrontHooks").runtime.canDamage(targetEntity)
      ? null :
    shotDamage && typeof shotDamage === "object"
      ? shotDamage
      : {};
  if (resolvedShotDamage === null) return { damageResult: null, destroyResult: null };
  const incursionMultiplier = Number.isFinite(options.incursionDamageMultiplier) &&
    options.incursionDamageMultiplier >= 0 && options.incursionDamageMultiplier <= 1
    ? options.incursionDamageMultiplier
    : require("../../services/incursion/incursionSystemEffects").damageMultiplier(
      attackerEntity, options.incursionWeaponKind, scene?.systemID);
  if (incursionMultiplier !== 1) resolvedShotDamage = Object.fromEntries(
    Object.entries(resolvedShotDamage).map(([kind, amount]) => [kind, amount * incursionMultiplier]));
  const airMultiplier = require("../combat/airCombatPolicy").damageMultiplier(scene, attackerEntity, targetEntity);
  if (airMultiplier !== 1) resolvedShotDamage = Object.fromEntries(Object.entries(resolvedShotDamage).map(([kind, amount]) => [kind, amount * airMultiplier]));
  const fabricatorMultiplier = require("../../services/seasons/eventHooks").fabricator.damageMultiplier(scene,attackerEntity,targetEntity,options,whenMs);
  if (fabricatorMultiplier === 0) return {damageResult:null,destroyResult:null};
  if (fabricatorMultiplier !== 1) resolvedShotDamage = Object.fromEntries(Object.entries(resolvedShotDamage).map(([k,v])=>[k,v*fabricatorMultiplier]));
  // The AIR fleet battle never wears a ship below its floor (airCombatPolicy).
  const airBattleScale = require("../combat/airCombatPolicy").battleShotScale(attackerEntity, targetEntity, resolvedShotDamage);
  if (airBattleScale <= 0) return { damageResult: null, destroyResult: null };
  if (airBattleScale < 1) resolvedShotDamage = Object.fromEntries(Object.entries(resolvedShotDamage).map(([kind, amount]) => [kind, amount * airBattleScale]));
  if (
    targetEntity &&
    targetEntity.evejsAbyssalEnvironmentalObject === true &&
    targetEntity.evejsAbyssalEnvironmentalMechanicsEnabled === true &&
    scene &&
    scene.dynamicEntities instanceof Map &&
    scene.dynamicEntities.get(toInt(targetEntity.itemID, 0)) !== targetEntity
  ) {
    return {
      damageResult: null,
      destroyResult: null,
    };
  }
  if (!targetEntity || !hasDamageableHealth(targetEntity)) {
    return {
      damageResult: null,
      destroyResult: null,
    };
  }
  if (isRuntimeEntityDestroyingOrDestroyed(targetEntity)) {
    return {
      damageResult: null,
      destroyResult: null,
    };
  }
  // Anchoring, fitting and FOB invulnerability protect health just as
  // reinforcement does. Use the shared state contract for every structure.
  if (
    targetEntity.kind === "structure" &&
    !STRUCTURE_VULNERABLE_STATES.has(toInt(targetEntity.state, 0))
  ) {
    return {
      damageResult: null,
      destroyResult: null,
    };
  }
  if (blockCrossSceneCombatIfNeeded(scene, attackerEntity, targetEntity, options.action || "damage")) {
    return {
      damageResult: null,
      destroyResult: null,
    };
  }
  if (!breacherTick && structureTethering.isEntityStructureTethered(targetEntity)) {
    return {
      damageResult: null,
      destroyResult: null,
    };
  }
  if (sumDamageVector(resolvedShotDamage) <= 0) {
    return {
      damageResult: null,
      destroyResult: null,
    };
  }
  if (mobileDepotRuntime.isMobileDepotEntityReinforced(targetEntity)) {
    return {
      damageResult: null,
      destroyResult: null,
    };
  }
  // A reinforced Mercenary Den takes no damage (its reinforce component).
  if (mercenaryDenRuntime.isMercenaryDenEntityInvulnerable(targetEntity)) {
    return {
      damageResult: null,
      destroyResult: null,
    };
  }
  // NOTE: undock invulnerability is deliberately NOT handled here. It is a
  // refusal to be LOCKED (see validateTargetLockRequest), not a damage shield —
  // so smartbombs and other effects that need no lock land normally, matching
  // TQ. Absorbing damage here instead would also have silently swallowed the
  // hit messages the client still renders from this path.
  const fighterDamageContext =
    targetEntity.kind === "fighter" &&
    typeof applyDamageToFighterSquadronSafe === "function"
      ? applyDamageToFighterSquadronSafe(
        scene,
        targetEntity,
        resolvedShotDamage,
        whenMs,
      )
      : null;
  const structureDamageWindow = targetEntity.kind === "structure"
    ? openStructureDamageWindow(targetEntity, whenMs)
    : null;
  const beforeBreacherCondition = breacherTick ? { ...targetEntity.conditionState } : null;
  const damageOptions = structureDamageWindow
    ? { layerDamageLimits: structureDamageWindow.remaining }
    : targetEntity.evejsSkyhookReagentSilo ? { layerDamageLimits: { armor: 0, structure: 0 } } : {};
  const layerResonanceOverrides = !breacherTick && !fighterDamageContext?.damageResult
    ? resolveLayerResonanceOverrides(scene, attackerEntity, targetEntity) : null;
  if (layerResonanceOverrides) damageOptions.layerResonanceOverrides = layerResonanceOverrides;
  const incursionBefore = targetEntity.incursionOperationID ? { ...targetEntity.conditionState } : null;
  const damageResult = breacherTick
    ? applyResolvedDamageAmountToEntity(targetEntity, options.resolvedDamageAmount)
    : fighterDamageContext && fighterDamageContext.damageResult
    ? fighterDamageContext.damageResult
    : applyDamageToEntity(
      targetEntity,
      resolvedShotDamage,
      damageOptions,
    );
  if (damageResult.success && incursionBefore) {
    const incursion = incursionHooks.commitDamage(scene, attackerEntity, targetEntity, damageResult, incursionBefore, whenMs, options);
    if (!incursion.success || incursion.pending) return {
      damageResult: { success: false, errorMsg: incursion.errorMsg || "INCURSION_HEALTH_PENDING", pending: incursion.pending }, destroyResult: null,
    };
  }
  if (breacherTick && damageResult.success) {
    // Cursor, lethal intent and health commit together in the existing ship
    // item row, before notifications or normal destruction settlement.
    try { breacher.noteHealthResult(options.breacherTickToken, damageResult); }
    catch (error) {
      targetEntity.conditionState = beforeBreacherCondition;
      log.warn(`[Breacher] Terminal preparation failed: ${error.message}`);
      return { damageResult: { success: false, errorMsg: "BREACHER_DEATH_PREPARATION_FAILED" }, destroyResult: null };
    }
    if (targetEntity.persistSpaceState === true) {
      const committed = persistDynamicEntity(targetEntity);
      if (!committed?.success) {
        targetEntity.conditionState = beforeBreacherCondition;
        return { damageResult: { success: false, errorMsg: "BREACHER_TICK_WRITE_FAILED" }, destroyResult: null };
      }
    }
  }
  const breacherDeathRecord = breacherTick ? breacher.getPendingKill(scene, targetEntity)?.deathRecord : null;
  if (structureDamageWindow && damageResult.success) {
    recordStructureDamageWindow(structureDamageWindow.window, damageResult);
  }
  let destroyResult = null;
  raidRuntime.applySiloDamage(targetEntity, damageResult);
  if (damageResult.success && toInt(targetEntity.categoryID, 0) === 23) {
    const committed = lazyRequire("../services/starbase/starbaseCombatRuntime")
      .commitStarbaseDamage(scene, targetEntity, damageResult, { nowMs: Date.now() });
    if (!committed.success || committed.immune) {
      return { damageResult: committed.immune ? null : committed, destroyResult: null };
    }
  }
  if (damageResult.success) {
    try {
      const crimewatchState = lazyRequire("../services/security/crimewatchState");
      if (
        getAppliedDamageAmount(damageResult) > 0 &&
        crimewatchState &&
        typeof crimewatchState.refreshLimitedEngagementForCombatEntities ===
          "function"
      ) {
        const engagementRefresh =
          crimewatchState.refreshLimitedEngagementForCombatEntities(
            attackerEntity,
            targetEntity,
            whenMs,
          );
        if (engagementRefresh && engagementRefresh.success === false) {
          log.warn(
            `[SpaceRuntime] Limited engagement refresh failed: ${
              engagementRefresh.errorMsg || "UNKNOWN_ERROR"
            }`,
          );
        }
      }
    } catch (error) {
      log.warn(
        `[SpaceRuntime] Limited engagement refresh failed: ${error.message}`,
      );
    }
    noteReactiveArmorHardenerDamage(targetEntity, damageResult);
    if (targetEntity.homefrontKey) {
      const homefront =
        require("../../services/homefront/homefrontHooks").runtime;
      homefront.noteAggression(scene, attackerEntity, targetEntity, whenMs);
      homefront.noteContribution(
        scene,
        attackerEntity,
        targetEntity,
        getAppliedDamageAmount(damageResult),
        "damage",
        whenMs,
      );
    }
    try {
      const droneRuntime = lazyRequire("../services/drone/droneRuntime");
      if (droneRuntime && typeof droneRuntime.noteIncomingAggression === "function") {
        droneRuntime.noteIncomingAggression(
          attackerEntity,
          targetEntity,
          whenMs,
        );
      }
    } catch (error) {
      log.warn(`[SpaceRuntime] Drone aggression note failed: ${error.message}`);
    }
    if (targetEntity.kind === "structure") {
      const structureDamageResult = structureState.applyRuntimeStructureDamage(
        targetEntity.itemID,
        damageResult,
        whenMs,
        {
          attacker: {
            characterID: toInt(
              attackerEntity && (
                attackerEntity.pilotCharacterID ||
                attackerEntity.characterID ||
                attackerEntity.session && attackerEntity.session.characterID
              ),
              0,
            ),
            corporationID: toInt(
              attackerEntity && (
                attackerEntity.corporationID ||
                attackerEntity.session && attackerEntity.session.corporationID ||
                attackerEntity.ownerID
              ),
              0,
            ),
            allianceID: toInt(
              attackerEntity && (
                attackerEntity.allianceID ||
                attackerEntity.session && attackerEntity.session.allianceID
              ),
              0,
            ),
          },
          layerDamageThisSecond: structureDamageWindow
            ? { ...structureDamageWindow.window.applied }
            : undefined,
        },
      );
      if (structureDamageResult.success && structureDamageResult.data) {
        const updatedStructure = structureDamageResult.data.structure;
        targetEntity.state = updatedStructure.state;
        targetEntity.stateStartedAt = updatedStructure.stateStartedAt || null;
        targetEntity.stateEndsAt = updatedStructure.stateEndsAt || null;
        targetEntity.deployStartedAt = updatedStructure.deployStartedAt || null;
        targetEntity.deployEndsAt = updatedStructure.deployEndsAt || null;
        targetEntity.timerPausedAt = updatedStructure.timerPausedAt || null;
        targetEntity.upkeepState = updatedStructure.upkeepState;
        targetEntity.deedState = updatedStructure.hasQuantumCore === true ? 1 : 0;
        targetEntity.serviceStates = updatedStructure.serviceStates || {};
        targetEntity.unanchoring = updatedStructure.unanchoring || null;
        targetEntity.repairing =
          structureState.resolveStructureRepairingValue(updatedStructure);
        targetEntity.conditionState = normalizeShipConditionState(updatedStructure.conditionState);
        if (structureDamageResult.data.preventDestroy === true && damageResult.data) {
          damageResult.data.destroyed = false;
          damageResult.data.afterConditionState = {
            ...targetEntity.conditionState,
          };
        }
      }
    }
    if (targetEntity.kind === "orbital") {
      // Persist the orbital's damage so it carries across scene reloads. A player
      // Customs Office or Skyhook stops at its reinforcement threshold and is
      // invulnerable while reinforced (planetOrbitalReinforcement).
      const orbitalDamageResult = planetOrbitalState.applyRuntimeOrbitalDamage(
        targetEntity.itemID,
        damageResult,
        whenMs,
        {
          attacker: {
            characterID: toInt(
              attackerEntity && (
                attackerEntity.pilotCharacterID ||
                attackerEntity.characterID ||
                attackerEntity.session && attackerEntity.session.characterID
              ),
              0,
            ),
            corporationID: toInt(
              attackerEntity && (
                attackerEntity.corporationID ||
                attackerEntity.session && attackerEntity.session.corporationID
              ),
              0,
            ),
            allianceID: toInt(
              attackerEntity && (
                attackerEntity.allianceID ||
                attackerEntity.session && attackerEntity.session.allianceID
              ),
              0,
            ),
          },
        },
      );
      if (orbitalDamageResult.success && orbitalDamageResult.data) {
        const updatedOrbital = orbitalDamageResult.data.orbital;
        targetEntity.conditionState = normalizeShipConditionState(
          updatedOrbital.conditionState,
        );
        if (orbitalDamageResult.data.preventDestroy === true && damageResult.data) {
          damageResult.data.destroyed = false;
          damageResult.data.afterConditionState = { ...targetEntity.conditionState };
        }
      } else if (!orbitalDamageResult.success) {
        log.warn(
          `[SpaceRuntime] Orbital damage persistence failed for ${targetEntity.itemID}: ${orbitalDamageResult.errorMsg || "UNKNOWN"}`,
        );
      }
    }
    try {
      const npcService = lazyRequire("./npc");
      if (npcService && typeof npcService.noteNpcIncomingAggression === "function") {
        npcService.noteNpcIncomingAggression(
          targetEntity,
          attackerEntity,
          whenMs,
        );
      }
    } catch (error) {
      log.warn(`[SpaceRuntime] NPC aggression note failed: ${error.message}`);
    }
    if (targetEntity.dungeonSiteInstanceID) {
      // A hit on a site's object or wave ship fires the waves that wait for it (encounter
      // trigger "attacked"), also when no module activation came first (drones).
      try {
        lazyRequire("../services/dungeon/dungeonUniverseSiteService")
          .handleEncounterEntityAttacked(scene, targetEntity, { nowMs: whenMs });
      } catch (error) {
        log.warn(`[SpaceRuntime] Site attacked trigger failed: ${error.message}`);
      }
    }
    const mercenaryDenDamageResult = mercenaryDenRuntime.applyMercenaryDenDamage(
      scene,
      targetEntity,
      damageResult,
      { attackerEntity, nowMs: whenMs },
    );
    if (mercenaryDenDamageResult && mercenaryDenDamageResult.success === false) {
      log.warn(
        `[SpaceRuntime] Mercenary Den damage handling failed for ${targetEntity.itemID}: ${mercenaryDenDamageResult.errorMsg || "UNKNOWN"}`,
      );
    }
    const mobileDepotReinforcementResult =
      mobileDepotRuntime.enterMobileDepotReinforcementFromDamage(
        scene,
        targetEntity,
        damageResult,
        { nowMs: Date.now() },
      );
    if (
      mobileDepotReinforcementResult &&
      mobileDepotReinforcementResult.success === false
    ) {
      log.warn(
        `[SpaceRuntime] Mobile Depot reinforcement failed for ${targetEntity.itemID}: ${mobileDepotReinforcementResult.errorMsg || "UNKNOWN"}`,
      );
    }
    if (!breacherTick && toInt(targetEntity.categoryID, 0) !== 23) persistDynamicEntity(targetEntity);
    if (
      fighterDamageContext &&
      typeof handleFighterPostDamageSafe === "function"
    ) {
      handleFighterPostDamageSafe(scene, targetEntity, damageResult, {
        beforeSquadronSize: fighterDamageContext.beforeSquadronSize,
      });
    }
    const targetSession = getOwningSessionForEntity(scene, targetEntity);
    if (targetSession) {
      const notify = () => notifyShipHealthAttributesToSession(
        targetSession,
        targetEntity,
        damageResult,
        whenMs,
      );
      if (breacherTick) {
        try { notify(); } catch (error) { log.warn(`[Breacher] Health notification failed: ${error.message}`); }
      } else notify();
    }
    if (damageResult.data && damageResult.data.destroyed) {
      targetEntity.destructionState = "destroying";
      targetEntity.destroying = true;
      targetEntity.destroyingAtMs = whenMs || Date.now();
      if (breacherTick) {
        try { broadcastDamageStateChange(scene, targetEntity); }
        catch (error) { log.warn(`[Breacher] Lethal broadcast failed: ${error.message}`); }
      } else broadcastDamageStateChange(scene, targetEntity);
      // A breacher pod's committed death settles through its durable death
      // record; a failed settlement keeps the record for a later tick's retry.
      destroyResult = breacherDeathRecord
        ? require("../../services/ship/breacherPodDeathRuntime").retry(breacherDeathRecord)
        : destroyCombatEntity(
          scene,
          targetEntity,
          {
            ...buildCombatDestructionOwnerContext(attackerEntity),
            lethalDamageAmount: getAppliedDamageAmount(damageResult),
            destructionNowMs: whenMs,
            destructionReason: options.destructionReason || options.action || "combat",
            sessionChangeReason: options.sessionChangeReason,
            skipInsurance: options.skipInsurance === true,
            insuranceSuppressedReason: options.insuranceSuppressedReason,
          },
        );
      if (
        destroyResult &&
        destroyResult.success === true &&
        targetEntity.kind === "drone" &&
        typeof handleDroneDestroyedSafe === "function"
      ) {
        handleDroneDestroyedSafe(scene, targetEntity);
      }
      if (
        destroyResult &&
        destroyResult.success === true &&
        targetEntity.kind === "fighter" &&
        typeof handleFighterDestroyedSafe === "function"
      ) {
        handleFighterDestroyedSafe(scene, targetEntity);
      }
      if ((!destroyResult || destroyResult.success !== true) && !breacherDeathRecord) {
        targetEntity.destructionState = "alive";
        targetEntity.destroying = false;
        targetEntity.destroyingAtMs = 0;
      }
    } else {
      if (breacherTick) {
        try { broadcastDamageStateChange(scene, targetEntity); }
        catch (error) { log.warn(`[Breacher] Damage broadcast failed: ${error.message}`); }
      } else broadcastDamageStateChange(scene, targetEntity);
    }
  }

  return {
    damageResult,
    destroyResult,
    breacherDeathRecord,
  };
}

function resolveCombatSceneKey(entity, fallbackScene = null) {
  if (entity && entity.session) {
    const sessionSceneKey = getSceneKeyForSession(entity.session);
    if (sessionSceneKey) {
      return sessionSceneKey;
    }
  }
  return normalizeSceneText(
    entity && entity.sceneKey,
    fallbackScene && fallbackScene.sceneKey || "",
  );
}

function blockCrossSceneCombatIfNeeded(scene, sourceEntity, targetEntity, action) {
  const sourceSceneKey = resolveCombatSceneKey(sourceEntity, scene);
  const targetSceneKey = resolveCombatSceneKey(targetEntity, scene);
  if (!sourceSceneKey || !targetSceneKey || sourceSceneKey === targetSceneKey) {
    return false;
  }
  if (scene && typeof scene.clearOutgoingTargetLocks === "function" && sourceEntity) {
    scene.clearOutgoingTargetLocks(sourceEntity, {
      notifySelf: false,
      notifyTarget: true,
      activeReason: "scene",
      pendingReason: TARGET_LOSS_REASON_ATTEMPT_CANCELLED,
    });
  }
  log.info(
    `[CombatSceneGuard] source=${toInt(sourceEntity && sourceEntity.itemID, 0)} ` +
      `sourceScene=${sourceSceneKey} target=${toInt(targetEntity && targetEntity.itemID, 0)} ` +
      `targetScene=${targetSceneKey} action=${String(action || "combat")} result=blocked`,
  );
  return true;
}
