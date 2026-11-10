"use strict";

module.exports = {
  buildCombatDestructionOwnerContext,
  destroyCombatEntity,
  getRuntimeEntityDestructionState,
  isRuntimeEntityDestroyingOrDestroyed,
  notifyDungeonEntityDestroyedSafe,
  recordNpcBountyForCombatDestruction,
  resolveMissionNpcWreckOwnerCharacterID,
  resolveNpcWreckOwnerContext,
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
const {
  findItemById,
  findShipItemById,
  listContainerItems,
  listSystemSpaceItems,
  warmSimulationInventoryProjection,
} = require(path.join(
  runtimeEntryDirname,
  "../services/inventory/simulationInventoryProjection",
));
const planetOrbitalState = require(path.join(runtimeEntryDirname, "../services/planet/planetOrbitalState"));
const structureState = require(path.join(
  runtimeEntryDirname,
  "../services/structure/structureState",
));
const sessionRegistry = require(path.join(
  runtimeEntryDirname,
  "../services/chat/sessionRegistry",
));
const {
  noteDamage: noteKillmailDamage,
  resolveHighestDamageAttacker,
  enqueueKillmailFromDestruction: recordKillmailFromDestruction,
  recoverPendingKillmailWork,
} = require(path.join(runtimeEntryDirname, "./combat/killmailTracker"));
const {
  buildAbyssalRuntimeArtifactDestructionContext,
  noteAbyssalNpcStandingsSuppression,
  notifyAbyssalEntityDestroyedSafe,
  notifyAbyssalNpcDestroyedFromContext,
  resolveAbyssalNpcRuntimePolicy,
} = require("./abyssalRunReporting");
const {
  getAbyssalMgrServiceModule,
} = require("./abyssalServicePort");
const {
  resolveCharacterRecord,
} = require("./characterStateBridge");
const {
  getShipEntityInventoryCharacterID,
} = require("./entityDogmaView");
const {
  getOwningSessionForEntity,
} = require("./entityOwnerSession");
const {
  getSessionFleetIDForLootRights,
} = require("./inventoryLootRights");
const {
  isInventoryBackedDynamicEntity,
  spawnDeferredStructureLootEntities,
} = require("./inventorySpaceEntity");
const {
  toFiniteNumber,
  toInt,
} = require("../../common/numbers");
const {
  lazyRequire,
} = require("./runtimeModuleBoundary");
const {
  SCENE_KIND_ABYSSAL,
  buildAbyssalSceneKey,
  getAbyssalRuntimeSceneAuthority,
  normalizeSceneText,
} = require("./sceneIdentity");
const {
  breakStructureTethersForStructure,
} = require("./structureTether");

const DESTRUCTION_EFFECT_EXPLOSION = 3;

function buildCombatDestructionOwnerContext(attackerEntity = null) {
  const ownerCharacterID = getShipEntityInventoryCharacterID(attackerEntity, 0);
  const attackerSession = attackerEntity && attackerEntity.session || null;
  return {
    attackerEntity,
    ownerCharacterID: ownerCharacterID || undefined,
    characterID: ownerCharacterID || undefined,
    corporationID: toInt(
      attackerEntity && (
        attackerEntity.corporationID ||
        attackerEntity.session && attackerEntity.session.corporationID
      ),
      0,
    ) || undefined,
    allianceID: toInt(
      attackerEntity && (
        attackerEntity.allianceID ||
        attackerEntity.session && attackerEntity.session.allianceID
      ),
      0,
    ) || undefined,
    warFactionID: toInt(
      attackerEntity && (
        attackerEntity.warFactionID ||
        attackerEntity.session && attackerEntity.session.warFactionID
      ),
      0,
    ) || undefined,
    fleetID: getSessionFleetIDForLootRights(attackerSession) || undefined,
  };
}

function resolveMissionNpcWreckOwnerCharacterID(entity) {
  const instanceID = toInt(
    entity && (
      entity.dungeonSiteInstanceID ||
      entity.dungeonInstanceID ||
      entity.instanceID
    ),
    0,
  );
  if (instanceID <= 0) {
    return 0;
  }
  try {
    const dungeonRuntime = lazyRequire("../services/dungeon/dungeonRuntime");
    const instance = dungeonRuntime &&
      typeof dungeonRuntime.getInstance === "function"
      ? dungeonRuntime.getInstance(instanceID)
      : null;
    const metadata = instance && instance.metadata || {};
    const runtimeFlags = instance && instance.runtimeFlags || {};
    const siteKind = String(instance && instance.siteKind || "")
      .trim()
      .toLowerCase();
    const isMission = Boolean(
      siteKind === "mission" ||
      metadata.missionRuntime === true ||
      runtimeFlags.missionRuntime === true
    );
    return isMission
      ? toInt(
        instance && instance.ownership &&
          instance.ownership.missionOwnerCharacterID,
        0,
      )
      : 0;
  } catch (_error) {
    // ignored: no readable dungeon instance means no mission owner (0)
    return 0;
  }
}

function resolveNpcWreckOwnerContext(entity, options = {}) {
  const lethalAttacker = options.attackerEntity || null;
  const highestDamageAttacker = resolveHighestDamageAttacker(entity, {
    candidateAttackerEntity: lethalAttacker,
    candidateDamage: options.lethalDamageAmount,
    whenMs: options.destructionNowMs,
  });
  const missionOwnerCharacterID = resolveMissionNpcWreckOwnerCharacterID(entity);
  const ownerCharacterID = toInt(
    missionOwnerCharacterID ||
      highestDamageAttacker && highestDamageAttacker.characterID ||
      options.ownerCharacterID ||
      options.characterID ||
      getShipEntityInventoryCharacterID(lethalAttacker, 0),
    0,
  );
  const ownerSession = missionOwnerCharacterID > 0
    ? sessionRegistry.findSessionByCharacterID(missionOwnerCharacterID)
    : highestDamageAttacker &&
        toInt(highestDamageAttacker.characterID, 0) ===
          getShipEntityInventoryCharacterID(lethalAttacker, 0)
      ? lethalAttacker && lethalAttacker.session || null
      : null;
  const ownerRecord = ownerCharacterID > 0
    ? resolveCharacterRecord(ownerCharacterID) || {}
    : {};
  const fleetID = ownerCharacterID > 0
    ? getSessionFleetIDForLootRights(
      ownerSession || { characterID: ownerCharacterID },
    )
    : 0;

  return {
    ownerCharacterID,
    corporationID: toInt(
      missionOwnerCharacterID > 0
        ? ownerRecord.corporationID
        : highestDamageAttacker && highestDamageAttacker.corporationID ||
          options.corporationID ||
          ownerRecord.corporationID,
      0,
    ) || undefined,
    allianceID: toInt(
      missionOwnerCharacterID > 0
        ? ownerRecord.allianceID
        : highestDamageAttacker && highestDamageAttacker.allianceID ||
          options.allianceID ||
          ownerRecord.allianceID,
      0,
    ) || undefined,
    warFactionID: toInt(
      missionOwnerCharacterID > 0
        ? ownerRecord.warFactionID || ownerRecord.factionID
        : highestDamageAttacker && highestDamageAttacker.factionID ||
          options.warFactionID ||
          ownerRecord.warFactionID ||
          ownerRecord.factionID,
      0,
    ) || undefined,
    fleetID: fleetID || (
      ownerSession ? undefined : toInt(options.fleetID, 0) || undefined
    ),
  };
}

// The NPC bounty kill, with the Grid bubble the NPC died in: combat
// destruction reads it before it destroys the Ball, since the Ball leaves the
// scene's maps at once (doc/FLEET_SHARES.md → NPC bounty at destruction).
function recordNpcBountyForCombatDestruction(
  scene,
  targetEntity,
  attackerEntity,
  destroyResult,
  { gridBubbleID = null } = {},
) {
  if (
    !scene ||
    !targetEntity ||
    targetEntity.kind !== "ship" ||
    !destroyResult ||
    destroyResult.success !== true ||
    !(toFiniteNumber(targetEntity.bounty, 0) > 0)
  ) {
    return null;
  }

  try {
    const bountyRuntime = lazyRequire("../services/bounty/bountyRuntime");
    if (!bountyRuntime || typeof bountyRuntime.recordNpcBountyKill !== "function") {
      return null;
    }
    return bountyRuntime.recordNpcBountyKill(targetEntity, attackerEntity || {}, {
      nowMs: Date.now(),
      solarSystemID: toInt(targetEntity.systemID, toInt(scene.systemID, 0)) || 0,
      scene,
      bountyEventID: destroyResult.data?.deathReceiptKey ? `npc-death:${destroyResult.data.deathReceiptKey}` : undefined,
      gridBubbleID,
      entity: attackerEntity || null,
    });
  } catch (error) {
    log.warn(
      `[SpaceRuntime] NPC bounty accrual failed for ship=${targetEntity.itemID}: ${error.message}`,
    );
    return null;
  }
}

function getRuntimeEntityDestructionState(entity) {
  if (!entity) {
    return "missing";
  }
  if (entity.destructionState === "destroyed" || entity.destroyed === true) {
    return "destroyed";
  }
  if (entity.destructionState === "destroying" || entity.destroying === true) {
    return "destroying";
  }
  return "alive";
}

function isRuntimeEntityDestroyingOrDestroyed(entity) {
  const state = getRuntimeEntityDestructionState(entity);
  return state === "destroying" || state === "destroyed";
}

function notifyDungeonEntityDestroyedSafe(scene, entity, reason = "dungeon_entity_destroyed", options = {}) {
  if (!scene || !entity) {
    return;
  }
  try {
    const dungeonUniverseSiteService = lazyRequire("../services/dungeon/dungeonUniverseSiteService");
    if (
      dungeonUniverseSiteService &&
      typeof dungeonUniverseSiteService.handleEncounterEntityDestroyed === "function"
    ) {
      const explicitNowMs = Math.max(0, toFiniteNumber(options.nowMs, 0));
      const nowMs = explicitNowMs > 0
        ? explicitNowMs
        : Math.max(0, scene.getCurrentSimTimeMs());
      dungeonUniverseSiteService.handleEncounterEntityDestroyed(scene, entity, {
        nowMs,
        reason,
      });
    }
  } catch (error) {
    log.warn(`[SpaceRuntime] Dungeon entity destruction hook failed: ${error.message}`);
  }
}

function destroyCombatEntity(scene, entity, options = {}) {
  if (!scene || !entity) {
    return {
      success: false,
      errorMsg: "ENTITY_NOT_FOUND",
    };
  }

  // A missile-kind Ball destroyed by damage leaves as a plain RemoveBalls at
  // its stamp, with no destruction effect.
  if (entity.modernDefenderEntity === true) {
    const removed = require("../modules/defenderMissileRuntime").removeDefender(scene, entity);
    return { success: removed, errorMsg: removed ? null : "DEFENDER_NOT_OWNED",
      data: { entity, transientProjectile: true } };
  }
  if (entity.breacherPodProjectile === true) {
    const removed = require("../combat/breacherPods").removeProjectile(scene, entity);
    return { success: removed, errorMsg: removed ? null : "BREACHER_PROJECTILE_NOT_OWNED",
      data: { entity, transientProjectile: true } };
  }
  if (entity.bombRuntimeEntity === true) {
    const removed = require("../modules/bombRuntime").removeBomb(scene, entity);
    return { success: removed, errorMsg: removed ? null : "BOMB_NOT_OWNED",
      data: { entity, transientProjectile: true } };
  }

  // An event's own destroy hook removes its NPC from the scene itself, so the
  // Grid bubble is read before the hook runs, and its bounty recorded when the
  // hook succeeds (doc/FLEET_SHARES.md → NPC bounty at destruction).
  if (entity.fwOpenFaction || String(entity.dungeonEncounterKey||"").startsWith("fw-open:")) {
    const gridBubbleID = scene.getGridBubbleIDForEntity(entity);
    const result = lazyRequire("../services/seasons/eventHooks").fw.destroy(scene,entity,options);
    if (result) {
      recordNpcBountyForCombatDestruction(
        scene, entity, options.attackerEntity || null, result, { gridBubbleID },
      );
      return result;
    }
  }
  if (entity.fabricatorRole) {
    const gridBubbleID = scene.getGridBubbleIDForEntity(entity);
    const result = lazyRequire("../services/seasons/eventHooks").fabricator.destroy(scene,entity,options);
    if (result) {
      recordNpcBountyForCombatDestruction(
        scene, entity, options.attackerEntity || null, result, { gridBubbleID },
      );
      return result;
    }
  }

  if (entity.homefrontKey) {
    const homefront = require("../../services/homefront/homefrontHooks").runtime;
    const nowMs = options.destructionNowMs ?? Date.now();
    const isArtifact =
      ["artifactCache", "artifactCacheWreck"].includes(entity.homefrontRole);
    // This runs inside the scene tick, where an uncaught error stops the
    // server. Park the site as the site tick does, and let ordinary
    // destruction carry on.
    try {
      if (isArtifact) {
        return homefront.destroyArtifact(scene, entity);
      }
      homefront.destroyed(scene, entity, nowMs);
    } catch (error) {
      const instanceID = entity.dungeonSiteInstanceID;
      log.error(
        `[Homefront] Destroying ${entity.itemID} failed, parking site ${instanceID}: ${error.stack || error.message}`,
      );
      scene.homefrontParkedSites ??= new Set();
      scene.homefrontParkedSites.add(instanceID);
      try {
        const instance = lazyRequire("../services/dungeon/dungeonRuntime")
          .getInstance(instanceID);
        if (instance) homefront.parkSite(scene, instance, error, nowMs);
      } catch (parkError) {
        log.error(`[Homefront] Could not park site ${instanceID}: ${parkError.message}`);
      }
      if (isArtifact) {
        return { success: false, errorMsg: "HOMEFRONT_ARTIFACT_DESTROY_FAILED" };
      }
    }
  }
  if (entity.kind === "ship") {
    options = { ...options, deathReceipt: options.deathReceipt || require("../combat/airCombatPolicy").deathReceipt(scene, entity) };
    if (require("../FireShow/showIdentity").isFireShowShip(entity)) {
      const result = scene.getEntityByID(entity.itemID) === entity
        ? scene.removeDynamicEntity(entity.itemID, {
            persistSpaceState: false, terminalDestructionEffectID: DESTRUCTION_EFFECT_EXPLOSION,
          })
        : { success: false, errorMsg: "DYNAMIC_ENTITY_NOT_FOUND" };
      return { ...result, data: { ...result.data, syntheticShow: true } };
    }
    const careerAttackHull = require("../../services/career/careerCombatSources")
      .snapshotAttackHull(scene, options.attackerEntity || null);
    const {
      destroySessionShip,
      destroyShipEntityWithWreck,
      destroyShipEntityWithoutWreck,
    } = lazyRequire("./shipDestruction");
    const destroyedSession = getOwningSessionForEntity(scene, entity);
    if (destroyedSession) {
      const abyssalMgrService = getAbyssalMgrServiceModule();
      const destroyedEntityWasCapsule =
        toInt(entity.typeID, 0) === CAPSULE_TYPE_ID ||
        toInt(entity.typeID, 0) === CAPSULE_TYPE_ID_GOLDEN;
      const destroyedCharacterID = toInt(destroyedSession.characterID, 0);
      const activeCharacterRun =
        abyssalMgrService &&
        destroyedCharacterID > 0 &&
        typeof abyssalMgrService.getActiveAbyssalRunForCharacterID === "function"
          ? abyssalMgrService.getActiveAbyssalRunForCharacterID(
              destroyedCharacterID,
            )
          : null;
      const activeCharacterRunID = toInt(
        activeCharacterRun && activeCharacterRun.instanceID,
        0,
      );
      const exactAbyssalSceneAuthority = getAbyssalRuntimeSceneAuthority(scene);
      const capsuleDestroyedInExactActiveRun = Boolean(
        destroyedEntityWasCapsule &&
          activeCharacterRunID > 0 &&
          scene.sceneKind === SCENE_KIND_ABYSSAL &&
          normalizeSceneText(scene.sceneKey, "") ===
            buildAbyssalSceneKey(activeCharacterRunID)
      );
      const abyssalPlayerDestructionSuppressed = Boolean(
        exactAbyssalSceneAuthority ||
        (abyssalMgrService &&
          (
            (
              toInt(entity.itemID, 0) > 0 &&
              typeof abyssalMgrService.isShipInActiveAbyssalRun === "function" &&
              abyssalMgrService.isShipInActiveAbyssalRun(toInt(entity.itemID, 0))
            ) ||
            (
              destroyedCharacterID > 0 &&
              (
                !destroyedEntityWasCapsule ||
                capsuleDestroyedInExactActiveRun
              ) &&
              typeof abyssalMgrService.isCharacterInActiveAbyssalRun === "function" &&
              abyssalMgrService.isCharacterInActiveAbyssalRun(
                destroyedCharacterID,
              )
            )
          )),
      );
      const destroyResult = destroySessionShip(destroyedSession, {
        deathReceipt: options.deathReceipt,
        sessionChangeReason: options.sessionChangeReason || "combat",
        // Pod deaths name the killer in the clone-destroyed notification.
        attackerEntity: options.attackerEntity || null,
        suppressWreck: abyssalPlayerDestructionSuppressed,
        destructionReason: options.destructionReason,
        skipInsurance: options.skipInsurance === true,
        insuranceSuppressedReason: options.insuranceSuppressedReason,
      });
      if (destroyResult?.success && destroyResult.data && careerAttackHull)
        destroyResult.data.careerAttackHull = careerAttackHull;
      if (destroyResult?.success && options.deathReceipt?.airDeathKey) {
        destroyResult.data.deathReceiptKey = options.deathReceipt.key;
        require("../../services/nodegraph/nodeGraphEvents").publish(destroyedSession, "air.player-destroyed", { key: options.deathReceipt.key });
      }
      if (
        destroyResult &&
        destroyResult.success === true &&
        destroyResult.data &&
        (destroyResult.data.capsule || destroyedEntityWasCapsule) &&
        abyssalPlayerDestructionSuppressed
      ) {
        let terminalContinuationHandled = false;
        if (
          abyssalMgrService &&
          typeof abyssalMgrService.handleSessionShipDestroyed === "function"
        ) {
          try {
            const terminalResult = abyssalMgrService.handleSessionShipDestroyed(destroyedSession, {
              reason: "abyssal-combat-destruction",
              destructionResult: destroyResult,
              destroyedCapsule: destroyedEntityWasCapsule,
            });
            terminalContinuationHandled = Boolean(
              terminalResult &&
                terminalResult.success === true &&
                terminalResult.active !== false,
            );
          } catch (error) {
            log.warn(
              `[SpaceRuntime] Abyssal participant destruction continuation failed ` +
                `char=${toInt(destroyedSession.characterID, 0)} ship=${toInt(entity.itemID, 0)} ` +
                `reason=${error.message}`,
            );
          }
        }
        if (
          !terminalContinuationHandled &&
          exactAbyssalSceneAuthority &&
          !destroyedEntityWasCapsule &&
          destroyResult.data.capsule
        ) {
          // Exact isolated-scene identity is enough to fail closed even if the
          // run registry is temporarily unavailable. Never strand a live pod
          // (or make a hull wreck) in an orphaned Abyssal pocket.
          const terminalPodResult = destroySessionShip(destroyedSession, {
            sessionChangeReason: "abyssal-combat-destruction",
            attackerEntity: options.attackerEntity || null,
            suppressWreck: true,
            destructionReason:
              options.destructionReason || "abyssal-combat-destruction",
          });
          destroyResult.data.abyssalTerminalPodDestruction = terminalPodResult;
        }
      }
      return destroyResult;
    }
    const abyssalNpcRuntimePolicy = resolveAbyssalNpcRuntimePolicy(entity);
    const nativeNpcWreckOwnerContext = entity.nativeNpc === true
      ? resolveNpcWreckOwnerContext(entity, options)
      : {};
    const nativeNpcWreckOwnerID = toInt(
      nativeNpcWreckOwnerContext.ownerCharacterID,
      0,
    );
    // A ship of the AIR fleet battle killed by another of it leaves no wreck (airCombatPolicy).
    const airBattleNoWreck = require("../combat/airCombatPolicy").battleKillLeavesNoWreck(entity, options.attackerEntity);
    const destroyShipEntity = entity.nativeNpc === true &&
      (abyssalNpcRuntimePolicy.suppressWreck === true || airBattleNoWreck) &&
      typeof destroyShipEntityWithoutWreck === "function"
      ? destroyShipEntityWithoutWreck
      : destroyShipEntityWithWreck;
    noteAbyssalNpcStandingsSuppression(entity);
    if (entity.nativeNpc === true && abyssalNpcRuntimePolicy.suppressWreck === true) {
      log.info(
        `[AbyssalMgr] NPC wreck suppressed ship=${entity.itemID} ` +
          `enforcement=${abyssalNpcRuntimePolicy.enforcementMode}`,
      );
    }
    const gridBubbleID = scene.getGridBubbleIDForEntity(entity);
    const destroyResult = destroyShipEntity(scene.systemID, entity, {
      deathReceipt: options.deathReceipt,
      sceneDescriptor: scene.sceneDescriptor || undefined,
      suppressWreck: abyssalNpcRuntimePolicy.suppressWreck === true || airBattleNoWreck,
      terminalDestructionEffectID: DESTRUCTION_EFFECT_EXPLOSION,
      destructionReason: options.destructionReason || "combat",
      skipInsurance: options.skipInsurance === true,
      insuranceSuppressedReason: options.insuranceSuppressedReason,
      notifyNpcDestroyed: entity.nativeNpc === true && toInt(entity.evejsAbyssalInstanceID, 0) > 0
        ? (context) => notifyAbyssalNpcDestroyedFromContext({ ...context,
          careerConfirmedCombat: true,
          careerFinalCharacterID: careerAttackHull?.characterID || 0,
          careerFinalShipTypeID: careerAttackHull?.shipTypeID || 0,
          careerVictimTypeID: toInt(entity.typeID, 0),
          careerVictimFactionID: toInt(entity.factionID, 0),
        }, {
          nowMs: options.destructionNowMs,
        })
        : undefined,
      ownerCharacterID: toInt(
        nativeNpcWreckOwnerID ||
          getShipEntityInventoryCharacterID(entity, 0) ||
          entity.ownerID,
        0,
      ),
      corporationID: entity.nativeNpc === true
        ? nativeNpcWreckOwnerContext.corporationID
        : undefined,
      allianceID: entity.nativeNpc === true
        ? nativeNpcWreckOwnerContext.allianceID
        : undefined,
      warFactionID: entity.nativeNpc === true
        ? nativeNpcWreckOwnerContext.warFactionID
        : undefined,
      fleetID: entity.nativeNpc === true
        ? nativeNpcWreckOwnerContext.fleetID
        : undefined,
      attackerEntity: options.attackerEntity || null,
      shipRecord: findShipItemById(entity.itemID) || null,
    });
    if (destroyResult && destroyResult.success === true) {
      if (destroyResult.data && careerAttackHull) destroyResult.data.careerAttackHull = careerAttackHull;
      if (entity.airEncounterSlot?.startsWith("hostile:") && options.attackerEntity?.session) require("../../services/nodegraph/nodeGraphEvents").publish(options.attackerEntity.session, "air.npc-destroyed", { target: entity });
      recordNpcBountyForCombatDestruction(
        scene,
        entity,
        options.attackerEntity || null,
        destroyResult,
        { gridBubbleID },
      );
      if (
        entity.nativeNpc === true &&
        destroyResult.data &&
        destroyResult.data.objectiveNotificationResult
      ) {
        destroyResult.data.objectiveNotified =
          destroyResult.data.objectiveNotificationResult.handled === true;
      } else {
        const objectiveNotifyResult = notifyAbyssalEntityDestroyedSafe(scene, entity, {
          nowMs: options.destructionNowMs,
        });
        if (destroyResult.data && objectiveNotifyResult) {
          destroyResult.data.objectiveNotified = objectiveNotifyResult.objectiveNotified === true;
        }
      }
      return destroyResult;
    }

    const canUseTransientFallback =
      entity.session == null &&
      entity.persistSpaceState !== true &&
      !findShipItemById(entity.itemID) &&
      (
        !destroyResult ||
        destroyResult.errorMsg === "OWNER_CHARACTER_REQUIRED" ||
        destroyResult.errorMsg === "WRECK_CREATE_FAILED"
      );
    if (canUseTransientFallback) {
      const fallbackResult = scene.removeDynamicEntity(entity.itemID, {
        allowSessionOwned: false,
        terminalDestructionEffectID: DESTRUCTION_EFFECT_EXPLOSION,
      });
      if (fallbackResult && fallbackResult.success === true) {
        log.warn(
          `[SpaceRuntime] Falling back to transient ship destruction without wreck for ship=${entity.itemID} type=${entity.typeID} error=${destroyResult && destroyResult.errorMsg ? destroyResult.errorMsg : "UNKNOWN"}`,
        );
        const transientResult = {
          success: true,
          data: {
            shipID: entity.itemID,
            wreck: null,
            transientFallback: true,
            ...(careerAttackHull ? { careerAttackHull } : {}),
            lootOutcome: {
              items: [],
            },
            changes: [],
          },
        };
        recordNpcBountyForCombatDestruction(
          scene,
          entity,
          options.attackerEntity || null,
          transientResult,
          { gridBubbleID },
        );
        return transientResult;
      }
    }

    return destroyResult;
  }

  // Orbitals are checked ahead of the inventory-backed branch: that branch keys
  // off entity.kind alone, and a default Customs Office is a STATIC entity, so it
  // would be routed to destroyInventoryBackedDynamicEntity and fail with
  // DYNAMIC_ENTITY_NOT_FOUND instead of falling through to the static removal.
  if (entity.kind === "orbital") {
    const destroyRecordResult = planetOrbitalState.markOrbitalDestroyed(entity.itemID);
    if (!destroyRecordResult.success) {
      return destroyRecordResult;
    }
    if (Number(entity.typeID) === 81080) {
      require("../../services/sovereignty/skyhookRaidRuntime").handleParentDestroyed(entity.itemID, scene);
    }
    const removeResult = isInventoryBackedDynamicEntity(entity) &&
      scene.dynamicEntities instanceof Map &&
      scene.dynamicEntities.has(toInt(entity.itemID, 0))
      ? scene.destroyInventoryBackedDynamicEntity(entity.itemID, {
          terminalDestructionEffectID: DESTRUCTION_EFFECT_EXPLOSION,
        })
      : scene.removeStaticEntity(entity.itemID, {
          terminalDestructionEffectID: DESTRUCTION_EFFECT_EXPLOSION,
        });
    if (removeResult && removeResult.success === true) {
      notifyDungeonEntityDestroyedSafe(scene, entity, "orbital_destroyed", {
        nowMs: options.destructionNowMs,
      });
    }
    return removeResult;
  }

  // A Mercenary Den leaves its own wreck and, half the time, its infomorphs.
  const mercenaryDenRuntime = lazyRequire("../services/ship/mercenaryDenRuntime");
  if (isInventoryBackedDynamicEntity(entity) && mercenaryDenRuntime.isMercenaryDenType(entity)) {
    return mercenaryDenRuntime.destroyMercenaryDenEntity(scene, entity, {
      terminalDestructionEffectID: DESTRUCTION_EFFECT_EXPLOSION,
      destructionNowMs: options.destructionNowMs,
    });
  }

  if (isInventoryBackedDynamicEntity(entity)) {
    const rewardMaterializationSuppressed =
      options.suppressAbyssalRewardMaterialization === true;
    const isAbyssalRewardArtifact = Boolean(
      entity.evejsAbyssalRewardCache === true ||
      entity.evejsAbyssalExtractionNode === true
    );
    let artifactClaimResult = null;
    if (isAbyssalRewardArtifact && !rewardMaterializationSuppressed) {
      const abyssalMgrService = getAbyssalMgrServiceModule();
      const artifactContext = buildAbyssalRuntimeArtifactDestructionContext(
        scene,
        entity,
      );
      artifactClaimResult = abyssalMgrService &&
        typeof abyssalMgrService.prepareAbyssalRuntimeArtifactDestruction === "function"
        ? abyssalMgrService.prepareAbyssalRuntimeArtifactDestruction(artifactContext)
        : {
            success: false,
            errorMsg: "ABYSSAL_REWARD_ARTIFACT_CLAIM_RUNTIME_UNAVAILABLE",
          };
      if (!artifactClaimResult || artifactClaimResult.success !== true) {
        const claimError = normalizeSceneText(
          artifactClaimResult && artifactClaimResult.errorMsg,
          "ABYSSAL_REWARD_ARTIFACT_CLAIM_FAILED",
        );
        log.warn(
          `[SpaceRuntime] Abyssal reward artifact destruction blocked before removal ` +
            `run=${toInt(entity.evejsAbyssalInstanceID, 0)} item=${toInt(entity.itemID, 0)} ` +
            `kind=${normalizeSceneText(entity.evejsAbyssalArtifactKind, "unknown")} ` +
            `reason=${claimError}`,
        );
        return {
          success: false,
          errorMsg: claimError,
          data: {
            sourceDestroyed: false,
            artifactClaimResult: artifactClaimResult || null,
          },
        };
      }
    }
    const destroyResult = scene.destroyInventoryBackedDynamicEntity(entity.itemID, {
      terminalDestructionEffectID: DESTRUCTION_EFFECT_EXPLOSION,
      suppressAbyssalRewardMaterialization:
        rewardMaterializationSuppressed,
    });
    if (destroyResult && destroyResult.success === true) {
      const destructionNotification = notifyAbyssalEntityDestroyedSafe(scene, entity, {
        nowMs: options.destructionNowMs,
        suppressRewardMaterialization:
          rewardMaterializationSuppressed,
        claimOperationID:
          artifactClaimResult && artifactClaimResult.claimOperationID,
      });
      if (isAbyssalRewardArtifact && !rewardMaterializationSuppressed) {
        const artifactLifecycleResult =
          destructionNotification && destructionNotification.result;
        if (
          !destructionNotification ||
          destructionNotification.artifactNotified !== true
        ) {
          const lifecycleError = normalizeSceneText(
            destructionNotification && destructionNotification.errorMsg,
            "ABYSSAL_REWARD_ARTIFACT_HANDLER_FAILED",
          );
          log.warn(
            `[SpaceRuntime] Abyssal reward artifact removed with materialization pending ` +
              `run=${toInt(entity.evejsAbyssalInstanceID, 0)} item=${toInt(entity.itemID, 0)} ` +
              `kind=${normalizeSceneText(entity.evejsAbyssalArtifactKind, "unknown")} ` +
              `reason=${lifecycleError}`,
          );
          return {
            success: false,
            errorMsg: lifecycleError,
            data: {
              ...(destroyResult.data || {}),
              sourceDestroyed: true,
              rewardArtifactLifecycleHandled: true,
              artifactClaimOperationID: artifactClaimResult.claimOperationID,
              artifactLifecycleResult: artifactLifecycleResult || null,
            },
          };
        }
        return {
          ...destroyResult,
          data: {
            ...(destroyResult.data || {}),
            sourceDestroyed: true,
            rewardArtifactLifecycleHandled: true,
            artifactClaimOperationID: artifactClaimResult.claimOperationID,
            artifactLifecycleResult,
          },
        };
      }
    }
    return destroyResult;
  }

  if (entity.kind === "structure") {
    const destroyResult = structureState.destroyStructure(entity.itemID, {
      nowMs: Date.now(),
    });
    if (!destroyResult.success) {
      return destroyResult;
    }
    breakStructureTethersForStructure(scene, entity.itemID, {
      nowMs:
        Number.isFinite(Number(options.destructionNowMs))
          ? Number(options.destructionNowMs)
          : scene.getCurrentSimTimeMs(),
      reason: "STRUCTURE_DESTROYED",
    });
    const removeResult = scene.removeStaticEntity(entity.itemID, {
      terminalDestructionEffectID: DESTRUCTION_EFFECT_EXPLOSION,
    });
    if (removeResult && removeResult.success === true) {
      notifyDungeonEntityDestroyedSafe(scene, entity, "structure_destroyed", {
        nowMs: options.destructionNowMs,
      });
    }
    const spawnLootResult = spawnDeferredStructureLootEntities(scene, entity.itemID);
    if (!spawnLootResult.success) {
      return spawnLootResult;
    }
    return {
      success: true,
      data: {
        structureID: entity.itemID,
        loot:
          destroyResult && destroyResult.data && destroyResult.data.loot
            ? destroyResult.data.loot
            : null,
        lootItemIDs:
          spawnLootResult.data && Array.isArray(spawnLootResult.data.itemIDs)
            ? spawnLootResult.data.itemIDs
            : [],
      },
    };
  }

  if (
    scene.staticEntitiesByID instanceof Map &&
    scene.staticEntitiesByID.has(toInt(entity && entity.itemID, 0))
  ) {
    const removeResult = scene.removeStaticEntity(entity.itemID, {
      terminalDestructionEffectID: DESTRUCTION_EFFECT_EXPLOSION,
    });
    if (removeResult && removeResult.success === true) {
      notifyDungeonEntityDestroyedSafe(scene, entity, "static_entity_destroyed", {
        nowMs: options.destructionNowMs,
      });
    }
    return removeResult;
  }

  return {
    success: false,
    errorMsg: "ENTITY_NOT_DAMAGEABLE",
  };
}

Object.assign(module.exports, {
  DESTRUCTION_EFFECT_EXPLOSION,
});
