"use strict";

/**
 * EVE.js — World Bootstrap
 *
 * The startup sequence that turns a gameStore on disk into a running world:
 * static-table reconciliation, content packs, database preload, core fixtures,
 * service registration, and the listeners and durable owners on top.
 *
 * Extracted verbatim from index.js so callers other than the server process can
 * boot the same world with pieces switched off. The gameplay test harness boots
 * with every listener and durable owner disabled; index.js boots with all of
 * them, which is the default here.
 *
 * This module lives next to index.js on purpose: every path below is
 * __dirname-relative and moving the file would silently change what they
 * resolve to.
 *
 * The caller owns process-level concerns. Setting EVEJS_GAMESTORE_OWNER_ROLE
 * must happen before this module is required, because requiring it loads
 * gameStore transitively.
 */

const fs = require("fs");
const path = require("path");
const { resolveDataRootPath } = require(path.join(__dirname, "./src/config/dataRoot"));
const config = require(path.join(__dirname, "./src/config"));
const configInitialization = config.initializeConfigFiles();
const {
  CLIENT_COMPATIBILITY_PROFILE,
} = require(path.join(__dirname, "./src/network/protocolProfile"));
const rotatingLog = require(path.join(__dirname, "./src/utils/rotatingLog"));
function pruneLogArchives() {
  return rotatingLog.pruneLogArchivesSync(resolveDataRootPath("logs"), {
    keepArchiveHoursPerLog: config.logRetentionHours,
    maxArchiveBytes: config.logArchiveMaxMegabytes * 1024 * 1024,
  });
}
const startupLogCleanup = pruneLogArchives();
const log = require(path.join(__dirname, "./src/utils/logger"));
const {
  initializeContentPacks,
} = require(path.join(__dirname, "./src/contentPacks/contentPackManager"));
const {
  describeSyncResult,
  syncStaticTables,
} = require(path.join(__dirname, "./src/gameStore/syncStaticTables"));
const {
  applySovereigntyResetAtStartup,
  logSovereigntyResetState,
} = require(path.join(__dirname, "./src/services/sovereignty/sovResetMarker"));
const {
  autoInstallContentPacks,
  describeAutoInstall,
} = require(path.join(__dirname, "./src/contentPacks/autoInstallContentPacks"));
const dungeonAuthority = require(path.join(
  __dirname,
  "./src/services/dungeon/dungeonAuthority",
));
const {
  installProcessLifecycleLogging,
} = require(path.join(__dirname, "./src/utils/processLifecycle"));
const {
  installSharedOverviewMotd,
} = require(path.join(__dirname, "./src/services/overview/overviewMotdBootstrap"));
const presenceReconciler = require(path.join(
  __dirname,
  "./src/services/_shared/presenceReconciler",
));

// Service framework
const ServiceManager = require(
  path.join(__dirname, "./src/services/serviceManager"),
);
const {
  createRuntimeContext,
} = require(path.join(__dirname, "./src/runtimeContext"));
const {
  createEvejsWebGatewayRuntime,
} = require(path.join(
  __dirname,
  "./src/_secondary/express/evejsWebGatewayRuntime",
));
const {
  loadSecondaryServices,
} = require(path.join(__dirname, "./src/secondaryServiceLoader"));

// network
const startTCPServer = require(path.join(__dirname, "./src/network/tcp"));
const BaseService = require(path.join(__dirname, "./src/services/baseService"));

// database
const database = require(path.join(__dirname, "./src/gameStore"));
const {
  createProductionSchedulerRuntime,
} = require(path.join(
  __dirname,
  "./src/services/scheduler/productionSchedulerRuntime",
));
const {
  createProductionWalletAuthorityRuntime,
} = require(path.join(
  __dirname,
  "./src/services/account/productionWalletAuthorityRuntime",
));

/**
 * Every stage the server runs, on by default. A caller turns off what it does
 * not want rather than opting in to what it does, so a stage added later is
 * present for the server without anyone having to remember to enable it.
 */
const PRODUCTION_STAGES = {
  startCrewOperations: true,
  installLifecycleLogging: true,
  logBanner: true,
  syncStaticTables: true,
  // Syncs the content-packs/ drop folder into the store. A store that already
  // has its packs installed does not need it, and it is by far the most
  // expensive stage (measured at 54.9 s of a 65.2 s boot), so the harness
  // turns it off and loads the registry the store already carries.
  installContentPacks: true,
  preloadDatabase: true,
  // The one-time retail-parity sovereignty reset. Runs only with
  // preloadDatabase, and does nothing once the store carries its marker.
  resetSovereignty: true,
  ensureCoreFixtures: true,
  resetAsteroidBelts: true,
  registerServices: true,
  startSecondaryServices: true,
  installOverviewMotd: true,
  startPresenceReconciler: true,
  // Repeats the startup log archive cleanup every hour, so a long-running
  // server honors logRetentionHours without being restarted.
  startLogArchivePruning: true,
  startDurableOwners: true,
  startTCP: true,
};

function resolveStages(options) {
  const stages = { ...PRODUCTION_STAGES };
  for (const key of Object.keys(options || {})) {
    if (key in stages) {
      stages[key] = options[key] !== false;
    }
  }
  return stages;
}

function logStartupBanner() {
  log.logAsciiLogo();
  log.spacer();
  log.info("starting eve.js...");
  if (configInitialization.createdFiles.length > 0) {
    log.info(`[Config] Seeded ${configInitialization.createdFiles.length} missing domain file(s).`);
  }
  if (configInitialization.hydratedFiles.length > 0) {
    log.info(`[Config] Added missing defaults to ${configInitialization.hydratedFiles.length} domain file(s).`);
  }
  if (configInitialization.migratedFromLegacy) {
    log.info(
      `[Config] Migrated legacy root configuration to schema ${configInitialization.version.configSchemaVersion}.`,
    );
  }
  logArchiveCleanup("Startup", startupLogCleanup);
  log.spacer();

  // Display version info
  log.debug(`EveJS Version: ${configInitialization.version.evejsVersion}`);
  log.debug(`Project: ${CLIENT_COMPATIBILITY_PROFILE.projectVersion}`);
  log.debug(`Client Version: ${CLIENT_COMPATIBILITY_PROFILE.clientVersion}`);
  log.debug(`Client Build: ${CLIENT_COMPATIBILITY_PROFILE.clientBuild}`);
  log.debug(`MachoNet Version: ${CLIENT_COMPATIBILITY_PROFILE.machoVersion}`);
  log.line();
}

function logArchiveCleanup(label, summary) {
  if (summary.deletedFiles > 0) {
    log.info(
      `[RotatingLog] ${label} cleanup removed ${summary.deletedFiles} log archive(s) ` +
        `(${summary.beyondRetentionFiles} beyond retention, ${summary.oversizedFiles} oversized; ` +
        `${summary.deletedBytes} bytes; retention=${summary.keepArchiveHoursPerLog}h per log, ` +
        `limit=${summary.maxArchiveBytes} bytes).`,
    );
  }
  if (summary.orphanedLockOwnerFiles > 0) {
    log.info(
      `[RotatingLog] ${label} cleanup removed ${summary.orphanedLockOwnerFiles} ` +
        `orphaned rotation lock owner file(s).`,
    );
  }
  if (summary.failedPaths.length > 0) {
    log.warn(
      `[RotatingLog] ${label} cleanup could not inspect or remove ` +
        `${summary.failedPaths.length} log path(s).`,
    );
  }
  if (summary.skippedLockedPaths.length > 0) {
    log.info(
      `[RotatingLog] ${label} cleanup left ${summary.skippedLockedPaths.length} ` +
        `archive(s) owned by an active rotation.`,
    );
  }
}

function startLogArchivePruning() {
  const timer = setInterval(() => {
    try {
      logArchiveCleanup("Hourly", pruneLogArchives());
    } catch (error) {
      log.warn(`[RotatingLog] Hourly cleanup failed: ${error.message}`);
    }
  }, 60 * 60 * 1_000);
  // Cleanup must never be the reason the process stays alive.
  timer.unref();
  return timer;
}

function registerServices(serviceManager) {
  const servicesDir = path.join(__dirname, "./src/services");

  function loadServices(dir) {
    const files = fs.readdirSync(dir, { withFileTypes: true });
    for (const file of files) {
      const fullPath = path.join(dir, file.name);
      if (file.isDirectory()) {
        loadServices(fullPath);
      } else if (
        file.isFile() &&
        file.name.endsWith("Service.js") &&
        file.name !== "baseService.js" &&
        file.name !== "serviceManager.js"
      ) {
        try {
          const exported = require(fullPath);
          // Only service classes are registered; a *Service.js module may
          // also export helpers (dungeonLevelEditorService exports three).
          const isServiceClass = (candidate) =>
            typeof candidate === "function" && candidate.prototype instanceof BaseService;
          if (typeof exported === "function") {
            if (isServiceClass(exported)) serviceManager.register(new exported());
          } else if (typeof exported === "object" && exported !== null) {
            for (const key in exported) {
              if (isServiceClass(exported[key])) {
                serviceManager.register(new exported[key]());
              }
            }
          }
        } catch (err) {
          log.err(`failed to load service from ${fullPath}: ${err.message}`);
        }
      }
    }
  }

  loadServices(servicesDir);

  if (serviceManager.lookup("trademgr") && !serviceManager.lookup("tradeMgr")) {
    serviceManager.registerAlias("tradeMgr", "trademgr");
  }

  log.success(`registered ${serviceManager.count} services`);
  log.line();
}

/**
 * Boot the world.
 *
 * @param {object} [options] any key of PRODUCTION_STAGES, set false to skip.
 * @returns {Promise<object>} the built world: serviceManager, runtimeContext,
 *   gatewayRuntime, database, the durable runtimes when started, and shutdown().
 */
async function bootWorld(options = {}) {
  require("./src/services/seasons/installEventRuntime").install();
  const stages = resolveStages(options);

  if (stages.installLifecycleLogging) {
    installProcessLifecycleLogging({ appName: options.appName || "eve.js server" });
  }
  if (stages.logBanner) {
    logStartupBanner();
  }

  // A store is generated once and then kept, so its static tables drift from the
  // installed release: a table a later release adds is absent, and one a later
  // release changes stays stale. Both have broken a release. Reconcile before
  // anything reads one -- the content-pack merge on the line below is what fails
  // otherwise, with CONTENT_PACK_DUNGEON_BASE_UNAVAILABLE for the first and
  // CONTENT_PACK_TEMPLATE_CONFLICT for the second.
  if (stages.syncStaticTables) {
    const staticTableSync = syncStaticTables();
    const staticTableSyncSummary = describeSyncResult(staticTableSync);
    if (staticTableSyncSummary) {
      log.info(`[GameStore] ${staticTableSyncSummary}`);
    }
  }

  // The release ships its content packs in content-packs/ and the server installs
  // whatever is there, so nobody has to install one by hand. The folder is the
  // source of truth: delete a file to run without that pack. Skipped outright when
  // the folder and the registry both match the last run, because re-importing
  // 232 MB of packs to conclude there is nothing to do takes the best part of a
  // minute. Must run before the snapshot below, which is what reads the registry.
  if (stages.installContentPacks) {
    const contentPackInstall = autoInstallContentPacks();
    for (const line of describeAutoInstall(contentPackInstall)) {
      log.info(`[ContentPacks] ${line}`);
    }
  }

  // Content packs are an immutable process-start snapshot. A missing registry is a
  // valid contentless install; a registry that names a missing, corrupt, or
  // incompatible pack fails startup instead of silently falling back.
  const installedContentPacks = initializeContentPacks();
  // Register optional encounter behavior before services/clients can process
  // scenes. Lower-level engine code imports only the dependency-free ports.
  require("./src/services/homefront/installHomefront").installHomefront();
  require("./src/services/incursion/installIncursions").installIncursions();
  // Force the effective merge outside service discovery's recovery boundary so
  // cross-pack or core collisions fail the whole startup instead of leaving a
  // partially initialized server.
  dungeonAuthority.initializeDungeonAuthority();
  if (installedContentPacks.length === 0) {
    log.info("[ContentPacks] No optional content packs installed.");
  } else {
    for (const installedPack of installedContentPacks) {
      log.info(
        `[ContentPacks] Loaded ${installedPack.validation.id}@` +
          `${installedPack.validation.version} (${installedPack.validation.packSha256}).`,
      );
    }
  }
  log.line();

  // Preload database into memory before services initialize
  if (stages.preloadDatabase) {
    database.preloadAll();
    // Old sovereignty data (TCU claims, empty claims) is never repaired. The
    // one-time reset removes it, after a backup, and leaves a marker. It runs
    // here, before any service, scene or durable owner reads sovereignty, and
    // a failure stops startup. With the setting off the server only reports.
    if (stages.resetSovereignty) {
      if (config.sovereigntyOneTimeParityReset === true) {
        await applySovereigntyResetAtStartup(log, database);
      } else {
        logSovereigntyResetState(log, database);
      }
    }
    // Repair published courier wraps before any inventory listener can expose
    // their legacy quantity. Each repair is durably fenced by the contract
    // owner; incomplete escrow evidence is left untouched and reported.
    const courierVolumes = require("./src/services/contracts/contractRuntimeState")
      .reconcilePublishedCourierVolumes();
    if (!courierVolumes || !Array.isArray(courierVolumes.skipped) ||
        !Array.isArray(courierVolumes.failures)) {
      throw new Error("Courier volume reconciliation did not return a valid result");
    }
    if (courierVolumes.reconciled > 0) {
      log.info(`[CourierVolume] Reconciled ${courierVolumes.reconciled} published courier wrap(s).`);
    }
    if (courierVolumes.skipped.length > 0) {
      log.warn(
        `[CourierVolume] Left ${courierVolumes.skipped.length} courier wrap(s) unchanged: ` +
          courierVolumes.skipped.map(({ contractID, reason }) => `${contractID}: ${reason}`).join(", "),
      );
    }
    if (courierVolumes.failures.length > 0) {
      const details = courierVolumes.failures
        .map(({ contractID, reason }) => `${contractID}: ${reason}`).join(", ");
      log.err(`[CourierVolume] Failed durable reconciliation: ${details}`);
      throw new Error(`Courier volume reconciliation failed: ${details}`);
    }
    log.line();
  }

  // Recreate any canonical fixtures (bootstrap characters, the player
  // corporation 98000000 and its alliance 99000000) that a pruned or
  // regenerated local database may be missing. Idempotent.
  if (stages.ensureCoreFixtures) {
    try {
      const {
        ensureCoreFixtures,
      } = require(path.join(__dirname, "./src/services/corporation/coreFixtureSeeder"));
      const fixtureSummary = ensureCoreFixtures();
      const seededCount =
        fixtureSummary.charactersCreated.length +
        (fixtureSummary.corporationCreated ? 1 : 0) +
        (fixtureSummary.allianceCreated ? 1 : 0);
      if (seededCount > 0) {
        log.info(
          `[CoreFixtures] Seeded missing fixtures: ${fixtureSummary.charactersCreated.length} character(s)` +
            `${fixtureSummary.corporationCreated ? ", player corporation" : ""}` +
            `${fixtureSummary.allianceCreated ? ", player alliance" : ""}.`,
        );
      }
      log.line();
    } catch (err) {
      log.err(`[CoreFixtures] Failed startup fixture seeding: ${err.message}`);
      log.line();
    }
  }

  // Repopulate mined-out asteroid belts. Belt fields regenerate deterministically
  // whenever a scene is built, so this only has to drop the persisted depletion
  // state that would otherwise delete each rock again on spawn. Must run before
  // any scene exists. Ice sites respawn on their own lifecycle and are left alone.
  if (stages.resetAsteroidBelts && config.asteroidBeltStartupReset === true) {
    try {
      const miningRuntimeState = require(path.join(
        __dirname,
        "./src/services/mining/miningRuntimeState",
      ));
      const beltResetStartedAtMs = Date.now();
      const beltReset = miningRuntimeState.resetPersistedBeltAsteroidState();
      const beltResetTookMs = Date.now() - beltResetStartedAtMs;
      if (beltReset.entitiesCleared > 0) {
        log.info(
          `[BeltReset] Repopulated ${beltReset.entitiesCleared} mined belt asteroid(s) across ` +
            `${beltReset.systemsTouched} system(s) in ${beltResetTookMs}ms.`,
        );
      }
      log.line();
    } catch (err) {
      log.err(`[BeltReset] Failed startup belt asteroid reset: ${err.message}`);
      log.line();
    }
  }

  // create and populate service manager
  const serviceManager = new ServiceManager();
  const gatewayRuntime = createEvejsWebGatewayRuntime({ serviceManager });
  const runtimeContext = createRuntimeContext({ serviceManager, gatewayRuntime });

  if (stages.registerServices) {
    registerServices(serviceManager);
  }

  // Fork listener-owning secondary services after service registration. Wormhole
  // lifecycle work starts later, after the TCP startup path warms its runtime
  // state, so its first budgeted slice never inherits cold-cache construction.
  if (stages.startSecondaryServices) {
    const secondaryServicesDir = path.join(__dirname, "./src/_secondary");
    loadSecondaryServices(secondaryServicesDir, runtimeContext);
  }

  if (stages.installOverviewMotd) {
    try {
      installSharedOverviewMotd(serviceManager);
      log.spacer();
    } catch (err) {
      log.err(`[OverviewPresetMgr] Failed startup MOTD bootstrap: ${err.message}`);
      log.spacer();
    }
  }

  // Start the presence reconciler (safety net that re-converges local-chat and
  // station/structure guest visibility for missed fire-and-forget deltas).
  if (stages.startPresenceReconciler) {
    try {
      presenceReconciler.start();
      log.spacer();
    } catch (err) {
      log.err(`[PresenceReconcile] Failed to start: ${err.message}`);
      log.spacer();
    }
  }

  if (stages.startLogArchivePruning) {
    startLogArchivePruning();
  }

  const world = {
    serviceManager,
    runtimeContext,
    gatewayRuntime,
    database,
    installedContentPacks,
    schedulerRuntime: null,
    walletAuthorityRuntime: null,
    stages,
    shutdown: null,
  };

  if (stages.startCrewOperations && stages.startDurableOwners) {
    require("./src/services/crew/crewRuntime").startCrewOperations();
  }

  // A failed Homefront save must not stop the database shutdown that follows,
  // or every other table's pending writes are lost with it.
  const flushHomefrontOperations = () => {
    try {
      require("./src/services/homefront/homefrontHooks").rewards.flushOperations();
    } catch (error) {
      log.error(`[Bootstrap] Homefront operation flush failed at shutdown: ${error.message}`);
    }
  };

  if (!stages.startDurableOwners) {
    world.shutdown = async () => {
      require("./src/services/crew/crewRuntime").stopCrewOperations();
      flushHomefrontOperations();
      return database.shutdown("bootWorld-shutdown");
    };
    return world;
  }

  // Start the TCP server with the service manager
  const productionSchedulerRuntime = createProductionSchedulerRuntime();
  const unregisterProductionSchedulerShutdown = database.registerShutdownHook(
    "production-scheduler",
    () => productionSchedulerRuntime.shutdown(),
  );
  const productionWalletAuthorityRuntime = createProductionWalletAuthorityRuntime();
  const unregisterProductionWalletAuthorityShutdown = database.registerShutdownHook(
    "wallet-authority",
    () => productionWalletAuthorityRuntime.shutdown(),
  );
  world.schedulerRuntime = productionSchedulerRuntime;
  world.walletAuthorityRuntime = productionWalletAuthorityRuntime;
  world.shutdown = async () => {
    require("./src/services/crew/crewRuntime").stopCrewOperations();
    flushHomefrontOperations();
    unregisterProductionSchedulerShutdown();
    unregisterProductionWalletAuthorityShutdown();
    await productionSchedulerRuntime.shutdown().catch(() => null);
    await productionWalletAuthorityRuntime.shutdown().catch(() => null);
    return database.shutdown("bootWorld-shutdown");
  };

  try {
    const walletResult = await productionWalletAuthorityRuntime.start();
    log.info(
      `[WalletAuthority] Process owner ready after flushing ${walletResult.preflightTables} parent table(s).`,
    );
    // Before anything can pay or spend: a balance edited while the server was
    // down (Config Editor, player import) never passed the wallet limit.
    const walletLimit = await require(path.join(
      __dirname,
      "./src/services/account/walletState",
    )).lowerCharacterBalancesToWalletLimitAsync();
    if (walletLimit.lowered > 0 || walletLimit.failed.length > 0) {
      log.warn(
        `[WalletAuthority] Lowered ${walletLimit.lowered} character wallet(s) to the wallet limit; ` +
          `${walletLimit.failed.length} could not be lowered` +
          (walletLimit.failed.length > 0 ? ` (${walletLimit.failed.join(", ")})` : "") +
          ".",
      );
    }
    const result = await productionSchedulerRuntime.start();
    log.info(
      `[DurableScheduler] Owners ready; reconciled bills=${result.billJobs} bounty=${result.bountyJobs} assetSafety=${result.assetSafetyJobs} industry=${result.industryJobs} marketExpiry=${result.marketExpiryJobs} skillQueue=${result.skillQueueJobs} expertSystems=${result.expertSystemJobs} raffles=${result.raffleJobs} calendar=${result.calendarJobs} globalSites=${result.globalSiteJobs} starbaseFuelTowers=${result.starbaseFuelTowers} starbaseFuelCycles=${result.starbaseFuelCyclesConsumed} starbaseFuelExhausted=${result.starbaseFuelExhaustedTowers} starbaseFuelFailures=${result.starbaseFuelReconciliationFailures} starbaseFuelOfflineCatchup=${result.starbaseFuelOfflineCatchupEnabled}.`,
    );
    const missionPackReconcile = require(path.join(
      __dirname,
      "./src/services/agent/agentMissionRuntime",
    )).reconcileUnavailableContentPackMissions();
    if (missionPackReconcile.retired > 0) {
      log.info(
        `[ContentPacks] Administratively retired ${missionPackReconcile.retired} active ` +
          `mission(s) whose installed content is unavailable; removed ` +
          `${missionPackReconcile.dungeonInstancesRemoved} dungeon instance(s).`,
      );
    }
    if (missionPackReconcile.skippedPendingSettlements > 0) {
      log.warn(
        `[ContentPacks] Preserved ${missionPackReconcile.skippedPendingSettlements} unavailable ` +
          `mission(s) with pending reward settlement(s).`,
      );
    }
    if (stages.startTCP) {
      world.tcpServer = await startTCPServer(serviceManager);
    }
  } catch (error) {
    // Unwind exactly what index.js unwound before it exited, then hand the
    // failure to the caller so a non-server caller is not killed by a startup
    // path it may want to recover from.
    log.err(`[Startup] Failed while starting production owners: ${error.message}`);
    require("./src/services/crew/crewRuntime").stopCrewOperations();
    unregisterProductionSchedulerShutdown();
    unregisterProductionWalletAuthorityShutdown();
    await productionSchedulerRuntime.shutdown().catch(() => null);
    await productionWalletAuthorityRuntime.shutdown().catch(() => null);
    try {
      const storeShutdown = await database.shutdown("startup-owner-failure");
      if (!storeShutdown || storeShutdown.success !== true) {
        log.err(
          `[Startup] GameStore shutdown failed: ` +
            `${storeShutdown && storeShutdown.errorMsg || "UNKNOWN"}`,
        );
      }
    } catch (shutdownError) {
      log.err(`[Startup] GameStore shutdown failed: ${shutdownError.message}`);
    }
    throw error;
  }

  return world;
}

module.exports = {
  bootWorld,
  PRODUCTION_STAGES,
};
