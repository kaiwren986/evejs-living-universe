"use strict";

// Shared primitives for "is this action blocked because the pilot is in an
// Abyssal run?".
//
// space/runtime.js carries four such policies - cloak, cynosural, warp and
// teleport. Three of them (cyno, warp, teleport) had a byte-for-byte identical
// core: resolve the character, resolve the ship, look up an active run for
// either, and block if a run OR a scene authority is present. Only the error
// message and the exact shipID precedence differed. That core lives here now.
//
// Cloak is deliberately NOT built on this. It asks boolean questions
// (isCharacterInActiveAbyssalRun / isShipInActiveAbyssalRun) and returns on the
// first hit rather than resolving a pocket state, so it reports no instanceID.
// Folding it in would change what it returns.
//
// PURITY: this module takes abyssalMgrService as an argument and imports nothing
// from services/ or space/runtime. That is what keeps it out of the dependency
// cycle - see doc/abyssal/target-architecture.md.

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

// Sessions carry the character id under three spellings depending on how far
// through login they are. Teleport additionally falls back to the entity.
function resolveRestrictionCharacterID(session, entity = null, { entityFallback = false } = {}) {
  return toInt(
    session && (session.characterID || session.charID || session.charid),
    entityFallback ? toInt(entity && entity.characterID, 0) : 0,
  );
}

// Ship id precedence differs by policy:
//   preferEntity true  - the acting entity wins (cyno, teleport: the module or
//                        ship being acted on is authoritative)
//   preferEntity false - session state only (warp: there is no entity argument)
// In both cases session._space.shipID beats the flat session aliases, because
// the in-space record is the live one.
function resolveRestrictionShipID(session, entity = null, { preferEntity = false } = {}) {
  const sessionShipID = toInt(
    session && session._space && session._space.shipID,
    toInt(session && (session.shipID || session.shipid || session.activeShipID), 0),
  );
  return preferEntity ? toInt(entity && entity.itemID, sessionShipID) : sessionShipID;
}

function isBypassAllowed(abyssalMgrService, session, restriction) {
  return Boolean(
    abyssalMgrService &&
      typeof abyssalMgrService.isAbyssalRestrictionBypassAllowed === "function" &&
      abyssalMgrService.isAbyssalRestrictionBypassAllowed({ session, restriction }),
  );
}

// Character run wins over ship run - a pilot's own run is more authoritative
// than whatever the hull was last associated with. Returns null when neither.
function resolveActiveRunPocketState(abyssalMgrService, characterID, shipID) {
  if (!abyssalMgrService) {
    return null;
  }
  const activeRun =
    characterID > 0 &&
    typeof abyssalMgrService.getActiveAbyssalRunForCharacterID === "function"
      ? abyssalMgrService.getActiveAbyssalRunForCharacterID(characterID)
      : null;
  if (activeRun) {
    return activeRun;
  }
  return shipID > 0 &&
    typeof abyssalMgrService.getActiveAbyssalRunForShipID === "function"
    ? abyssalMgrService.getActiveAbyssalRunForShipID(shipID)
    : null;
}

// Returns null (not blocked) unless a run or a scene authority is present.
// A run outranks a scene authority when reporting the instance and reason.
function buildRunRestriction({
  characterID,
  shipID,
  pocketState,
  sceneAuthority,
  errorMsg,
}) {
  if (!pocketState && !sceneAuthority) {
    return null;
  }
  return {
    blocked: true,
    characterID,
    shipID,
    instanceID: pocketState
      ? toInt(pocketState.instanceID, 0)
      : toInt(sceneAuthority && sceneAuthority.instanceID, 0),
    reason: pocketState ? "ABYSSAL_ACTIVE_RUN" : "ABYSSAL_SCENE_AUTHORITY",
    errorMsg,
  };
}

// The whole cyno/warp/teleport shape in one call. Callers supply the pieces that
// genuinely differ; everything else is shared.
function resolveAbyssalRunActivationRestriction({
  abyssalMgrService,
  session,
  entity = null,
  sceneAuthority = null,
  restriction,
  errorMsg,
  preferEntityShipID = false,
  characterEntityFallback = false,
}) {
  if (isBypassAllowed(abyssalMgrService, session, restriction)) {
    return null;
  }
  const characterID = resolveRestrictionCharacterID(session, entity, {
    entityFallback: characterEntityFallback,
  });
  const shipID = resolveRestrictionShipID(session, entity, {
    preferEntity: preferEntityShipID,
  });
  const pocketState = resolveActiveRunPocketState(abyssalMgrService, characterID, shipID);
  return buildRunRestriction({
    characterID,
    shipID,
    pocketState,
    sceneAuthority,
    errorMsg,
  });
}

module.exports = {
  resolveRestrictionCharacterID,
  resolveRestrictionShipID,
  isBypassAllowed,
  resolveActiveRunPocketState,
  buildRunRestriction,
  resolveAbyssalRunActivationRestriction,
};
