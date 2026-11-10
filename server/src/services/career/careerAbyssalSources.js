"use strict";

// Private run evidence is consumed before the Abyssal owner purges a run.
// NPC attribution never enters the public killmail or solar-system namespace.
const database = require("../../gameStore");
const ledger = require("./careerEventLedger");
const { resolveItemByTypeID } = require("../inventory/itemTypeRegistry");
const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : 0;
const ENTERED = new Set(["active", "disconnected", "exited", "destroyed", "evacuated"]);
function readRuns(characterID = 0) {
  const result = database.readPersistedAbyssalInstances(characterID);
  if (!result?.success) throw new Error(result?.errorMsg || "CAREER_ABYSSAL_READ_FAILED");
  return result.data || {};
}
function runFrom(instance) {
  const run = instance?.environmentState?.abyssalRuntimeState?.pocketState;
  return instance?.siteFamily === "abyssal" && instance?.siteKind === "abyssal-pocket" &&
    positive(instance.instanceID) && positive(run?.instanceID) === positive(instance.instanceID) ? run : null;
}
function tierOf(run) {
  let value = run?.tier ?? run?.contentProfile?.tier;
  const profile = run?.contentProfile;
  if (profile && Object.hasOwn(profile, "abyssalContentProfileReferenceSchemaVersion")) {
    // The owner deliberately saves a compact versioned reference, without
    // tier. Reuse its strict identity/generation resolver instead of guessing
    // from the filament name or bootstrapping a live pocket runtime.
    let resolved;
    try { resolved = require("../../abyssal").transport.AbyssalContentManagerService
      .resolvePersistedFilamentDefinition(profile); }
    catch (_) { return -1; }
    if (!resolved?.success || value !== undefined &&
        (typeof value !== "number" || value !== resolved.definition?.tier)) return -1;
    value = resolved.definition?.tier;
  }
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 6 ? value : -1;
}
function rosterOf(run) { return Array.isArray(run?.participantRoster) ? run.participantRoster : []; }
function stageNpcOutcome(run, event, nowMs) {
  if (event?.careerConfirmedCombat !== true || !positive(event.itemID || event.npcID) ||
      !positive(event.careerFinalCharacterID) || !positive(event.careerFinalShipTypeID)) return {};
  const participant = rosterOf(run).find(row => positive(row.characterID) === positive(event.careerFinalCharacterID) &&
    row.status === "active" && positive(row.shipTypeID) === positive(event.careerFinalShipTypeID));
  const type = resolveItemByTypeID(positive(event.careerVictimTypeID || event.typeID));
  if (!participant || Number(type?.categoryID) !== 11) return {};
  const itemID = positive(event.itemID || event.npcID), previous = run.careerCombatOutcomes || {};
  if (previous[itemID]) return {};
  return { careerCombatOutcomes: { ...previous, [itemID]: {
    itemID, roomIndex: positive(event.roomIndex || event.abyssalRoomIndex),
    characterID: positive(event.careerFinalCharacterID), shipTypeID: positive(event.careerFinalShipTypeID),
    victimTypeID: positive(event.careerVictimTypeID || event.typeID),
    victimFactionID: positive(event.careerVictimFactionID),
    completedAtMs: positive(Math.trunc(Number(nowMs))) || Date.now(),
  } } };
}
function reconcileRunValue(run, characterID = 0, options = {}) {
  const tier = tierOf(run);
  if (!positive(run?.instanceID) || tier < 0) return { success: true, skipped: true };
  const selected = rosterOf(run).filter(row => !characterID || positive(row.characterID) === positive(characterID));
  const changed = new Set(), commitOptions = { ...options, publish: false };
  for (const participant of selected) {
    const id = positive(participant.characterID);
    if (!id || !positive(participant.admittedAtMs) || !ENTERED.has(participant.status)) continue;
    if (tier === 0) {
      const entry = ledger.record(id, { kind: "abyssal", action: "entry", tier,
        id: `run:${run.instanceID}:entry:${id}` }, { ...commitOptions, nowMs: positive(participant.admittedAtMs) });
      if (!entry.success) return entry;
      if (entry.changed) changed.add(id);
      if (run.runOutcome === "exited" && participant.status === "exited" && positive(participant.exitedAtMs)) {
        const completed = ledger.record(id, { kind: "abyssal", action: "completion", tier,
          id: `run:${run.instanceID}:completion:${id}` }, { ...commitOptions, nowMs: positive(participant.exitedAtMs) });
        if (!completed.success) return completed;
        if (completed.changed) changed.add(id);
      }
    }
  }
  for (const outcome of Object.values(run.careerCombatOutcomes || {})) {
    const id = positive(outcome?.characterID);
    if (!id || characterID && id !== positive(characterID) || !positive(outcome.itemID) ||
        !positive(outcome.completedAtMs) || !rosterOf(run).some(row => positive(row.characterID) === id &&
          positive(row.shipTypeID) === positive(outcome.shipTypeID))) continue;
    const victim = resolveItemByTypeID(positive(outcome.victimTypeID));
    const attacker = resolveItemByTypeID(positive(outcome.shipTypeID));
    if (Number(victim?.categoryID) !== 11 || Number(attacker?.categoryID) !== 6) continue;
    const base = { kind: "abyssal", tier, id: `run:${run.instanceID}:room:${outcome.roomIndex}:npc:${outcome.itemID}` };
    const total = ledger.record(id, { ...base, id: `${base.id}:total`, action: "npc-kill" },
      { ...commitOptions, nowMs: outcome.completedAtMs });
    if (!total.success) return total;
    if (total.changed) changed.add(id);
    if ([25, 420, 26].includes(Number(attacker.groupID))) {
      const killed = ledger.record(id, { ...base, action: "npc-kill", attackerGroupID: Number(attacker.groupID) },
        { ...commitOptions, nowMs: outcome.completedAtMs });
      if (!killed.success) return killed;
      if (killed.changed) changed.add(id);
    }
    if (Number(outcome.victimFactionID) === 500026) {
      const killed = ledger.record(id, { ...base, id: `${base.id}:triglavian`, action: "triglavian-kill" },
        { ...commitOptions, nowMs: outcome.completedAtMs });
      if (!killed.success) return killed;
      if (killed.changed) changed.add(id);
    }
  }
  if (options.publish !== false) for (const id of changed) ledger.publishCommitted(id);
  return { success: true, changedCharacterIDs: [...changed] };
}
function reconcileRun(instanceID, options = {}) {
  const result = database.readPersisted("dungeonRuntimeState", `/instancesByID/${positive(instanceID)}`);
  if (!result?.success && result?.errorMsg !== "ENTRY_NOT_FOUND") {
    throw new Error(result?.errorMsg || "CAREER_ABYSSAL_READ_FAILED");
  }
  const run = runFrom(result?.success ? result.data : null);
  return run ? reconcileRunValue(run, 0, options) : { success: true, skipped: true };
}
function reconcile(characterID) {
  for (const instance of Object.values(readRuns(characterID))) {
    const run = runFrom(instance);
    if (!run) continue;
    const result = reconcileRunValue(run, positive(characterID), { publish: false });
    if (!result.success) return result;
  }
  return { success: true };
}
module.exports = { reconcileRun, reconcile, stageNpcOutcome };
