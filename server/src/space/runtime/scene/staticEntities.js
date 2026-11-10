"use strict";

const runtimeEntryDirname = require("path").resolve(__dirname, "../..");
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
const structureState = require(path.join(
  runtimeEntryDirname,
  "../services/structure/structureState",
));
const worldData = require(path.join(runtimeEntryDirname, "./worldData"));
const {
  DESTRUCTION_EFFECT_EXPLOSION,
} = require("../combatDestruction");
const {
  getEntityCapacitorRatio,
} = require("../entityCapacitor");
const {
  spawnDeferredStructureLootEntities,
} = require("../inventorySpaceEntity");
const {
  toInt,
} = require("../../../common/numbers");
const {
  broadcastDamageStateChange,
} = require("../shipHealthState");
const {
  buildStaticStructureEntity,
} = require("../staticSceneEntity");
const {
  buildStructureChangeMap,
  getStructureSlimItemSignature,
  getStructureStaticEntitySignature,
  resolveStructureLifecyclePresentation,
} = require("../structureLifecycleFanout");
const {
  hydrateControlledStaticStructureDogmaHost,
  isControlledStaticStructureHostForSession,
  refreshControlledStaticStructureBaseline,
  restoreObjectShallowSnapshot,
} = require("../structureSessionHost");
const sceneFeatureHooks = require("./sceneFeatureHooks");

module.exports = {

addStaticEntity(entity) {
    if (!entity || !entity.itemID) {
      return false;
    }

    const normalizedItemID = Number(entity.itemID);
    if (!Number.isInteger(normalizedItemID) || normalizedItemID <= 0) {
      return false;
    }

    if (this.staticEntitiesByID.has(normalizedItemID)) {
      return false;
    }
    if (this.hasMalformedScope(entity)) {
      log.warn(`[SpaceRuntime] Refused static Ball ${normalizedItemID} with a malformed scope in system=${this.systemID}`);
      return false;
    }

    const positionRegistration = this.positionAuthority.registerEntity(entity, {
      atSimTimeMs: this.simTimeMs,
      reason: "static-entity-register",
    });
    if (!positionRegistration.available) {
      return false;
    }
    this.staticEntities.push(entity);
    this.staticEntitiesByID.set(normalizedItemID, entity);
    // AddBall: every static Ball is in its Grid bubble, a global one too
    // (it is in no list, scene/visibility.js).
    this.reboxBall(entity);
    return true;
  },

removeStaticEntity(entityID, options = {}) {
    const numericEntityID = Number(entityID);
    const entity = this.staticEntitiesByID.get(numericEntityID) || null;
    if (!entity) {
      return {
        success: false,
        errorMsg: "STATIC_ENTITY_NOT_FOUND",
      };
    }

    const wasGlobal = this.isGlobalBall(entity);
    sceneFeatureHooks.notifyEntityRemoved(this, entity, options, { path: "static" });
    this.removeBallFromGridBubbles(entity);
    // A removed Ball leaves every index it was in.
    this.positionAuthority.unregisterEntity(entity);
    this.staticEntitiesByID.delete(numericEntityID);
    this.staticEntities = this.staticEntities.filter(
      (candidate) => Number(candidate && candidate.itemID) !== numericEntityID,
    );
    if (options.broadcast !== false) {
      this.broadcastRemoveStaticEntity(numericEntityID, options.excludedSession || null, {
        terminalDestructionEffectID: options.terminalDestructionEffectID,
        nowMs: options.nowMs,
        wasGlobal,
      });
    }
    return {
      success: true,
      data: {
        entity,
      },
    };
  },

syncStructureEntitiesFromState(options = {}) {
    // structureState.listStructures() runs a process-wide tickStructures()
    // unless refresh is false, so reading structures here advances every
    // structure in the universe. Ad-hoc callers rely on that -- they sync
    // between runtime ticks and expect to see a timer that has just expired --
    // so the default is unchanged and only a caller that has already ticked
    // opts out.
    const structures = worldData.getStructuresForSystem(this.systemID, {
      refresh: options.refresh,
    });
    const byStructureID = new Map(
      structures.map((structure) => [Number(structure.structureID), structure]),
    );
    const structureChangeMap = buildStructureChangeMap(options.structureStateChanges);
    const added = [];
    const updated = [];
    const damageStateChanged = [];
    const transitionBundles = [];
    const transitionBundleEntityIDs = new Set();

    for (const entity of [...this.staticEntities]) {
      if (!entity || entity.kind !== "structure") {
        continue;
      }

      const structure = byStructureID.get(Number(entity.itemID)) || null;
      if (!structure) {
        const structureChange =
          structureChangeMap.get(Number(entity.itemID)) || null;
        const previousStructure =
          structureChange && structureChange.previous
            ? structureChange.previous
            : null;
        const destroyedStructure = structureState.getStructureByID(entity.itemID, {
          refresh: false,
        });
        const terminalDestructionEffectID =
          toInt(entity && entity.destroyedAt, 0) > 0 ||
          toInt(destroyedStructure && destroyedStructure.destroyedAt, 0) > 0
            ? DESTRUCTION_EFFECT_EXPLOSION
            : 0;
        const removedByCompletedUnanchor = Boolean(
          previousStructure &&
          !(structureChange && structureChange.next) &&
          toInt(previousStructure.destroyedAt, 0) <= 0 &&
          toInt(previousStructure.unanchoring, 0) > 0
        );
        this.removeStaticEntity(entity.itemID, {
          excludedSession: options.excludedSession || null,
          broadcast: options.broadcast !== false,
          terminalDestructionEffectID,
        });
        if (terminalDestructionEffectID > 0 || removedByCompletedUnanchor) {
          const spawnLootResult = spawnDeferredStructureLootEntities(this, entity.itemID, {
            excludedSession: options.excludedSession || null,
            broadcast: options.broadcast !== false,
          });
          if (!spawnLootResult.success) {
            log.warn(
              `[SpaceRuntime] Failed to spawn deferred structure ` +
              `${removedByCompletedUnanchor ? "unanchor artifacts" : "loot"} ` +
              `for ${entity.itemID} in system ${this.systemID}: ${spawnLootResult.errorMsg}`,
            );
          }
        }
        continue;
      }

      const nextEntity = buildStaticStructureEntity(structure);
      const previousEntitySignature = getStructureStaticEntitySignature(entity);
      const previousConditionSignature = JSON.stringify(
        normalizeShipConditionState(entity && entity.conditionState),
      );
      const nextConditionSignature = JSON.stringify(
        normalizeShipConditionState(nextEntity && nextEntity.conditionState),
      );
      const nextEntitySignature = getStructureStaticEntitySignature(nextEntity);
      if (previousEntitySignature !== nextEntitySignature) {
        const controlledSession =
          entity.session &&
          isControlledStaticStructureHostForSession(
            this,
            entity.session,
            entity,
          )
            ? entity.session
            : null;
        const controlledRuntimeSnapshot = controlledSession
          ? { ...entity }
          : null;
        const controlledCapacitorRatio = controlledSession
          ? getEntityCapacitorRatio(entity)
          : null;
        const lifecyclePresentation = resolveStructureLifecyclePresentation(
          structureChangeMap.get(Number(entity.itemID)) &&
            structureChangeMap.get(Number(entity.itemID)).previous,
          structureChangeMap.get(Number(entity.itemID)) &&
            structureChangeMap.get(Number(entity.itemID)).next,
        );
        const previousSlimSignature = getStructureSlimItemSignature(entity);
        const nextSlimSignature = getStructureSlimItemSignature(nextEntity);
        Object.assign(entity, nextEntity);
        if (controlledSession) {
          // A static refresh is built with no pilot, fitting, or skill context.
          // Keep the live capacitor clock (which may be newer than its 500 ms
          // persistence throttle) and immediately rehydrate the same static host
          // before any controlled module can observe the unpiloted snapshot.
          entity.capacitorChargeRatio = controlledCapacitorRatio;
          refreshControlledStaticStructureBaseline(entity, nextEntity);
          try {
            const hydratedEntity = hydrateControlledStaticStructureDogmaHost(
              this,
              controlledSession,
              entity,
            );
            if (!hydratedEntity) {
              restoreObjectShallowSnapshot(entity, controlledRuntimeSnapshot);
              log.warn(
                `[SpaceRuntime] Controlled structure refresh hydration rejected ` +
                  `structure=${toInt(entity && entity.itemID, 0)} ` +
                  `system=${this.systemID}; retained the previous runtime host`,
              );
            }
          } catch (error) {
            restoreObjectShallowSnapshot(entity, controlledRuntimeSnapshot);
            log.warn(
              `[SpaceRuntime] Controlled structure refresh hydration failed ` +
                `structure=${toInt(entity && entity.itemID, 0)} ` +
                `system=${this.systemID}: ${error.message}`,
            );
          }
        }
        if (lifecyclePresentation) {
          transitionBundles.push({
            entity,
            presentation: lifecyclePresentation,
          });
          transitionBundleEntityIDs.add(Number(entity.itemID));
        }
        if (previousConditionSignature !== nextConditionSignature) {
          if (!transitionBundleEntityIDs.has(Number(entity.itemID))) {
            damageStateChanged.push(entity);
          }
        }
        if (previousSlimSignature !== nextSlimSignature) {
          updated.push(entity);
        }
      }
      byStructureID.delete(Number(entity.itemID));
    }

    for (const structure of byStructureID.values()) {
      const entity = buildStaticStructureEntity(structure);
      if (options.initialStructureBundle === true) {
        entity.initialStructureBundle = true;
      }
      if (this.addStaticEntity(entity)) {
        added.push(entity);
      }
    }

    if (options.broadcast !== false) {
      if (transitionBundles.length > 0) {
        this.broadcastStructureLifecycleTransitionBundles(
          transitionBundles,
          options.excludedSession || null,
        );
      }
      if (updated.length > 0) {
        this.broadcastSlimItemChanges(updated, options.excludedSession || null);
      }
      if (added.length > 0) {
        this.broadcastAddBalls(added, options.excludedSession || null, {
          initialStructureBundle: options.initialStructureBundle === true,
        });
      }
      if (damageStateChanged.length > 0) {
        for (const entity of damageStateChanged) {
          broadcastDamageStateChange(this, entity);
        }
      }
    }

    return {
      added,
      updated,
    };
  },
};
