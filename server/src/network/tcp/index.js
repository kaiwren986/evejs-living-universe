"use strict";

// EveJS Elysian TCP Server
// Handles client connections and drives the handshake state machine.
// After handshake, routes packets via the PacketDispatcher.

const path = require("path");
const net = require("node:net");
const zlib = require("node:zlib");
const pc = require("picocolors");

const log = require(path.join(__dirname, "../../utils/logger"));
const config = require(path.join(__dirname, "../../config"));
const { PROXY_NODE_ID } = require(path.join(__dirname, "../protocolProfile"));
const EVEHandshake = require(path.join(__dirname, "./handshake"));
const { marshalDecode } = require(path.join(__dirname, "./utils/marshal"));
const ClientSession = require(path.join(__dirname, "../clientSession"));
const PacketDispatcher = require(path.join(__dirname, "../packetDispatcher"));
const database = require(path.join(__dirname, "../../gameStore"));
const { configureGameClientSocket } = require(path.join(
  __dirname,
  "./socketTuning",
));
const { attachDirectGameSocketTransport } = require(path.join(
  __dirname,
  "./directGameSocketTransport",
));
const { createGameRuntimeLifecycle } = require(path.join(
  __dirname,
  "./gameRuntimeLifecycle",
));
const sessionRegistry = require(path.join(
  __dirname,
  "../../services/chat/sessionRegistry",
));
const {
  disconnectCharacterSession,
} = require(path.join(__dirname, "../../services/_shared/sessionDisconnect"));
const spaceRuntime = require(path.join(__dirname, "../../space/runtime"));
const { configureAbyssalManagerEnginePort } = require(path.join(
  __dirname,
  "../../space/abyssalEngineAdapter",
));
// Bind the Abyssal engine port before any request can arrive. A port that
// fails validation must not stop the server from starting: Abyssal entry then
// refuses with its own port error while every other service keeps working.
try {
  configureAbyssalManagerEnginePort(spaceRuntime);
} catch (error) {
  log.error(
    `[Startup] Abyssal engine port unavailable; Abyssal Deadspace is disabled ` +
      `until the server restarts with a valid runtime: ${error && error.message || "UNKNOWN"}`,
  );
}
const { logStartupDataSummary } = require(path.join(
  __dirname,
  "../../utils/startupDataSummary",
));
const tidiAutoscaler = require(path.join(
  __dirname,
  "../../utils/tidiAutoscaler",
));
const { MACHONETMSG_TYPE } = require(
  path.join(__dirname, "../../common/packetTypes"),
);
const { encodeAddress } = require(
  path.join(__dirname, "../../common/machoAddress"),
);
const { normalizeCountryCode } = require(path.join(
  __dirname,
  "../../services/machoNet/globalConfig",
));
const {
  composeSessionRoleMask,
} = require(path.join(
  __dirname,
  "../../services/account/accountRoleProfiles",
));
const dungeonUniverseRuntime = require(path.join(
  __dirname,
  "../../services/dungeon/dungeonUniverseRuntime",
));
const dungeonRuntime = require(path.join(
  __dirname,
  "../../services/dungeon/dungeonRuntime",
));
const dungeonUniverseSiteService = require(path.join(
  __dirname,
  "../../services/dungeon/dungeonUniverseSiteService",
));
const wormholeRuntime = require(path.join(
  __dirname,
  "../../services/exploration/wormholes/wormholeRuntime",
));
const {
  createSocketLifecycle,
  isExpectedPlayerRequestedDisconnectSocketError,
  isExpectedPreSessionSocketError,
} = require(path.join(__dirname, "./socketLifecycle"));
const { closeOtherSessionsOfUser } = require(path.join(
  __dirname,
  "./accountLoginClose",
));

/**
 * start the tcp server.
 * @param {ServiceManager} serviceManager - the service manager with registered services
 */
module.exports = function (serviceManager) {
  const dispatcher = new PacketDispatcher(serviceManager);
  const gameRuntimeLifecycle = createGameRuntimeLifecycle({
    dungeonRuntime,
    dungeonUniverseSiteService,
    tidiAutoscaler,
    wormholeRuntime,
  });
  const startupPreloadPlan = spaceRuntime.getStartupSolarSystemPreloadPlan();

  log.startupSection(
    "NEW EDEN SYSTEM LOADING",
    [
      {
        label: "Mode",
        value: `${startupPreloadPlan.mode}  ${startupPreloadPlan.modeName}`,
      },
      {
        label: "Rule",
        value: startupPreloadPlan.selectionRule,
      },
      {
        label: "Targets",
        value: startupPreloadPlan.targetSummary,
      },
      {
        label: "Systems",
        value: `${startupPreloadPlan.systemIDs.length} queued for startup preload`,
      },
    ],
    {
      accentColor: pc.cyan,
      titleRenderer: (value) => pc.bgCyan(pc.black(value)),
      valueColor: pc.white,
      subtitle: "after DB cache, before scene bootstrap",
    },
  );

  const universePrepareStartedAtMs = Date.now();
  log.info("[Startup] Mining anomaly reconciliation: keeping live ice, clearing depleted ice, reconciling ordinary ore");
  // A restart is this emulator's downtime. Ordinary ore and live generated ice
  // keep their instances, so a half-mined belt keeps its leftovers. Depleted ice
  // is cleared and rebuilt fresh when its system next wakes, as at retail
  // downtime, rather than waiting out its six-hour respawn timer.
  const startupMiningReset = dungeonUniverseRuntime.resetStartupMiningAnomalies({
    enabled: true,
  });
  const universePrepareElapsedMs = Date.now() - universePrepareStartedAtMs;
  log.info(
    `[Startup] Mining anomaly reset complete in ${universePrepareElapsedMs}ms ` +
      `(purged=${Number(startupMiningReset && startupMiningReset.purgedCount) || 0} ` +
      `oreSitesRestored=${Number(startupMiningReset && startupMiningReset.desiredOreSites) || 0} ` +
      `systems=${(startupMiningReset && startupMiningReset.affectedSystemIDs || []).length} ` +
      `oreAuthority=v${Number(startupMiningReset && startupMiningReset.oreSecurityAuthorityVersion) || 0} ` +
      `oreEligibleSystems=${Number(startupMiningReset && startupMiningReset.oreEligibleSystems) || 0} ` +
      `oreIneligibleTierSystems=${Number(startupMiningReset && startupMiningReset.oreIneligibleTierSystems) || 0} ` +
      `oreRetained=${Number(startupMiningReset && startupMiningReset.oreRetainedByAuthority) || 0} ` +
      `oreWrongSecurity=${Number(startupMiningReset && startupMiningReset.oreReplacedWrongSecurity) || 0} ` +
      `oreDuplicates=${Number(startupMiningReset && startupMiningReset.oreReplacedDuplicate) || 0} ` +
      `oreValidationErrors=${Number(startupMiningReset && startupMiningReset.oreAuthorityValidationErrors) || 0})`,
  );

  // Persisted universe sites whose content pack is no longer installed have no
  // template or spawn family to materialize from; drop them before any scene loads.
  const orphanSweep = dungeonUniverseRuntime.resetStartupOrphanedUniverseSites({});
  log.info(
    `[Startup] Orphaned universe site sweep: scanned=${orphanSweep.scannedCount} ` +
      `purged=${orphanSweep.purgedCount} ` +
      `(missingSpawnFamily=${orphanSweep.byReason.missing_spawn_profile} ` +
      `missingTemplate=${orphanSweep.byReason.missing_template}) ` +
      `systems=${orphanSweep.affectedSystemIDs.length}`,
  );

  const awakeDungeonSystemIDs = () => spaceRuntime.listAwakeSolarSystemIDs();
  try {
    const AbyssalMgrService = require("../../abyssal").lifecycleHooks;
    if (
      AbyssalMgrService &&
      typeof AbyssalMgrService.prepareStartupRecoveryBarrier === "function"
    ) {
      const abyssalRecoveryResult =
        AbyssalMgrService.prepareStartupRecoveryBarrier("tcp-startup");
      if (abyssalRecoveryResult && abyssalRecoveryResult.success === false) {
        log.warn(
          `[Startup] Abyssal recovery completed with failures ` +
            `failedRuns=${Array.isArray(abyssalRecoveryResult.failedInstanceIDs) ? abyssalRecoveryResult.failedInstanceIDs.join(",") : "unknown"}`,
        );
      }
    }
  } catch (error) {
    log.warn(`[Startup] Abyssal recovery barrier failed: ${error && error.message || "UNKNOWN"}`);
  }

  // The mission reward settlement barrier ([MissionRewardStartup]) is NOT run
  // here. It has to reconcile wedged settlements *before* the durable scheduler
  // queues them, or the pass races the retry loop it is repairing, so it runs
  // from missionRewardSettlementState.reconcileDurableMissionRewardSettlements
  // -- which server/index.js awaits before this file is reached. Adding a call
  // here would duplicate it on the wrong side of that ordering.

  log.info("[Startup] Starting dungeon universe runtime sync");
  dungeonUniverseSiteService.startRuntimeSync();
  log.info("[Startup] Starting dungeon runtime ticker");
  dungeonRuntime.startTicker({
    systemIDsProvider: awakeDungeonSystemIDs,
  });
  if (config.wormholesEnabled === true) {
    const wormholeWarmStartedAtMs = Date.now();
    log.info("[Startup] Warming wormhole runtime state before space scene preload");
    const wormholeWarm = wormholeRuntime.warmRuntimeCache(Date.now());
    log.info(
      `[Startup] Wormhole runtime warm complete in ${Date.now() - wormholeWarmStartedAtMs}ms ` +
        `(active=${Number(wormholeWarm && wormholeWarm.activePairCount) || 0} ` +
        `total=${Number(wormholeWarm && wormholeWarm.totalPairCount) || 0})`,
    );
    wormholeRuntime.startLifecycleScheduler();
    log.info("[Wormholes] Bounded lifecycle scheduler started after runtime warm");
  }
  log.info("[Startup] Starting space scene preload");
  spaceRuntime.preloadStartupSolarSystems({
    broadcast: false,
    reconcileUniverseSites: false,
  });

  function logDebug(t) {
    if (config.logLevel > 1) log.debug(t);
  }

  function logInfo(t) {
    if (config.logLevel > 0) log.info(t);
  }

  // Each open socket's lifecycle, so a shutdown can log its pilot off first.
  const socketLifecycles = new Map();

  const handleSocket = (socket) => {
    logInfo(
      `New connection from ${socket.remoteAddress}:${socket.remotePort}`,
    );

    // Direct native ownership is the stable production path. Keepalive and
    // no-delay now apply to the real socket instead of a process proxy.
    configureGameClientSocket(socket, config, log);

    // Create a handshake state machine for this connection
    const handshake = new EVEHandshake(socket);
    let handshakeComplete = false;
    let clientSession = null;
    const socketLifecycle = createSocketLifecycle({
      getSession: () => clientSession,
      disconnectSession(session) {
        disconnectCharacterSession(session, {
          broadcast: true,
          clearSession: true,
        });
      },
      releaseBoundObjects(session) {
        const released = serviceManager.releaseSessionBoundObjects(session);
        if (released > 0) logInfo(`released ${released} bound objects with the closed session`);
      },
      unregisterSession: (session) => sessionRegistry.unregister(session),
    });
    socketLifecycles.set(socket, socketLifecycle);

    // Start the handshake (sends VersionExchangeServer)
    handshake.start();

    attachDirectGameSocketTransport(socket, {
      handleFrame(payload) {
        if (socketLifecycle.closed) return;
        if (!handshakeComplete) {
          // Pass to handshake state machine
          try {
            const result = handshake.handlePacket(payload);
            if (result.done) {
              handshakeComplete = true;
              logDebug(
                `Handshake complete for ${socket.remoteAddress} — entering packet dispatch mode`,
              );

              // Create client session from handshake data
              clientSession = new ClientSession(
                {
                  userId: handshake.userId,
                  userName: handshake.userName,
                  clientId: handshake.clientId,
                  accountRole: handshake.accountRole,
                  chatRole: handshake.role,
                  role: composeSessionRoleMask(
                    handshake.accountRole,
                    handshake.role,
                  ),
                  languageId: handshake.languageId,
                  countryCode: handshake.countryCode,
                  sessionId: handshake.sessionId,
                },
                socket,
                {
                  encrypted: handshake.encrypted,
                  sessionKey: handshake.sessionKey,
                  sessionIV: handshake.sessionIV,
                  encryptFn: handshake.encrypted
                    ? (data) => handshake._encrypt(data)
                    : null,
                  decryptFn: handshake.encrypted
                    ? (data) => handshake._decrypt(data)
                    : null,
                },
              );

              logInfo(
                `session created for ${clientSession.userName} (ID: ${clientSession.userid})`,
              );
              sessionRegistry.register(clientSession);
              // One client for each account: the account's earlier clients
              // are closed (sessionMgr.CloseUserSessions spares the new one).
              closeOtherSessionsOfUser(clientSession);

              // Send SessionInitialStateNotification to unblock client
              // The client waits for this before making further service calls
              _sendSessionInitNotification(clientSession, config);
            }
          } catch (err) {
            log.err(`handshake error: ${err.message}`);
            logDebug(`stack: ${err.stack}`);
          }
          return;
        }

        // ── Post-handshake packet dispatch ────────────────────────
        try {
          // Decrypt if needed
          let data = payload;
          if (clientSession) {
            data = clientSession.decryptPacket(payload);
          }
          if (data[0] === 0x78) {
            data = zlib.inflateSync(data);
          }
          const decoded = marshalDecode(data);

          if (log.isPacketPayloadDebugEnabled()) {
            if (decoded && decoded.type === "object" && decoded.args) {
              logDebug(
                `[TCP] incoming PyPacket: ${decoded.name} has tuple length: ${decoded.args.length}`,
              );
            }

            logDebug(
              `[TCP] decoded packet: ${JSON.stringify(decoded, (k, v) => {
                if (typeof v === "bigint") return v.toString();
                if (v && v.type === "Buffer" && v.data) {
                  try {
                    return `<Buffer:${Buffer.from(v.data).toString("utf8")}>`;
                  } catch (e) {
                    // ignored: debug output only: the value is logged as it is
                  }
                }
                return v;
              }).substring(0, 500)}`,
            );
          }

          // Dispatch asynchronously so services can await external RPC calls
          Promise.resolve(dispatcher.dispatch(decoded, clientSession)).catch((err) => {
            log.err(`[TCP] async packet dispatch error: ${err.message}`);
            logDebug(`[TCP] async dispatch stack: ${err.stack}`);
          });
        } catch (err) {
          log.err(`[TCP] packet processing error: ${err.message}`);
          logDebug(`[TCP] stack: ${err.stack}`);
          logDebug(
            `[TCP] raw: ${payload.toString("hex").substring(0, 80)}...`,
          );
        }
      },
      onFrameError(error) {
        log.err(
          `[TCP] frame transport error peer=${socket.remoteAddress || "unknown"}:` +
            `${socket.remotePort || 0}: ${error.message}`,
        );
      },
      onProtocolError(error) {
        log.err(
          `[TCP] invalid frame peer=${socket.remoteAddress || "unknown"}:` +
            `${socket.remotePort || 0} code=${error.code}: ${error.message}`,
        );
      },
    });

    socket.on("close", () => {
      socketLifecycle.close();
      socketLifecycles.delete(socket);
      logInfo(
        `connection closed: ${socket.remoteAddress}:${socket.remotePort}`,
      );
    });

    socket.on("error", (err) => {
      const peer = `${socket.remoteAddress || "unknown"}:${socket.remotePort || 0}`;
      const expectedPreSessionError = isExpectedPreSessionSocketError(
        err,
        clientSession,
      );
      const expectedPlayerDisconnectError =
        isExpectedPlayerRequestedDisconnectSocketError(err, clientSession);
      socketLifecycle.close();
      if (expectedPreSessionError) {
        logDebug(
          `[TCP] pre-session socket closed peer=${peer} code=${err.code}: ${err.message}`,
        );
        return;
      }
      if (expectedPlayerDisconnectError) {
        logDebug(
          `[TCP] player-requested socket closed peer=${peer} code=${err.code}: ${err.message}`,
        );
        return;
      }
      log.err(`[TCP] socket error peer=${peer}: ${err.message}`);
    });
  };

  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    try {
      handleSocket(socket);
    } catch (error) {
      log.err(
        `[TCP] failed to initialize peer=${socket.remoteAddress || "unknown"}:` +
          `${socket.remotePort || 0}: ${error.message}`,
      );
      socket.destroy();
    }
  });

  let shutdownPromise = null;
  let unregisterGameRuntimeShutdownHook = null;
  let unregisterShutdownHook = null;
  const runtime = Object.freeze({
    getSnapshot() {
      return Object.freeze({
        activeSockets: sockets.size,
        address: server.address(),
        listening: server.listening,
        transport: "direct",
      });
    },
    shutdown() {
      if (shutdownPromise) return shutdownPromise;
      // Log every pilot off now, while the store still takes writes. A
      // destroyed socket's close event fires only after the store has shut
      // down, which lost the ship's position and the logoff state.
      for (const socketLifecycle of socketLifecycles.values()) {
        try {
          socketLifecycle.close();
        } catch (error) {
          log.warn(`[TCP] shutdown logoff failed: ${error.message}`);
        }
      }
      shutdownPromise = new Promise((resolve, reject) => {
        const finish = (error = null) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(Object.freeze({
            activeSockets: sockets.size,
            listening: server.listening,
            transport: "direct",
          }));
        };

        if (!server.listening) {
          for (const socket of sockets) socket.destroy();
          finish();
          return;
        }

        try {
          server.close(finish);
          for (const socket of sockets) socket.destroy();
        } catch (error) {
          finish(error);
        }
      });
      return shutdownPromise;
    },
  });

  return new Promise((resolve, reject) => {
    const onStartupError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onRuntimeError = (error) => {
      log.err(`[TCP] server error: ${error.message}`);
    };
    const onListening = () => {
      server.off("error", onStartupError);
      server.on("error", onRuntimeError);
      try {
        unregisterShutdownHook = database.registerShutdownHook(
          "game-tcp",
          () => runtime.shutdown(),
        );
        unregisterGameRuntimeShutdownHook = database.registerShutdownHook(
          "game-runtime",
          () => gameRuntimeLifecycle.shutdown(),
        );
        log.success(`EveJS Elysian is running!`);
        log.success(
          `(direct listener: ${config.gameServerBindHost}:${config.serverPort})`,
        );
        try {
          logStartupDataSummary();
        } catch (error) {
          log.warn(
            `[Startup] Failed to print data summary: ${error.message}`,
          );
        }
        tidiAutoscaler.init();
        resolve(runtime);
      } catch (error) {
        if (unregisterShutdownHook) {
          unregisterShutdownHook();
          unregisterShutdownHook = null;
        }
        if (unregisterGameRuntimeShutdownHook) {
          unregisterGameRuntimeShutdownHook();
          unregisterGameRuntimeShutdownHook = null;
        }
        void Promise.allSettled([
          gameRuntimeLifecycle.shutdown(),
          runtime.shutdown(),
        ]).then(
          () => reject(error),
          () => reject(error),
        );
      }
    };

    server.once("error", onStartupError);
    server.once("listening", onListening);
    server.listen(config.serverPort, config.gameServerBindHost);
  }).catch(async (err) => {
    const cleanupResults = await Promise.allSettled([
      gameRuntimeLifecycle.shutdown(),
      runtime.shutdown(),
    ]);
    const cleanupFailures = cleanupResults
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    if (err.code === "EADDRINUSE") {
      log.printError("");
      log.printError(pc.red("  ╔══════════════════════════════════════════════════════════════╗"));
      log.printError(pc.red("  ║") + pc.bold(pc.yellowBright("   ⚠  EVE.JS SERVER ALREADY RUNNING  ⚠                      ")) + pc.red("║"));
      log.printError(pc.red("  ╠══════════════════════════════════════════════════════════════╣"));
      log.printError(pc.red("  ║") + pc.white(`   Port ${err.port || config.serverPort} is already in use.`) + " ".repeat(Math.max(0, 37 - String(err.port || config.serverPort).length)) + pc.red("║"));
      log.printError(pc.red("  ║") + pc.white("   Kill the other instance first, then try again.          ") + pc.red("║"));
      log.printError(pc.red("  ╚══════════════════════════════════════════════════════════════╝"));
      log.printError("");
    } else {
      log.err(`[TCP] server error: ${err.message}`);
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [err, ...cleanupFailures],
        "TCP startup and game runtime cleanup failed",
      );
    }
    throw err;
  });
};

/**
 * Send a SessionInitialStateNotification to the client.
 * The client blocks until it receives this after the handshake.
 */
function _sendSessionInitNotification(session, config) {
  const sessionID =
    typeof session.sid === "bigint"
      ? session.sid
      : BigInt(session.sid || session.sessionID || (Date.now() * 15));
  session.sid = sessionID;
  session.sessionID = sessionID;

  const initialState = {
    type: "dict",
    entries: [
      ["userid", session.userid || 0],
      ["userType", 30],
      [
        "role",
        {
          type: "long",
          value: composeSessionRoleMask(
            session.accountRole || session.role || 0,
            session.chatRole || 0,
          ),
        },
      ],
      ["address", session.address || "unknown"],
      ["languageID", session.languageID || "EN"],
      [
        "countryCode",
        normalizeCountryCode(session.countryCode, config.defaultCountryCode),
      ],
    ],
  };

  const payload = [
    { type: "long", value: sessionID },
    5, // sessionType = GAME
    initialState,
  ];

  const responseTuple = [
    MACHONETMSG_TYPE.SESSIONINITIALSTATENOTIFICATION, // type = 18
    encodeAddress({
      type: "node",
      nodeID: PROXY_NODE_ID,
      callID: 0,
      service: null,
    }),
    encodeAddress({
      type: "client",
      clientID: session.clientID || session.clientId || 0,
      callID: 0,
      service: null,
    }),
    session.userid || null,
    payload, // payload tuple
    { type: "dict", entries: [] }, // named payload
    null, // contextKey
    null, // traceID/bssid (8th element)
    null, // spanID/bssctx (9th element)
    null, // 10th
    null, // 11th
    null, // 12th
    null, // 13th
    null, // 14th
  ];

  const packet = {
    type: "object",
    name: "carbon.common.script.net.machoNetPacket.SessionInitialStateNotification",
    args: responseTuple,
  };

  log.pktOut("SessionInit", `initial state for user ${session.userid}`);
  session.sendPacket(packet);
}
