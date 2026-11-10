"use strict";

module.exports = {};

const runtimeEntryDirname = require("path").resolve(__dirname, "..");
const path = require("path");
const log = require(path.join(runtimeEntryDirname, "../utils/logger"));
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
const defaultEmpireScenery = require(path.join(runtimeEntryDirname, "./defaultEmpireScenery"));
const authoredSpaceProps = require(path.join(runtimeEntryDirname, "./authoredSpaceProps"));
const planetOrbitalState = require(path.join(runtimeEntryDirname, "../services/planet/planetOrbitalState"));
const { migratePlanetOrbitalsForScene } = require("../../services/planet/planetOrbitalPlacement");
const deployableCynoRuntime = require(path.join(runtimeEntryDirname, "../services/ship/deployableCynoRuntime"));
const mobileAnalysisBeaconRuntime = require(path.join(runtimeEntryDirname, "../services/ship/mobileAnalysisBeaconRuntime"));
const mobileCynoInhibitorRuntime = require(path.join(runtimeEntryDirname, "../services/ship/mobileCynoInhibitorRuntime"));
const mobileDepotRuntime = require(path.join(runtimeEntryDirname, "../services/ship/mobileDepotRuntime"));
const mobileMicroJumpUnitRuntime = require(path.join(runtimeEntryDirname, "../services/ship/mobileMicroJumpUnitRuntime"));
const mobileObservatoryRuntime = require(path.join(runtimeEntryDirname, "../services/ship/mobileObservatoryRuntime"));
const mobilePhaseAnchorRuntime = require(path.join(runtimeEntryDirname, "../services/ship/mobilePhaseAnchorRuntime"));
const mobileScanInhibitorRuntime = require(path.join(runtimeEntryDirname, "../services/ship/mobileScanInhibitorRuntime"));
const mobileSiphonUnitRuntime = require(path.join(runtimeEntryDirname, "../services/ship/mobileSiphonUnitRuntime"));
const mobileTractorUnitRuntime = require(path.join(runtimeEntryDirname, "../services/ship/mobileTractorUnitRuntime"));
const mobileWarpDisruptorRuntime = require(path.join(runtimeEntryDirname, "../services/ship/mobileWarpDisruptorRuntime"));
const {
  createScenePositionAuthority,
} = require(path.join(runtimeEntryDirname, "./destiny/authority/scenePositionAuthority.js"));
const worldData = require(path.join(runtimeEntryDirname, "./worldData"));
const {
  shouldHydrateInventoryItemIntoScene,
} = require("./abyssalRoomEntity");
const {
  ForceFieldIndexedEntityMap,
} = require("./forceFieldContainment");
const {
  buildRuntimeSpaceEntityFromItem,
} = require("./inventorySpaceEntity");
const {
  toInt,
} = require("../../common/numbers");
const {
  lazyRequire,
} = require("./runtimeModuleBoundary");
const {
  decorateEntitySceneOwnership,
  normalizeSceneDescriptor,
} = require("./sceneIdentity");
const {
  buildStaticAsteroidBeltEntity,
  buildStaticCelestialEntity,
  buildStaticMoonMiningBeaconEntity,
  buildStaticPlanetOrbitalEntity,
  buildStaticStargateEntity,
  buildStaticStationEntity,
  buildStaticStructureEntity,
} = require("./staticSceneEntity");
const {
  createDestinyTickDriver,
} = require("./destinyTickDriver");
const staticSceneEntityModule = require("./staticSceneEntity");


class SolarSystemScene {
  constructor(systemID, descriptor = null) {
  const INCLUDE_STARGATES_IN_SCENE = staticSceneEntityModule.INCLUDE_STARGATES_IN_SCENE;
    const normalizedDescriptor =
      normalizeSceneDescriptor(descriptor || systemID) ||
      normalizeSceneDescriptor(systemID);
    this.sceneDescriptor = normalizedDescriptor;
    this.sceneKey = normalizedDescriptor.sceneKey;
    this.sceneKind = normalizedDescriptor.sceneKind;
    this.locationID = normalizedDescriptor.locationID;
    this.instanceID = normalizedDescriptor.instanceID;
    this.sourceSolarSystemID = normalizedDescriptor.sourceSolarSystemID;
    this.hydrateStaticEntities = normalizedDescriptor.hydrateStaticEntities !== false;
    this.systemID = Number(normalizedDescriptor.locationID || systemID);
    this.system = worldData.getSolarSystemByID(this.systemID);
    this.sessions = new Map();
    this.dynamicEntities = new ForceFieldIndexedEntityMap();
    this.abyssalPrewarmPublicationDiagnostics = {
      blockedDirectPublicationCount: 0,
      committedPublicationCount: 0,
      duplicatePublicationCount: 0,
    };
    this.dynamicEntityExpiryByID = new Map();
    this.dynamicEntityExpiryHeap = [];
    this.commandBurstExpiryByEntityID = new Map();
    this.commandBurstExpiryHeap = [];
    this.droneEntityIDs = new Set();
    this.fighterEntityIDs = new Set();
    // The Grid bubbles (scene/spatialTopology.js), made at the
    // first AddBall.
    this._gridBubbles = null;
    this._gridBubbleUnlistedRemovals = new Set();
    this._gridBubbleCloakedSinceUpdate = new Set();
    this.nextTargetSequence = 1;
    this.lastWallclockTickAt = Date.now();
    this._emptySinceWallclockMs = this.lastWallclockTickAt;
    this._emptyCollectionRetryNotBeforeWallclockMs = null;
    this.simTimeMs = this.lastWallclockTickAt;
    this.timeDilation = 1;
    this.lastTimeDilationRecoveryAtMs = 0;
    // The Destiny tick counter: seeded once from the sim clock
    // here, advanced only by the driver's Destiny ticks, never read from a
    // clock again. destinyTick and nextDestinyStamp read it.
    this.destinyTickDriver = createDestinyTickDriver({
      seedSimTimeMs: this.simTimeMs,
    });
    this.lastSimClockBroadcastWallclockAt = this.lastWallclockTickAt;
    this._movementQueue = [];
    this._movementQueueCounts = new Map();
    this._applyingMovementQueue = false;
    this._joiningMovementBalls = new Set();
    this._tickTargetingStatsCache = null;
    this._nextTickSequence = 1;
    this._activeTickSequence = 0;
    this._activeTickDeltaSeconds = 0;
    this._activeTickNowMs = this.simTimeMs;
    this._destinyTickFrame = null;
    this._pendingDestinyTickOutput = null;
    this.positionAuthority = createScenePositionAuthority({
      getEntityByID: (entityID) => this.getEntityByID(entityID),
      getCurrentSimTimeMs: () => this.getCurrentSimTimeMs(),
    });
    this.staticEntities = [];
    this.staticEntitiesByID = new ForceFieldIndexedEntityMap();
    this.abyssalInventoryHydrationRejectedCount = 0;

    if (this.hydrateStaticEntities) {
      for (const station of worldData.getStationsForSystem(this.systemID)) {
        const entity = buildStaticStationEntity(station);
        this.addStaticEntity(entity);
      }
      for (const structure of worldData.getStructuresForSystem(this.systemID)) {
        const entity = buildStaticStructureEntity(structure);
        this.addStaticEntity(entity);
      }
      for (const asteroidBelt of worldData.getAsteroidBeltsForSystem(this.systemID)) {
        const entity = buildStaticAsteroidBeltEntity(asteroidBelt);
        this.addStaticEntity(entity);
      }
      for (const celestial of worldData.getCelestialsForSystem(this.systemID)) {
        const entity = buildStaticCelestialEntity(celestial);
        this.addStaticEntity(entity);
      }
      for (const point of worldData.getMoonMiningPointsForSystem(this.systemID)) {
        this.addStaticEntity(buildStaticMoonMiningBeaconEntity(point));
      }
      if (INCLUDE_STARGATES_IN_SCENE) {
        for (const stargate of worldData.getStargatesForSystem(this.systemID)) {
          const entity = buildStaticStargateEntity(stargate);
          this.addStaticEntity(entity);
        }
      }
      for (const entity of defaultEmpireScenery.getConfiguredStaticEntitiesForSystem(this.systemID)) {
        this.addStaticEntity(entity);
      }
      for (const entity of lazyRequire("./lcoTransforms").applySavedTransforms(
        this.systemID,
        [
          ...authoredSpaceProps.getConfiguredStaticEntitiesForSystem(this.systemID),
          ...lazyRequire("../services/seasons/campaignTrailCatalog").getStaticEntitiesForSystem(this.systemID),
          ...lazyRequire("../services/seasons/gallenteOutreachCatalog").getStaticEntitiesForSystem(this.systemID),
        ],
      )) {
        this.addStaticEntity(entity);
      }

      let systemSpaceItems = listSystemSpaceItems(this.systemID);
      const destructionResults = lazyRequire("../services/starbase/starbaseCombatRuntime")
        .reconcileStarbaseDestructions(this.systemID, { broadcast: false, systemSpaceItems });
      // Replay can remove towers/fields or detach modules even when a later
      // teardown step fails. Never hydrate or reconcile those stale rows.
      if (destructionResults.length > 0) {
        systemSpaceItems = listSystemSpaceItems(this.systemID);
      }
      const controlTowerRuntime = require(path.join(
        runtimeEntryDirname,
        "../services/ship/controlTowerRuntime",
      ));
      for (const towerItem of systemSpaceItems) {
        if (!controlTowerRuntime.isControlTowerType(towerItem)) {
          continue;
        }
        const anchorResult = controlTowerRuntime.reconcileControlTowerAnchorState(
          towerItem.itemID,
          {
            nowMs: this.getCurrentSimTimeMs(),
            schedule: true,
            refreshPresentation: false,
          },
        );
        const reconciledTower = anchorResult.success && anchorResult.data
          ? anchorResult.data
          : towerItem;
        const onlineResult = controlTowerRuntime.reconcileControlTowerOnlineState(
          reconciledTower.itemID,
          {
            nowMs: this.getCurrentSimTimeMs(),
            schedule: true,
            refreshPresentation: false,
            reconcileForceField: false,
          },
        );
        const currentTower = onlineResult.success && onlineResult.data
          ? onlineResult.data
          : findItemById(reconciledTower.itemID) || reconciledTower;
        const fieldResult = controlTowerRuntime.reconcileControlTowerForceField(
          currentTower,
          {
            spawn: false,
            updateScene: false,
            broadcast: false,
          },
        );
        if (!fieldResult.success) {
          log.warn(
            `[SpaceRuntime] Control tower force field reconciliation failed ` +
            `tower=${towerItem.itemID} error=${fieldResult.errorMsg}`,
          );
        }
      }
      try {
        const replacementResult = require("../../services/planet/skyhookOfficeReplacement")
          .reconcileForSystem(this.systemID, { suppressPresentation: true });
        if (replacementResult && replacementResult.success === false) {
          log.warn(`[SpaceRuntime] Orbital replacement recovery pending system=${this.systemID} error=${replacementResult.errorMsg}`);
        }
      } catch (error) {
        log.warn(`[SpaceRuntime] Orbital replacement recovery pending system=${this.systemID}: ${error.message}`);
      }
      systemSpaceItems = listSystemSpaceItems(this.systemID);
      const inventoryBackedOrbitalIDs = new Set();
      const pendingSkyhookIDs = new Set();
      for (const item of systemSpaceItems) {
        if (toInt(item && item.categoryID, 0) !== planetOrbitalState.CATEGORY_ORBITAL) {
          continue;
        }
        const orbitalRecord = planetOrbitalState.ensureOrbitalForItem(item, {
          solarSystemID: this.systemID,
        });
        if (orbitalRecord && toInt(orbitalRecord.itemID, 0) > 0) {
          inventoryBackedOrbitalIDs.add(toInt(orbitalRecord.itemID, 0));
          if (planetOrbitalState.isSkyhookDeploymentUnpublished(orbitalRecord)) {
            pendingSkyhookIDs.add(toInt(orbitalRecord.itemID, 0));
          }
        }
      }
      // A retained replacement reservation hides only its partial hook. Other
      // planets and pilots can load while that planet's durable saga retries.
      const excludePendingSkyhooks = (item) => !pendingSkyhookIDs.has(toInt(item && item.itemID, 0));
      systemSpaceItems = systemSpaceItems.filter(excludePendingSkyhooks);
      const orbitalPlacementResult = migratePlanetOrbitalsForScene(
        systemSpaceItems.filter((item) => shouldHydrateInventoryItemIntoScene(item, this.sceneDescriptor)),
        this.sceneDescriptor,
      );
      if (!orbitalPlacementResult.success) {
        throw new Error(`Orbital position migration failed system=${this.systemID} error=${orbitalPlacementResult.errorMsg}`);
      } else if (orbitalPlacementResult.migrated > 0) {
        systemSpaceItems = listSystemSpaceItems(this.systemID).filter(excludePendingSkyhooks);
      }
      for (const orbital of planetOrbitalState.listOrbitalsForSystem(this.systemID)) {
        if (inventoryBackedOrbitalIDs.has(toInt(orbital && orbital.itemID, 0)) ||
            planetOrbitalState.isSkyhookDeploymentUnpublished(orbital)) {
          continue;
        }
        // A destroyed office keeps its record purely as a tombstone so the planet
        // does not read as unoccupied and respawn a fresh default; it must not be
        // rebuilt back into space.
        if (planetOrbitalState.isOrbitalRecordDestroyed(orbital)) {
          continue;
        }
        this.addStaticEntity(buildStaticPlanetOrbitalEntity(orbital));
      }
      for (const orbital of planetOrbitalState.listDefaultCustomsOfficesForSystem(this.systemID)) {
        this.addStaticEntity(buildStaticPlanetOrbitalEntity(orbital));
      }

      for (const item of systemSpaceItems) {
        if (!shouldHydrateInventoryItemIntoScene(item, this.sceneDescriptor)) {
          this.abyssalInventoryHydrationRejectedCount += 1;
          continue;
        }
        const entity = buildRuntimeSpaceEntityFromItem(
          item,
          this.systemID,
          this.getCurrentSimTimeMs(),
          {
            // Fresh scenes should not resurrect persisted player-owned ships for
            // bystanders. The owning pilot is reattached explicitly on login,
            // and other player hulls should not leak back into space on restart.
            includeOfflinePlayerShips: false,
          },
        );
        if (!entity) {
          continue;
        }
        decorateEntitySceneOwnership(entity, this.sceneDescriptor);
        this.dynamicEntities.set(entity.itemID, entity);
        // A stored sphere comes back with its scene.
        this.trackInterdictionVolume(entity, item);
        this.markBallJoiningMovement(entity);
        this.indexDynamicEntityExpiry(entity);
        this.indexCommandBurstExpiry(entity);
        if (entity.kind === "drone") {
          this.droneEntityIDs.add(entity.itemID);
        }
        if (entity.kind === "fighter") {
          this.fighterEntityIDs.add(entity.itemID);
        }
        if (entity.kind === "deployable") {
          deployableCynoRuntime.registerMobileCynoDeployableItem(entity.itemID);
          mobileDepotRuntime.registerMobileDepotItem(entity.itemID);
          mobileAnalysisBeaconRuntime.registerMobileAnalysisBeaconItem(entity.itemID);
          mobileCynoInhibitorRuntime.registerMobileCynoInhibitorItem(entity.itemID);
          mobileMicroJumpUnitRuntime.registerMobileMicroJumpUnitItem(entity.itemID);
          mobileObservatoryRuntime.registerMobileObservatoryItem(entity.itemID);
          mobilePhaseAnchorRuntime.registerMobilePhaseAnchorItem(entity.itemID);
          mobileScanInhibitorRuntime.registerMobileScanInhibitorItem(entity.itemID);
          mobileSiphonUnitRuntime.registerMobileSiphonUnitItem(entity.itemID);
          mobileTractorUnitRuntime.registerMobileTractorUnitItem(entity.itemID);
          mobileWarpDisruptorRuntime.registerMobileWarpDisruptorItem(entity.itemID);
        }
        this.reboxBall(entity);
      }
    }
    require("../../services/sovereignty/skyhookRaidRuntime").reconcileScene(this);
  }

  // The two readings of the Destiny tick counter, and
  // nothing time-based: destinyTick is N, the number of the last tick run;
  // nextDestinyStamp is N + 1, which everything queued or sent until the
  // next tick carries, and which the running tick carries until its Evolve
  // ends.
  get destinyTick() {
    return this.destinyTickDriver.destinyTick;
  }

  get nextDestinyStamp() {
    return this.destinyTickDriver.nextDestinyStamp;
  }

}

Object.assign(module.exports, {
  SolarSystemScene,
});
