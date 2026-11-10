"use strict";

// Inventory owns the actual HP/capacitor transition and its durable outbox;
// the career ledger is a retryable consumer, never the authority for an effect.
const items = require("./itemStore");
const ledger = require("../career/careerEventLedger");
const characters = require("../character/characterState");
const database = require("../../gameStore");
const EWAR = Object.freeze({ stasisWebifier: "web", targetPainter: "paint",
  warpDisruptor: "warp-disrupt", warpScrambler: "warp-scramble", trackingDisruptor: "weapon-disrupt" });
function actor(entity) {
  return Number(entity?.characterID || entity?.pilotCharacterID || entity?.session?.characterID || entity?.session?.charid) || 0;
}
function identity(source, target, state, effect, atMs, suffix = "") {
  return `module:${source.itemID}:${state.moduleID}:${state.startedAtMs}:${target.itemID}:${effect}:${Math.trunc(atMs)}${suffix}`;
}
function eligible(source, target, state, playerTarget = false) {
  const characterID = actor(source), other = actor(target);
  if (!characterID || source?.kind !== "ship" || target?.kind !== "ship" || source === target ||
      source.destroyed || target.destroyed || Number(source.itemID) === Number(target.itemID) ||
      other === characterID || !characters.getCharacterRecord(characterID) ||
      playerTarget && (!other || !characters.getCharacterRecord(other))) return false;
  if (source.nativeNpc === true || source.nativeNpcOccupied === true ||
      playerTarget && (target.nativeNpc === true || target.nativeNpcOccupied === true)) return false;
  const ship = items.findShipItemById(source.itemID), module = items.findItemById(state?.moduleID);
  return Boolean(ship && ship.ownerID === characterID && module && module.ownerID === characterID &&
    module.locationID === Number(source.itemID) && module.moduleState?.online === true &&
    ((module.flagID >= 11 && module.flagID <= 34) || (module.flagID >= 92 && module.flagID <= 99)) &&
    !database.isTransientPath("characters", `/${characterID}`) &&
    !database.isTransientPath("items", `/${source.itemID}`) &&
    !database.isTransientPath("items", `/${module.itemID}`) &&
    (!playerTarget || items.findShipItemById(target.itemID)?.ownerID === other &&
      !database.isTransientPath("characters", `/${other}`) &&
      !database.isTransientPath("items", `/${target.itemID}`)));
}
function settle(characterID, event, options = {}) {
  const recorded = ledger.record(characterID, event, { publish: false, nowMs: event.atMs });
  if (!recorded?.success) return recorded;
  const acknowledged = items.acknowledgeCareerCombatOutcome(characterID, event.id);
  if (!acknowledged?.success) return acknowledged;
  if (options.publish !== false && recorded.changed) ledger.publishCommitted(characterID);
  return { success: true };
}
function reconcile(characterID) {
  if (database.isTransientPath("characters", `/${Number(characterID)}`)) return { success: true, skipped: true };
  // A prior accepted cycle may still be awaiting its first durable fence.
  // Fence the owner before reading outbox rows or publishing any progress.
  const fence = items.flushCareerCombatOutcomes();
  if (!fence?.success) return fence;
  const pending = items.listPendingCareerCombatOutcomes(characterID);
  if (!pending?.success) return pending;
  for (const receipt of pending.data) {
    const result = settle(characterID, receipt.event, { publish: false });
    if (!result?.success) return result;
  }
  return { success: true };
}
function begin(source, target, state, effect, atMs, playerTarget = false) {
  if (!eligible(source, target, state, playerTarget)) return null;
  const characterID = actor(source), eventID = identity(source, target, state, effect, atMs);
  const previous = items.getCareerCombatOutcome(characterID, eventID);
  if (previous) {
    const fence = items.flushCareerCombatOutcomes();
    if (fence?.success && !previous.acknowledged) settle(characterID, previous.event);
  }
  if (!previous && ledger.isSaturated(characterID, `effect:${effect}`)) return null;
  return { characterID, eventID, duplicate: Boolean(previous) };
}
function commit(context, effect, amount, atMs, changedEntities = [], durationMs = null) {
  if (!context) return { success: true, handled: false };
  if (context.duplicate) return { success: true, handled: true, duplicate: true };
  if (durationMs === null ? Math.floor(amount * 1000 + 1e-7) < 1 : Math.trunc(durationMs) < 1)
    return { success: true, handled: false };
  const event = { kind: "combat-effect", id: context.eventID, effect, atMs: Math.max(1, Math.trunc(atMs)),
    ...(durationMs === null ? { amount } : { durationMs: Math.trunc(durationMs) }) };
  const conditionUpdates = changedEntities.filter(entity => items.findShipItemById(entity.itemID) &&
    !database.isTransientPath("items", `/${entity.itemID}`))
    .map(entity => ({ itemID: Number(entity.itemID), conditionState: entity.conditionState }));
  const result = items.commitCareerCombatOutcome({ characterID: context.characterID, event, conditionUpdates });
  if (result?.errorMsg === "COMBAT_OUTCOME_CAPACITY") {
    require("../../utils/logger").warn("[Career] Combat outcome capacity reached; ordinary effect persistence continues");
    return { success: true, handled: false };
  }
  if (!result?.success) return result;
  if (result.durable) settle(context.characterID, event);
  return { success: true, handled: true, sealedItemIDs: conditionUpdates.map(change => change.itemID),
    pending: result.durable !== true };
}
function startEwar(source, target, state, record, effective) {
  const effect = EWAR[state?.hostileFamily];
  if (!effect || !effective || !eligible(source, target, state, true) ||
      ledger.isSaturated(actor(source), `effect:${effect}`)) {
    delete state.careerEwarSpan;
    return;
  }
  state.careerEwarSpan = { atMs: Math.trunc(record.startedAtMs), expiresAtMs: Math.trunc(record.expiresAtMs),
    targetID: Number(target.itemID), effect };
}
function measureEwar(scene, source, target, state, nowMs, valid = true) {
  const span = state?.careerEwarSpan, effect = span?.effect;
  if (!span || !effect) return { success: true };
  if (ledger.isSaturated(actor(source), `effect:${effect}`)) {
    delete state.careerEwarSpan; return { success: true };
  }
  const endMs = Math.min(Math.trunc(nowMs), span.expiresAtMs);
  const previous = span.atMs;
  // Dropping the unobserved gap is deliberate: absence, lock loss or restart
  // cannot manufacture elapsed player-on-player effect time.
  if (!valid || !source?.session || source.session.socket?.destroyed || !eligible(source, target, state, true) ||
      scene?.getEntityByID(target.itemID) !== target || target.destroyed || source.destroyed) {
    delete state.careerEwarSpan;
    return { success: true };
  }
  if (endMs <= previous) return { success: true };
  const context = { characterID: actor(source),
    eventID: identity(source, target, state, effect, endMs, `:${previous}`) };
  const result = commit(context, effect, 0, endMs, [], endMs - previous);
  if (result?.success) span.atMs = endMs;
  return result;
}
module.exports = { begin, commit, reconcile, startEwar, measureEwar };
