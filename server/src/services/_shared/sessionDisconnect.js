"use strict";

const path = require("path");

const log = require(path.join(__dirname, "../../utils/logger"));
const worldData = require(path.join(__dirname, "../../space/worldData"));
const spaceRuntime = require(path.join(__dirname, "../../space/runtime"));
const chatHub = require(path.join(__dirname, "../chat/chatHub"));
const sessionRegistry = require(path.join(__dirname, "../chat/sessionRegistry"));
const structureState = require(path.join(
  __dirname,
  "../structure/structureState",
));
const {
  unregisterCharacterSession,
} = require(path.join(__dirname, "../chat/xmppStubServer"));
const {
  abortTradesForSession,
} = require(path.join(__dirname, "../trade/tradeMgrService"));
const {
  currentFileTime,
} = require(path.join(__dirname, "./serviceHelpers"));
const {
  buildEmergencyWarpLogoffState,
  shipSuppressesEmergencyWarp,
} = require(path.join(__dirname, "./emergencyWarpRuntime"));
const {
  broadcastStationGuestLeft,
  broadcastStructureGuestLeft,
  forgetObserverGuestLedger,
} = require(path.join(__dirname, "./guestLists"));
const {
  clearCharacterFromSession,
  getActiveShipRecord,
  peekCharacterRecord,
  writeCharacterRecord,
} = require(path.join(__dirname, "../character/characterState"));
const {
  moveShipToSpace,
  findItemById,
  ITEM_FLAGS,
} = require(path.join(__dirname, "../inventory/itemStore"));
const {
  isAbyssalHostLocationID,
} = require("../../abyssal").engineSupport.hostLocation;

function hasLocationID(value) {
  const numericValue = Number(value);
  return Number.isInteger(numericValue) && numericValue > 0;
}

function resolveSystemIdentity(solarSystemID, fallback = {}) {
  const system = worldData.getSolarSystemByID(Number(solarSystemID) || 0);
  return {
    constellationID:
      Number((system && system.constellationID) || fallback.constellationID || 0) ||
      20000020,
    regionID:
      Number((system && system.regionID) || fallback.regionID || 0) ||
      10000002,
  };
}

function resolveDockedStateFromShip(activeShip, fallbackSystemID = null) {
  if (!activeShip || Number(activeShip.flagID || 0) !== ITEM_FLAGS.HANGAR) {
    return null;
  }

  const locationID = hasLocationID(activeShip.locationID)
    ? Number(activeShip.locationID)
    : null;
  if (!locationID) {
    return null;
  }

  const station = worldData.getStationByID(locationID);
  if (station) {
    const solarSystemID =
      Number((station && station.solarSystemID) || fallbackSystemID || 0) || null;
    if (!solarSystemID) {
      return null;
    }

    return {
      stationID: locationID,
      structureID: null,
      solarSystemID,
    };
  }

  const structure = structureState.getStructureByID(locationID, {
    refresh: false,
  });
  if (structure) {
    const solarSystemID =
      Number((structure && structure.solarSystemID) || fallbackSystemID || 0) ||
      null;
    if (!solarSystemID) {
      return null;
    }

    return {
      stationID: null,
      structureID: locationID,
      solarSystemID,
    };
  }

  return null;
}

function resolveLiveShipSpaceState(session, activeShip, fallbackSystemID) {
  const shipID =
    Number(
      (session && session._space && session._space.shipID) ||
      (activeShip && activeShip.itemID) ||
      0,
    ) || 0;
  const liveSpaceState = shipID
    ? spaceRuntime.getEntitySpaceStateSnapshot(session, shipID)
    : null;
  if (liveSpaceState && hasLocationID(liveSpaceState.systemID || fallbackSystemID)) {
    return {
      ...liveSpaceState,
      systemID: Number(liveSpaceState.systemID || fallbackSystemID),
    };
  }

  if (
    activeShip &&
    Number(activeShip.flagID || 0) === 0 &&
    hasLocationID(activeShip.locationID) &&
    hasLocationID(activeShip.spaceState && activeShip.spaceState.systemID)
  ) {
    return {
      ...activeShip.spaceState,
      systemID: Number(activeShip.spaceState.systemID || fallbackSystemID),
    };
  }

  return null;
}

function isActiveAbyssalLogoff(session, activeShip) {
  const sessionSceneKind = String(
    session && session._space && session._space.sceneKind || "",
  ).trim();
  const sessionSceneKey = String(
    session && session._space && session._space.sceneKey ||
      session && session.spaceSceneKey ||
      "",
  ).trim();
  const locationID = Number(
    session && session._space && session._space.systemID ||
      activeShip && activeShip.locationID ||
      activeShip && activeShip.spaceState && activeShip.spaceState.systemID ||
      0,
  ) || 0;
  const hasAbyssalSceneAuthority = Boolean(
    sessionSceneKind === "abyssal" ||
    /^abyssal-run:\d+$/.test(sessionSceneKey) ||
    isAbyssalHostLocationID(locationID)
  );
  // Run registries are lifecycle hints, not location authority. A stale run
  // record must not disable normal K-space emergency warp; exact scene identity
  // or the reserved host location remains sufficient during shutdown/recovery.
  return hasAbyssalSceneAuthority;
}

function persistCharacterLogoffState(session) {
  if (!session || !session.characterID) {
    return {
      success: false,
      errorMsg: "SESSION_REQUIRED",
    };
  }

  const characterID = Number(session.characterID || 0);
  const sessionStationID = hasLocationID(session.stationID || session.stationid)
    ? Number(session.stationID || session.stationid)
    : null;
  const sessionStructureID = hasLocationID(session.structureID || session.structureid)
    ? Number(session.structureID || session.structureid)
    : null;
  const sessionSpaceSystemID = hasLocationID(
    session._space && session._space.systemID,
  )
    ? Number(session._space.systemID)
    : null;
  const sessionSolarSystemID = hasLocationID(session.solarsystemid)
    ? Number(session.solarsystemid)
    : hasLocationID(session.solarsystemid2)
      ? Number(session.solarsystemid2)
      : null;
  const dockedSolarSystemID = sessionStationID
    ? Number(
      (
        worldData.getStationByID(sessionStationID) || {}
      ).solarSystemID || sessionSolarSystemID || 0,
    ) || null
    : sessionStructureID
      ? Number(
        (
          structureState.getStructureByID(sessionStructureID, { refresh: false }) || {}
        ).solarSystemID || sessionSolarSystemID || 0,
      ) || null
      : null;
  const nextSolarSystemID =
    (sessionStationID || sessionStructureID)
      ? dockedSolarSystemID
      : sessionSpaceSystemID || sessionSolarSystemID || 30000142;
  const logoffDate = currentFileTime().toString();
  let persistedStationID = sessionStationID;
  let persistedStructureID = sessionStructureID;
  let persistedSolarSystemID = nextSolarSystemID;
  const sessionShipID = Number(
    session && session._space && session._space.shipID ||
      session && (session.shipID || session.shipid || session.activeShipID) ||
      0,
  ) || 0;
  // Disconnect persistence must observe the current row, not provision or
  // repair an active hull while deciding whether trustworthy coordinates
  // exist. A missing/null spaceState is intentionally left untouched.
  const activeShip = sessionShipID > 0
    ? findItemById(sessionShipID)
    : getActiveShipRecord(characterID);

  if (!persistedStationID && !persistedStructureID && activeShip) {
    const liveSpaceState = resolveLiveShipSpaceState(
      session,
      activeShip,
      persistedSolarSystemID,
    );
    if (liveSpaceState) {
      // Abyssal space has no player warp. Keep the server-authoritative pocket
      // position intact so a disconnect cannot synthesize a billion-metre
      // escape point or leave relog recovery to repair foreign coordinates.
      const persistedSpaceState = (
        shipSuppressesEmergencyWarp(characterID) ||
        isActiveAbyssalLogoff(session, activeShip)
      )
        ? liveSpaceState
        : buildEmergencyWarpLogoffState(liveSpaceState, {
            characterID,
            shipID: activeShip.itemID,
          }) || liveSpaceState;
      const moveResult = moveShipToSpace(
        activeShip.itemID,
        Number(persistedSpaceState.systemID || persistedSolarSystemID),
        persistedSpaceState,
      );
      if (!moveResult.success) {
        log.warn(
          `[SessionDisconnect] Failed to persist active ship ${activeShip.itemID} into space for char=${characterID}: ${moveResult.errorMsg}`,
        );
      } else {
        persistedStationID = null;
        persistedStructureID = null;
        persistedSolarSystemID = Number(
          persistedSpaceState.systemID || persistedSolarSystemID,
        );
      }
    } else {
      const dockedFallback = resolveDockedStateFromShip(
        activeShip,
        persistedSolarSystemID,
      );
      if (dockedFallback) {
        persistedStationID = dockedFallback.stationID;
        persistedStructureID = dockedFallback.structureID;
        persistedSolarSystemID = dockedFallback.solarSystemID;
        log.debug(
          persistedStructureID
            ? `[SessionDisconnect] Missing live space state for char=${characterID} ship=${activeShip.itemID}; preserving docked ship state at structure=${persistedStructureID} instead of synthesizing a space position.`
            : `[SessionDisconnect] Missing live space state for char=${characterID} ship=${activeShip.itemID}; preserving docked ship state at station=${persistedStationID} instead of synthesizing a space position.`,
        );
      } else {
        log.debug(
          `[SessionDisconnect] Missing live space state for char=${characterID} ship=${activeShip.itemID}; leaving persisted ship state unchanged to avoid inventing coordinates.`,
        );
      }
    }
  }

  const currentCharacter = peekCharacterRecord(characterID);
  const systemIdentity = resolveSystemIdentity(
    persistedSolarSystemID,
    currentCharacter || {},
  );
  const updateResult = currentCharacter
    ? writeCharacterRecord(characterID, {
        ...currentCharacter,
        stationID: persistedStationID,
        structureID: persistedStructureID,
        solarSystemID: persistedSolarSystemID,
        constellationID: systemIdentity.constellationID,
        regionID: systemIdentity.regionID,
        logoffDate,
      })
    : { success: false, errorMsg: "CHARACTER_NOT_FOUND" };

  if (!updateResult.success) {
    log.warn(
      `[SessionDisconnect] Failed to persist logoff state for char=${characterID}: ${updateResult.errorMsg}`,
    );
    return updateResult;
  }

  return updateResult;
}

function disconnectCharacterSession(session, options = {}) {
  if (!session) {
    return {
      success: false,
      errorMsg: "SESSION_REQUIRED",
    };
  }

  if (session._safeLogoff) require("../ship/safeLogoffRuntime").abort(session, { notify: false });
  const characterID = Number(session.characterID || session.charid || 0) || 0;
  const wasRetailControlSession = Boolean(
    characterID > 0 &&
    (
      (
        typeof sessionRegistry.isCharacterSessionIndexed === "function" &&
        sessionRegistry.isCharacterSessionIndexed(session, characterID)
      ) ||
      (
        typeof sessionRegistry.isRegisteredSession === "function" &&
        sessionRegistry.isRegisteredSession(session) &&
        sessionRegistry.resolveSessionCharacterID(session) === characterID
      )
    ),
  );
  const stationID = Number(session.stationid || session.stationID || 0);
  const structureID = Number(session.structureid || session.structureID || 0);

  const cleanupErrors = [];
  let abyssalDisconnectResult = null;
  const attemptCleanup = (label, callback) => {
    try {
      return callback();
    } catch (error) {
      cleanupErrors.push(label);
      log.warn(
        `[SessionDisconnect] ${label} failed for char=${characterID}: ${error.message}`,
      );
      return null;
    }
  };

  try {
    attemptCleanup("logoff persistence", () => persistCharacterLogoffState(session));
    // Checkpoint the daily login campaign so time played this session counts
    // toward the login milestone even when the client disconnects abruptly.
    attemptCleanup("login milestone checkpoint", () => {
      const MilestoneMgrService = require(path.join(
        __dirname,
        "../character/milestoneMgrService",
      ));
      if (typeof MilestoneMgrService.handleSessionDisconnected === "function") {
        MilestoneMgrService.handleSessionDisconnected(session);
      }
    });
    attemptCleanup("fleet cleanup", () => {
      const fleetRuntime = require(path.join(__dirname, "../fleets/fleetRuntime"));
      if (fleetRuntime && typeof fleetRuntime.handleSessionDisconnected === "function") {
        fleetRuntime.handleSessionDisconnected(session);
      }
    });
    attemptCleanup("guest-list departure", () => {
      if (stationID) {
        broadcastStationGuestLeft(session, stationID);
      } else if (structureID) {
        broadcastStructureGuestLeft(session, structureID);
      }
    });
    // Drop this observer's guest ledger so a future session reusing the object
    // starts from a clean GetGuests-seeded baseline.
    attemptCleanup("guest-ledger cleanup", () => forgetObserverGuestLedger(session));
    abyssalDisconnectResult = attemptCleanup("abyssal disconnect cleanup", () => {
      const AbyssalMgrService = require("../../abyssal").lifecycleHooks;
      if (
        AbyssalMgrService &&
        typeof AbyssalMgrService.handleSessionDisconnect === "function"
      ) {
        return AbyssalMgrService.handleSessionDisconnect(session, {
          lifecycleReason: String(options.lifecycleReason || "disconnect"),
        });
      }
      return null;
    });
    const candidateAbyssalPocket =
      abyssalDisconnectResult &&
      abyssalDisconnectResult.success === true &&
      abyssalDisconnectResult.pocketState &&
      Number(abyssalDisconnectResult.pocketState.instanceID || 0) > 0
        ? abyssalDisconnectResult.pocketState
        : null;
    const currentAbyssalShipID = Number(
      session && session._space && session._space.shipID ||
        session && (session.shipID || session.shipid || session.activeShipID) ||
        0,
    ) || 0;
    const activeAbyssalPocket = Boolean(
      candidateAbyssalPocket &&
      characterID > 0 &&
      currentAbyssalShipID > 0 &&
      Number(candidateAbyssalPocket.characterID || 0) === characterID &&
      Number(candidateAbyssalPocket.shipID || 0) === currentAbyssalShipID
    )
      ? candidateAbyssalPocket
      : null;
    attemptCleanup("space detach", () => spaceRuntime.detachSession(session, {
      broadcast: options.broadcast !== false,
      lifecycleReason: String(options.lifecycleReason || "disconnect"),
      attemptDroneBayRecovery: true,
      attemptFighterTubeRecovery: true,
      preserveBreacherApplicationBudget: true,
      // Ordinary logoff must not make an active Abyssal hull disappear. The
      // runtime validates this explicit run identity against the exact isolated
      // scene before retaining a headless combat owner for NPCs and the timer.
      preserveAbyssalOfflineShip: Boolean(activeAbyssalPocket),
      abyssalRunID: activeAbyssalPocket
        ? Number(activeAbyssalPocket.instanceID)
        : 0,
      abyssalCharacterID: activeAbyssalPocket ? characterID : 0,
      abyssalShipID: activeAbyssalPocket ? currentAbyssalShipID : 0,
    }));
    attemptCleanup("trade cleanup", () => abortTradesForSession(session));
    attemptCleanup("chat cleanup", () => chatHub.unregisterSession(session));
    attemptCleanup("XMPP cleanup", () => unregisterCharacterSession(session));
  } finally {
    // Presence/control teardown is the invariant of this function. Auxiliary
    // persistence, space, guest, fleet, trade, or chat cleanup must never leave
    // a character stuck as retail-controlled when one of those subsystems
    // throws during logout or a socket close.
    if (options.clearSession !== false) {
      const clearResult = attemptCleanup("character-session clear", () => (
        clearCharacterFromSession(session, {
          emitNotifications: false,
          controlTransition: options.controlTransition !== false,
          controlReason: String(options.lifecycleReason || "retail_disconnect"),
        })
      ));
      if (!clearResult || clearResult.success !== true) {
        sessionRegistry.deindexCharacterSession(session);
        session._characterControlDisconnected = true;
        if (wasRetailControlSession && options.controlTransition !== false) {
          attemptCleanup("character-control release", () => {
            const characterControlRuntime = require(path.join(
              __dirname,
              "../online/characterControlRuntime",
            ));
            characterControlRuntime.recordRetailSessionEnded(characterID, {
              session,
              reason: String(options.lifecycleReason || "retail_disconnect"),
            });
          });
        }
      }
    } else {
      sessionRegistry.deindexCharacterSession(session);
      session._characterControlDisconnected = true;
      if (wasRetailControlSession && options.controlTransition !== false) {
        attemptCleanup("character-control release", () => {
          const characterControlRuntime = require(path.join(
            __dirname,
            "../online/characterControlRuntime",
          ));
          characterControlRuntime.recordRetailSessionEnded(characterID, {
            session,
            reason: String(options.lifecycleReason || "retail_disconnect"),
          });
        });
      }
    }
  }

  return {
    success: true,
    cleanupErrors,
  };
}

module.exports = {
  persistCharacterLogoffState,
  disconnectCharacterSession,
};
