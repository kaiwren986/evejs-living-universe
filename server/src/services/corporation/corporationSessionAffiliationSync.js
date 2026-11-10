"use strict";

const path = require("path");

const log = require(path.join(__dirname, "../../utils/logger"));

function normalizePositiveInteger(value, fallback = null) {
  const numericValue = Number(value);
  return Number.isInteger(numericValue) && numericValue > 0
    ? numericValue
    : fallback;
}

function resolveSessionCharacterID(session) {
  return normalizePositiveInteger(
    session && (session.characterID || session.charID || session.charid),
    0,
  ) || 0;
}

function resolveSessionAllianceID(session) {
  const canonicalAllianceID = normalizePositiveInteger(
    session && session.allianceID,
    null,
  );
  return canonicalAllianceID || normalizePositiveInteger(
    session && session.allianceid,
    null,
  );
}

function warnSyncFailure(scope, error, details = "") {
  const suffix = details ? ` ${details}` : "";
  try {
    log.warn(
      `[CorporationSessionAffiliationSync] ${scope} failed${suffix}: ` +
        `${error && error.message ? error.message : String(error)}`,
    );
  } catch (_error) {
    // ignored: logging must not turn a best-effort live sync into a persisted-state error.
  }
}

function loadDefaultSessionRegistry() {
  return require(path.join(__dirname, "../chat/sessionRegistry"));
}

function loadDefaultSpaceRuntime() {
  return require(path.join(__dirname, "../../space/runtime"));
}

function resolvePlayerShipEntity(spaceRuntime, scene, session) {
  if (!scene) {
    return null;
  }

  if (typeof scene.getShipEntityForSession === "function") {
    return scene.getShipEntityForSession(session);
  }

  const shipID = normalizePositiveInteger(
    session && session._space && session._space.shipID,
    normalizePositiveInteger(
      session && (session.shipID || session.shipid),
      0,
    ),
  );
  if (
    shipID > 0 &&
    spaceRuntime &&
    typeof spaceRuntime.getEntity === "function"
  ) {
    return spaceRuntime.getEntity(session, shipID);
  }
  return null;
}

/**
 * Best-effort propagation of an already-persisted corporation alliance change.
 *
 * The live session registry is snapshotted exactly once. Every matching retail
 * session is updated independently so duplicate logins retain their own old
 * value in the SessionChange notification. In-space slim-item changes are
 * collected per scene and broadcast once after every session has been visited.
 * Failures are deliberately contained here: persisted corporation/member state
 * remains authoritative even when a transport or scene is disappearing.
 */
function synchronizeCorporationSessionAffiliation(
  affectedCharacterIDs,
  nextAllianceID,
  options = {},
) {
  const affectedCharacterIDSet = new Set(
    (Array.isArray(affectedCharacterIDs) ? affectedCharacterIDs : [])
      .map((characterID) => normalizePositiveInteger(characterID, 0))
      .filter(Boolean),
  );
  const normalizedNextAllianceID = normalizePositiveInteger(
    nextAllianceID,
    null,
  );
  const result = {
    affectedCharacterCount: affectedCharacterIDSet.size,
    registryScanCount: 0,
    matchedSessionCount: 0,
    changedSessionCount: 0,
    changedEntityCount: 0,
    broadcastSceneCount: 0,
    errorCount: 0,
  };

  if (affectedCharacterIDSet.size === 0) {
    return result;
  }

  let sessionRegistry;
  try {
    sessionRegistry = options.sessionRegistry || loadDefaultSessionRegistry();
  } catch (error) {
    result.errorCount += 1;
    warnSyncFailure("session registry load", error);
    return result;
  }

  let sessions;
  try {
    result.registryScanCount += 1;
    sessions = typeof sessionRegistry.getSessions === "function"
      ? sessionRegistry.getSessions()
      : [];
  } catch (error) {
    result.errorCount += 1;
    warnSyncFailure("session registry scan", error);
    return result;
  }
  if (!Array.isArray(sessions)) {
    sessions = [];
  }

  let spaceRuntime = options.spaceRuntime;
  let spaceRuntimeLoadAttempted = spaceRuntime !== undefined;

  const changedEntitiesByScene = new Map();
  const seenSessions = new Set();

  for (const session of sessions) {
    if (!session || seenSessions.has(session)) {
      continue;
    }
    seenSessions.add(session);

    let characterID;
    try {
      characterID = resolveSessionCharacterID(session);
    } catch (error) {
      result.errorCount += 1;
      warnSyncFailure("session identity", error);
      continue;
    }
    if (!affectedCharacterIDSet.has(characterID)) {
      continue;
    }
    result.matchedSessionCount += 1;

    let previousAllianceID = null;
    let sessionStateUpdated = false;
    try {
      previousAllianceID = resolveSessionAllianceID(session);
      session.allianceID = normalizedNextAllianceID;
      session.allianceid = normalizedNextAllianceID;
      sessionStateUpdated = true;
    } catch (error) {
      result.errorCount += 1;
      warnSyncFailure("session state update", error, `characterID=${characterID}`);
    }

    if (
      sessionStateUpdated &&
      previousAllianceID !== normalizedNextAllianceID
    ) {
      try {
        if (typeof session.sendSessionChange === "function") {
          session.sendSessionChange({
            allianceid: [previousAllianceID, normalizedNextAllianceID],
          });
          result.changedSessionCount += 1;
        }
      } catch (error) {
        result.errorCount += 1;
        warnSyncFailure("session change", error, `characterID=${characterID}`);
      }
    }

    try {
      // Do not initialize the large space runtime merely because an offline or
      // docked corporation member changed alliance during startup seeding.
      if (
        !spaceRuntimeLoadAttempted &&
        session._space &&
        typeof session._space === "object"
      ) {
        spaceRuntimeLoadAttempted = true;
        try {
          spaceRuntime = loadDefaultSpaceRuntime();
        } catch (error) {
          result.errorCount += 1;
          warnSyncFailure("space runtime load", error);
          spaceRuntime = null;
        }
      }

      if (!spaceRuntime || typeof spaceRuntime.getSceneForSession !== "function") {
        continue;
      }

      const scene = spaceRuntime.getSceneForSession(session);
      const entity = resolvePlayerShipEntity(spaceRuntime, scene, session);
      if (!entity || entity.kind !== "ship") {
        continue;
      }

      const nextEntityAllianceID = normalizedNextAllianceID || 0;
      if (
        normalizePositiveInteger(entity.allianceID, null) ===
        normalizedNextAllianceID
      ) {
        continue;
      }

      entity.allianceID = nextEntityAllianceID;
      let changedEntities = changedEntitiesByScene.get(scene);
      if (!changedEntities) {
        changedEntities = new Set();
        changedEntitiesByScene.set(scene, changedEntities);
      }
      changedEntities.add(entity);
      result.changedEntityCount += 1;
    } catch (error) {
      result.errorCount += 1;
      warnSyncFailure("space entity sync", error, `characterID=${characterID}`);
    }
  }

  for (const [scene, changedEntities] of changedEntitiesByScene) {
    try {
      if (typeof scene.broadcastSlimItemChanges !== "function") {
        continue;
      }
      scene.broadcastSlimItemChanges([...changedEntities]);
      result.broadcastSceneCount += 1;
    } catch (error) {
      result.errorCount += 1;
      warnSyncFailure("scene slim-item broadcast", error);
    }
  }

  return result;
}

module.exports = {
  synchronizeCorporationSessionAffiliation,
  _testing: {
    normalizePositiveInteger,
    resolveSessionAllianceID,
    resolveSessionCharacterID,
    resolvePlayerShipEntity,
  },
};
