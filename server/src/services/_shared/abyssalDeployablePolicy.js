"use strict";

const path = require("path");

const {
  resolveAbyssalPlayerLaunchScope,
} = require(path.join(__dirname, "./abyssalPlayerLaunchScope"));
const {
  resolveEntityInteractionScope,
} = require(path.join(
  __dirname,
  "../../space/destiny/identity/interactionScope",
));
const {
  isAbyssalHostLocationID,
} = require("../../abyssal").engineSupport.hostLocation;

function toPositiveInt(value) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
}

function sourceClaimsAbyssalScene(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return false;
  }
  const sceneKey = String(source.sceneKey || "").trim().toLowerCase();
  return Boolean(
    String(source.sceneKind || "").trim().toLowerCase() === "abyssal" ||
      String(source.instanceScope || "").trim().toLowerCase() === "abyssal" ||
      sceneKey.startsWith("abyssal")
  );
}

function getSceneSources(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return [];
  }
  const sources = [source];
  if (
    source.sceneDescriptor &&
    typeof source.sceneDescriptor === "object" &&
    !Array.isArray(source.sceneDescriptor)
  ) {
    sources.push(source.sceneDescriptor);
  }
  if (
    source.spaceState &&
    typeof source.spaceState === "object" &&
    !Array.isArray(source.spaceState)
  ) {
    sources.push(source.spaceState);
    if (
      source.spaceState.sceneDescriptor &&
      typeof source.spaceState.sceneDescriptor === "object" &&
      !Array.isArray(source.spaceState.sceneDescriptor)
    ) {
      sources.push(source.spaceState.sceneDescriptor);
    }
  }
  return sources;
}

function isManagerDeployableBypassAllowed(session) {
  try {
    const service = require("../../abyssal").activationPolicy;
    return Boolean(
      service &&
        typeof service.isAbyssalRestrictionBypassAllowed === "function" &&
        service.isAbyssalRestrictionBypassAllowed({
          session,
          restriction: "deployable_deployment",
        })
    );
  } catch (_) {
    // ignored: no Abyssal service here means no bypass: the restriction stays on
    return false;
  }
}

function resolveAbyssalDeployableLaunchRestriction(
  session,
  context = {},
  options = {},
) {
  const controllerEntity = options.controllerEntity || null;
  const scene = options.scene || null;
  const launchScope = resolveAbyssalPlayerLaunchScope(
    session,
    controllerEntity,
    scene,
  );
  const locationCandidates = [
    context.systemID,
    session && session._space && session._space.systemID,
    session && session.solarsystemid2,
    session && session.solarsystemid,
  ];
  const reservedHostAuthority = locationCandidates.some((locationID) =>
    isAbyssalHostLocationID(locationID));
  const sessionSceneAuthority = [
    session && session._space,
    session && session._space && session._space.sceneDescriptor,
    session && {
      sceneKind: session.spaceSceneKind,
      sceneKey: session.spaceSceneKey,
      instanceID: session.spaceInstanceID,
    },
  ].some(sourceClaimsAbyssalScene);
  const legacySessionAuthority = Boolean(
    session &&
      (
        session._abyssal ||
        session.abyssal ||
        session.abyssalPocketID ||
        session.abyssalInstanceID ||
        session.abyssalTraceID
      )
  );
  const authorityPresent = Boolean(
    reservedHostAuthority ||
      sessionSceneAuthority ||
      legacySessionAuthority ||
      launchScope.scoped === true
  );
  if (!authorityPresent || isManagerDeployableBypassAllowed(session)) {
    return null;
  }

  return {
    blocked: true,
    characterID: toPositiveInt(
      session && (session.characterID || session.charID || session.charid),
    ),
    shipID: toPositiveInt(
      context.shipID ||
        (session && session._space && session._space.shipID) ||
        (session && (session.shipID || session.shipid || session.activeShipID)),
    ),
    runID: launchScope.valid === true ? launchScope.runID : null,
    roomIndex: launchScope.valid === true ? launchScope.roomIndex : null,
    invalidAuthority: Boolean(
      launchScope.scoped === true && launchScope.valid !== true
    ),
    reason: reservedHostAuthority
      ? "ABYSSAL_RESERVED_HOST"
      : legacySessionAuthority
        ? "ABYSSAL_LEGACY_SESSION_AUTHORITY"
        : launchScope.valid === true
          ? "ABYSSAL_SCOPED_CONTROLLER"
          : "ABYSSAL_AUTHORITY_INVALID",
  };
}

function resolveAbyssalDeployableItemRestriction(item, state = {}) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return null;
  }
  const scope = resolveEntityInteractionScope(item);
  const reservedHostAuthority = [
    item.locationID,
    item.systemID,
    item.spaceState && item.spaceState.systemID,
    state && state.solarSystemID,
  ].some((locationID) => isAbyssalHostLocationID(locationID));
  const sceneAuthority = getSceneSources(item).some(sourceClaimsAbyssalScene);
  const scopeAuthority = Boolean(
    scope.hasAbyssalScope || scope.hasAbyssalRoomScope
  );
  if (!reservedHostAuthority && !sceneAuthority && !scopeAuthority) {
    return null;
  }
  return {
    blocked: true,
    invalidAuthority: Boolean(scopeAuthority && scope.valid !== true),
    reason: reservedHostAuthority
      ? "ABYSSAL_RESERVED_HOST"
      : scope.valid === true
        ? "ABYSSAL_SCOPED_ITEM"
        : "ABYSSAL_AUTHORITY_INVALID",
  };
}

// Lazy — space/runtime requires deployable runtimes back, so a top-level require
// would close a cycle.
function getSpaceRuntime() {
  return require(path.join(__dirname, "../../space/runtime"));
}

// Launch-time restriction check that also consults the live scene and the
// controlling entity. This was copied byte-for-byte into mobileAnalysisBeaconRuntime,
// mobileObservatoryRuntime, and deployableCynoRuntime; it lives here now so the
// three deployables that need the scene-aware variant share one implementation.
function resolveDeployableAbyssalRestriction(session, context = {}) {
  const sessionRestriction = resolveAbyssalDeployableLaunchRestriction(
    session,
    context,
  );
  if (sessionRestriction) {
    return sessionRestriction;
  }
  const runtime = getSpaceRuntime();
  const scene =
    session && typeof runtime.getSceneForSession === "function"
      ? runtime.getSceneForSession(session)
      : null;
  const controllerEntity =
    session && context.shipID && typeof runtime.getEntity === "function"
      ? runtime.getEntity(session, context.shipID)
      : null;
  return resolveAbyssalDeployableLaunchRestriction(
    session,
    context,
    { controllerEntity, scene },
  );
}

module.exports = {
  resolveAbyssalDeployableItemRestriction,
  resolveAbyssalDeployableLaunchRestriction,
  resolveDeployableAbyssalRestriction,
  sourceClaimsAbyssalScene,
};
