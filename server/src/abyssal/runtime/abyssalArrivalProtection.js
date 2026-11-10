"use strict";

// Entering the Abyss and each room change are jumps on Tranquility: the client
// runs them as the JumpToAbyss and abyssToAbyssJump session changes
// (movementFunctions.RealActivateAbyssalGate). Both get the standard jump
// protection, one minute, ended by moving or using a module, as after a
// stargate jump.
const ABYSSAL_ENTRY_PROTECTION_MS = 60_000;
const ABYSSAL_ROOM_PROTECTION_MS = 60_000;

// Call only after committing the participant's destination scope, before
// destination combat is activated. Keep the receipt after expiry/cancellation
// so retrying the same arrival cannot restart its protection.
function grantAbyssalArrivalProtection(pocketState, session, entity, deps, options = {}) {
  const runID = Number(pocketState && pocketState.instanceID) || 0;
  const roomIndex = Number(options.roomIndex) || 0;
  const characterID = Number(session && (session.characterID || session.charid)) || 0;
  const shipID = Number(entity && entity.itemID) || 0;
  if (!runID || !roomIndex || !characterID || !shipID) {
    return { success: false, errorMsg: "ABYSSAL_ARRIVAL_PROTECTION_IDENTITY_MISSING" };
  }
  const kind = options.entry === true ? "abyssal-entry" : "abyssal-room";
  const idempotencyKey = `${kind}:${runID}:${roomIndex}:${characterID}:${shipID}`;
  if (entity.evejsAbyssalArrivalProtectionKey === idempotencyKey) {
    return { success: true, duplicate: true };
  }
  if (!deps || typeof deps.grantTimedInvulnerabilityForSession !== "function") {
    return { success: false, errorMsg: "ABYSSAL_ARRIVAL_PROTECTION_UNAVAILABLE" };
  }
  const result = deps.grantTimedInvulnerabilityForSession(session, {
    entity, shipID, characterID, runID, kind, idempotencyKey,
    durationMs: options.entry === true ? ABYSSAL_ENTRY_PROTECTION_MS : ABYSSAL_ROOM_PROTECTION_MS,
  });
  if (result && result.success === true) {
    entity.evejsAbyssalArrivalProtectionKey = idempotencyKey;
    return result;
  }
  return result || { success: false, errorMsg: "ABYSSAL_ARRIVAL_PROTECTION_GRANT_FAILED" };
}

module.exports = {
  ABYSSAL_ENTRY_PROTECTION_MS,
  ABYSSAL_ROOM_PROTECTION_MS,
  grantAbyssalArrivalProtection,
};
