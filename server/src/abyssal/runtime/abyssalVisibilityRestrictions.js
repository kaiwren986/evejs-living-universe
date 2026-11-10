"use strict";
const { normalizeText, toInt, normalizeLowerText } = require("../domain/abyssalRuntimeValues");

function hasAbyssalAdministrativeRole(ports, session) {
  const {
    normalizeRoleValue,
    ROLEMASK_VIEW,
  } = ports;
  if (!session || typeof session !== "object") {
    return false;
  }

  const roleMask = normalizeRoleValue(
    session.accountRole ?? session.role ?? session.rolesAtAll,
    0n,
  );

  return (roleMask & ROLEMASK_VIEW) !== 0n;
}

function isAbyssalRestrictionBypassAllowed(ports, context = null) {
  const {
    ABYSSAL_INTERNAL_BYPASS,
  } = ports;
  const source =
    context && typeof context === "object"
      ? context
      : {};

  const session =
    source.session && typeof source.session === "object"
      ? source.session
      : null;

  return (
    source.capability === ABYSSAL_INTERNAL_BYPASS &&
    hasAbyssalAdministrativeRole(ports, session)
  );
}

function buildAbyssalVisibilityRestrictionEntry(ports,
  category,
  pocketState,
  defaults = {},
) {
  const {
    ABYSSAL_VISIBILITY_STATUS,
  } = ports;
  const activePocketState = pocketState && typeof pocketState === "object"
    ? pocketState
    : null;
  return {
    category: normalizeText(category, "").toLowerCase(),
    activeRun: Boolean(activePocketState),
    characterID: toInt(activePocketState && activePocketState.characterID, 0),
    shipID: toInt(activePocketState && activePocketState.shipID, 0),
    instanceID: toInt(activePocketState && activePocketState.instanceID, 0),
    blocked: defaults.blocked === true,
    supported: defaults.supported !== false,
    bypassed: defaults.bypassed === true,
    status: normalizeText(defaults.status, ABYSSAL_VISIBILITY_STATUS.NOT_IMPLEMENTED_IN_EVEJS),
    reason: normalizeText(defaults.reason, ABYSSAL_VISIBILITY_STATUS.NOT_IMPLEMENTED_IN_EVEJS),
    message: normalizeText(defaults.message, ""),
  };
}

function resolveAbyssalVisibilityRestrictionForSession(ports,
  session,
  category,
  options = {},
) {
  const {
    getSessionContext,
    isAbyssalHostLocationID,
    getActiveAbyssalRunForCharacterID,
    getActiveAbyssalRunForShipID,
    ABYSSAL_VISIBILITY_STATUS,
  } = ports;
  const normalizedCategory = normalizeText(category, "").toLowerCase();
  const sessionContext = getSessionContext(session);
  const sessionSceneKind = normalizeLowerText(
    session && session._space && session._space.sceneKind,
    "",
  );
  const sessionSceneKey = normalizeText(
    session && session._space && session._space.sceneKey ||
      session && session.spaceSceneKey,
    "",
  );
  const sceneKeyMatch = /^abyssal-run:(\d+)$/.exec(sessionSceneKey);
  const sceneInstanceID = sessionContext.instanceID > 0
    ? sessionContext.instanceID
    : toInt(sceneKeyMatch && sceneKeyMatch[1], 0);
  const sceneAuthorityPocketState =
    sessionSceneKind === "abyssal" ||
    sceneKeyMatch ||
    isAbyssalHostLocationID(sessionContext.systemID)
      ? {
          characterID: sessionContext.characterID,
          shipID: sessionContext.shipID,
          instanceID: sceneInstanceID,
        }
      : null;
  const pocketState =
    options.pocketState && typeof options.pocketState === "object"
      ? options.pocketState
      : getActiveAbyssalRunForCharacterID(sessionContext.characterID) ||
        getActiveAbyssalRunForShipID(sessionContext.shipID) ||
        sceneAuthorityPocketState ||
        null;

  if (!pocketState) {
    return buildAbyssalVisibilityRestrictionEntry(ports, normalizedCategory, null, {
      blocked: false,
      supported: true,
      status: ABYSSAL_VISIBILITY_STATUS.AVAILABLE,
      reason: ABYSSAL_VISIBILITY_STATUS.NO_ACTIVE_ABYSSAL_RUN,
    });
  }

  if (isAbyssalRestrictionBypassAllowed(ports, { session, options })) {
    return buildAbyssalVisibilityRestrictionEntry(ports, normalizedCategory, pocketState, {
      blocked: false,
      supported: true,
      bypassed: true,
      status: ABYSSAL_VISIBILITY_STATUS.AVAILABLE,
      reason: ABYSSAL_VISIBILITY_STATUS.RESTRICTION_BYPASSED,
    });
  }

  if (normalizedCategory === "dscan") {
    return buildAbyssalVisibilityRestrictionEntry(ports, normalizedCategory, pocketState, {
      blocked: true,
      supported: true,
      status: ABYSSAL_VISIBILITY_STATUS.DSCAN_BLOCKED,
      reason: ABYSSAL_VISIBILITY_STATUS.ACTIVE_ABYSSAL_RUN,
      message: "Directional scan is unavailable inside Abyssal Deadspace.",
    });
  }

  if (normalizedCategory === "probe" || normalizedCategory === "probe_scan") {
    return buildAbyssalVisibilityRestrictionEntry(ports, normalizedCategory, pocketState, {
      blocked: false,
      supported: true,
      status: ABYSSAL_VISIBILITY_STATUS.AVAILABLE,
      reason: ABYSSAL_VISIBILITY_STATUS.ACTIVE_ABYSSAL_RUN,
      message: "Core and combat probe scanning is available inside Abyssal Deadspace.",
    });
  }

  if (normalizedCategory === "system_scanner") {
    return buildAbyssalVisibilityRestrictionEntry(ports, normalizedCategory, pocketState, {
      blocked: true,
      supported: true,
      status: ABYSSAL_VISIBILITY_STATUS.SYSTEM_SCANNER_BLOCKED,
      reason: ABYSSAL_VISIBILITY_STATUS.ACTIVE_ABYSSAL_RUN,
      message: "The system scanner is unavailable inside Abyssal Deadspace.",
    });
  }

  if (normalizedCategory === "local") {
    return buildAbyssalVisibilityRestrictionEntry(ports, normalizedCategory, pocketState, {
      blocked: true,
      supported: true,
      status: ABYSSAL_VISIBILITY_STATUS.LOCAL_SUPPRESSED,
      reason: ABYSSAL_VISIBILITY_STATUS.ACTIVE_ABYSSAL_RUN,
      message: "Local chat is suppressed inside Abyssal Deadspace.",
    });
  }

  if (normalizedCategory === "map") {
    return buildAbyssalVisibilityRestrictionEntry(ports, normalizedCategory, pocketState, {
      blocked: true,
      supported: true,
      status: ABYSSAL_VISIBILITY_STATUS.MAP_BLOCKED,
      reason: ABYSSAL_VISIBILITY_STATUS.ACTIVE_ABYSSAL_RUN,
      message: "The map does not work inside Abyssal Deadspace.",
    });
  }

  return buildAbyssalVisibilityRestrictionEntry(ports, normalizedCategory, pocketState, {
    blocked: false,
    supported: false,
    status: ABYSSAL_VISIBILITY_STATUS.NOT_IMPLEMENTED_IN_EVEJS,
    reason: ABYSSAL_VISIBILITY_STATUS.NOT_IMPLEMENTED_IN_EVEJS,
  });
}

function buildAbyssalVisibilityRestrictionSummaryForSession(ports, session, options = {}) {
  const {
    getActivePocketStateForSession,
  } = ports;
  const pocketState =
    options.pocketState && typeof options.pocketState === "object"
      ? options.pocketState
      : getActivePocketStateForSession(session);
  return {
    dscan: resolveAbyssalVisibilityRestrictionForSession(ports, session, "dscan", {
      ...options,
      pocketState,
    }),
    probeScan: resolveAbyssalVisibilityRestrictionForSession(ports, session, "probe_scan", {
      ...options,
      pocketState,
    }),
    systemScanner: resolveAbyssalVisibilityRestrictionForSession(ports, session, "system_scanner", {
      ...options,
      pocketState,
    }),
    local: resolveAbyssalVisibilityRestrictionForSession(ports, session, "local", {
      ...options,
      pocketState,
    }),
    map: resolveAbyssalVisibilityRestrictionForSession(ports, session, "map", {
      ...options,
      pocketState,
    }),
  };
}

function createAbyssalVisibilityRestrictions(ports) {
  return {
    hasAbyssalAdministrativeRole: hasAbyssalAdministrativeRole.bind(null, ports),
    isAbyssalRestrictionBypassAllowed: isAbyssalRestrictionBypassAllowed.bind(null, ports),
    buildAbyssalVisibilityRestrictionEntry: buildAbyssalVisibilityRestrictionEntry.bind(null, ports),
    resolveAbyssalVisibilityRestrictionForSession: resolveAbyssalVisibilityRestrictionForSession.bind(null, ports),
    buildAbyssalVisibilityRestrictionSummaryForSession: buildAbyssalVisibilityRestrictionSummaryForSession.bind(null, ports),
  };
}

module.exports = { createAbyssalVisibilityRestrictions };
