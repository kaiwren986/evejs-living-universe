"use strict";

// Slot decisions and influence receipts share the lifecycle owner's atomic
// table. The dungeon and reward owners supply independent durable facts.
const { SITES, fingerprint, fail, projectInfluence } = require("./incursionLifecycleContract");
const VERSION = "evejs.incursion-shared-sites.v1";
const positive = value => Number.isSafeInteger(value) && value > 0;
const enabled = tale => tale?.policy?.sites?.enabled === true && tale.policy.sites.version === VERSION;
const live = (tale, nowMs) => enabled(tale) && !tale.terminal && nowMs >= tale.createdAtMs && nowMs < tale.expiresAtMs &&
  (!tale.policy.testOnly || process.env.EVEJS_TEST_STORE_ISOLATED === "1");
const clone = value => structuredClone(value);
function definition(tale, slot) {
  if (tale.policy.sites?.contentVersion !== 2) return slot.dungeonID === 5166
    ? { dungeonID: 5166, rewardGroupID: 1, capability: "incursion-vanguard-v1", sceneType: 3 } : null;
  const native = SITES.find(row => row.dungeonID === slot.dungeonID && row.role !== "boss");
  return native ? { ...native, capability: native.dungeonID === 5166 ? "incursion-vanguard-v1" : "incursion-sites-v2",
    sceneType: { scout: 4, vanguard: 3, assault: 2, headquarters: 1 }[native.role] } : null;
}
function intent(tale, slot, atMs) {
  tale.work[slot.operationID] = { operationID: slot.operationID, kind: "site-materialization", atMs,
    status: "pending", payload: clone(slot) };
}
function initialize(tale) {
  if (!enabled(tale)) return;
  if (!tale.policy.sites.securityBands.includes(tale.placement.securityBand) ||
      tale.siteSlots.length > tale.policy.sites.maxSlots) fail("INCURSION_SITE_PROFILE_CAPACITY");
  tale.siteCompletions = {};
  for (const slot of tale.siteSlots) {
    slot.state = "reserved"; slot.sequence = 0; slot.dueAtMs = tale.createdAtMs; slot.history = [];
    slot.anchor = clone(slot.position);
    intent(tale, slot, tale.createdAtMs);
  }
}
function boundary(tale, slot) {
  if (!enabled(tale) || tale.terminal || !["reserved", "waiting"].includes(slot.state) || slot.dueAtMs >= tale.expiresAtMs) return null;
  return { taleID: tale.taleID, generation: tale.generation, revision: slot.sequence,
    kind: "site", slotID: slot.slotID, incarnation: slot.incarnation, dueAtMs: slot.dueAtMs };
}
function readCompletion(receiptID) {
  const rewards = require("./incursionRewardStore"), receipt = rewards.read(`/receipts/${receiptID}`);
  const operation = receipt && rewards.getOperation(receipt.identity.operationID);
  if (!receipt || !operation || operation.status !== "completed" || operation.receiptID !== receiptID ||
      fingerprint(operation.identity) !== fingerprint(receipt.identity) || operation.policyFingerprint !== receipt.policyFingerprint ||
      operation.completion?.completedAtMs !== receipt.completedAtMs) fail("INCURSION_SITE_COMPLETION_UNPROVEN");
  return receipt;
}
function readFailure(operationID) {
  const operation = require("./incursionRewardStore").getOperation(operationID);
  const instance = operation && require("../dungeon/dungeonRuntime").getPersistedInstance(operation.identity.instanceID);
  if (!operation || !instance || instance.lifecycleState !== "failed" || operation.receiptID ||
      instance.timers?.failedAtMs !== operation.failure?.atMs) fail("INCURSION_SITE_FAILURE_UNPROVEN");
  require("./incursionStructures").verifyFailure(instance, operation);
  const flushed = require("../../gameStore").flushTablesSync(["npcEntities", "npcRuntimeControllers", "npcModules", "npcCargo"]);
  if (!flushed?.success) fail(flushed?.errorMsg || "INCURSION_SITE_FAILURE_CLEANUP_PENDING");
  if (require("../../space/npc/nativeNpcStore").listNativeEntitiesForSystem(instance.solarSystemID)
    .some(row => row.incursionOperationID === operationID)) fail("INCURSION_SITE_FAILURE_CLEANUP_PENDING");
  return operation;
}
function createSiteSlots({ store, changed, validateTale, appendTransition, now, resolveCompletion = readCompletion }) {
  function mutate(taleID, reducer) {
    const result = store.mutate(state => {
      const tale = state.tales[taleID];
      if (!tale) fail("INCURSION_TALE_MISSING");
      validateTale(tale);
      return reducer(tale);
    });
    if (result?.changed) changed();
    return result;
  }
  function admission(identity, atMs = now()) {
    if (!positive(atMs)) fail("INCURSION_CLOCK_INVALID");
    const tale = store.read().tales[identity?.taleID];
    if (!tale) fail("INCURSION_SITE_ADMISSION_REQUIRED");
    validateTale(tale);
    const slot = tale.siteSlots.find(row => row.slotID === identity.slotID);
    const approved = slot && definition(tale, slot);
    if (!live(tale, atMs) || !slot || !["reserved", "active"].includes(slot.state) || (slot.state === "reserved" && atMs < slot.dueAtMs) ||
        identity.generation !== tale.generation || identity.incarnation !== slot.incarnation ||
        identity.slotOperationID !== slot.operationID || identity.poolGroupID !== tale.poolGroupID ||
        identity.securityBand !== tale.placement.securityBand || identity.solarSystemID !== slot.solarSystemID ||
        (slot.instanceID && identity.instanceID !== slot.instanceID) ||
        !approved || (tale.policy.sites.contentVersion === 2 && (identity.placement !== "tale-slot" || identity.taleID !== tale.taleID ||
          (identity.dungeonID !== undefined && identity.dungeonID !== slot.dungeonID))) ||
        !tale.policy.encounters.some(row => row.dungeonID === slot.dungeonID && row.materialize === true && row.capability === approved.capability) ||
        tale.placement.systems.find(row => row.solarSystemID === slot.solarSystemID)?.sceneType !== approved.sceneType) fail("INCURSION_SITE_ADMISSION_REQUIRED");
    return { tale: clone(tale), slot: clone(slot) };
  }
  function bind(identity, instanceID, siteID, atMs = now()) {
    admission(identity, atMs);
    return mutate(identity.taleID, tale => {
      const slot = tale.siteSlots.find(row => row.slotID === identity.slotID);
      if (!positive(instanceID) || !positive(siteID) || (slot.instanceID && (slot.instanceID !== instanceID || slot.siteID !== siteID)) ||
          (tale.policy.sites.contentVersion === 2 && identity.instanceID !== undefined && identity.instanceID !== instanceID)) fail("INCURSION_SITE_BINDING_CONFLICT");
      if (slot.state === "active") return { changed: false };
      slot.instanceID = instanceID; slot.siteID = siteID; slot.state = "active"; slot.sequence++;
      delete slot.lastError;
      slot.history.push({ event: "bound", atMs, operationID: slot.operationID, incarnation: slot.incarnation, instanceID, siteID });
      tale.work[slot.operationID].status = "applied";
      // Native Agency caches its beacon children. Invalidate with a coherent
      // same-influence notice after a newly bound site, including respawns.
      appendTransition(tale, "site-bound", atMs);
      return { changed: true };
    });
  }
  function retry(identity, reason, atMs = now()) {
    if (!positive(atMs)) fail("INCURSION_CLOCK_INVALID");
    return mutate(identity.taleID, tale => {
      const slot = tale.siteSlots.find(row => row.slotID === identity.slotID);
      if (!live(tale, atMs) || !slot || slot.operationID !== identity.slotOperationID || slot.state !== "reserved") return { changed: false };
      if (tale.policy.sites.contentVersion === 2 && (identity.placement !== "tale-slot" || identity.taleID !== tale.taleID ||
          identity.generation !== tale.generation || identity.poolGroupID !== tale.poolGroupID ||
          identity.incarnation !== slot.incarnation || identity.solarSystemID !== slot.solarSystemID || identity.securityBand !== tale.placement.securityBand ||
          (identity.dungeonID !== undefined && identity.dungeonID !== slot.dungeonID))) return { changed: false };
      slot.sequence++; slot.dueAtMs = atMs + tale.policy.sites.retryDelayMs; slot.lastError = String(reason);
      return { changed: true };
    });
  }
  function advance(request, atMs = now()) {
    return mutate(request.taleID, tale => {
      const slot = tale.siteSlots.find(row => row.slotID === request.slotID), expected = slot && boundary(tale, slot);
      if (!expected || fingerprint(expected) !== fingerprint(request)) return { applied: false, reason: "stale" };
      if (atMs < expected.dueAtMs) return { applied: false, reason: "early" };
      if (!live(tale, atMs)) return { applied: false, reason: "expired" };
      if (slot.state === "waiting") {
        slot.incarnation++; slot.operationID = `sansha:${tale.taleID}:g${tale.generation}:slot:${slot.slotID}:${slot.incarnation}`;
        slot.position = { ...slot.anchor, x: slot.anchor.x + slot.incarnation * tale.policy.sites.replacementOffsetMeters };
        if (!Number.isFinite(slot.position.x)) fail("INCURSION_SITE_POSITION_INVALID");
        slot.instanceID = null; slot.siteID = null; slot.state = "reserved";
        intent(tale, slot, expected.dueAtMs);
      }
      slot.sequence++; slot.dueAtMs = atMs; delete slot.lastError;
      return { changed: true, applied: true, taleID: tale.taleID, kind: "site" };
    });
  }
  function complete(receiptID, atMs = now()) {
    if (!positive(atMs)) fail("INCURSION_CLOCK_INVALID");
    const receipt = resolveCompletion(receiptID), identity = receipt.identity;
    // Economic delivery legitimately mutates participant leg states/results.
    // The accepted seal's immutable identity is the completion proof.
    const proof = fingerprint([receipt.id, receipt.requestFingerprint, receipt.identity,
      receipt.policyFingerprint, receipt.completedAtMs]);
    return mutate(identity.taleID, tale => {
      const previous = tale.siteCompletions?.[receiptID];
      if (previous) {
        if (previous.proof !== proof) fail("INCURSION_SITE_COMPLETION_CONFLICT");
        return { changed: false, applied: previous.applied, duplicate: true };
      }
      const slot = tale.siteSlots.find(row => row.slotID === identity.slotID);
      const approved = slot && definition(tale, slot);
      if (!enabled(tale) || identity.placement !== "tale-slot" || identity.generation !== tale.generation ||
          identity.poolGroupID !== tale.poolGroupID || !slot || !["active", "closed"].includes(slot.state) || slot.instanceID !== identity.instanceID ||
          slot.operationID !== identity.slotOperationID || slot.incarnation !== identity.incarnation ||
          identity.solarSystemID !== slot.solarSystemID || !approved || identity.rewardID !== approved.rewardGroupID ||
          (tale.policy.sites.contentVersion === 2 && (approved.dungeonID !== 5166 || identity.dungeonID !== undefined) && identity.dungeonID !== slot.dungeonID) ||
          identity.securityBand !== tale.placement.securityBand || !positive(receipt.completedAtMs) || receipt.completedAtMs < tale.createdAtMs ||
          receipt.completedAtMs > atMs) fail("INCURSION_SITE_COMPLETION_SCOPE_MISMATCH");
      const accepted = live(tale, atMs) && receipt.completedAtMs < tale.expiresAtMs;
      const clock = Math.max(tale.influence.lastUpdatedAtMs, receipt.completedAtMs);
      const before = projectInfluence(tale.influence, clock);
      tale.siteCompletions[receiptID] = { receiptID, proof, slotID: slot.slotID, incarnation: slot.incarnation,
        instanceID: slot.instanceID, completedAtMs: receipt.completedAtMs, applied: accepted,
        reason: accepted ? "accepted" : "terminal-cutoff", influenceBefore: before,
        delta: accepted ? tale.policy.sites.influencePerCompletion : 0, identity: clone(identity),
        position: clone(slot.position), siteID: slot.siteID, retirementAcknowledged: false };
      if (tale.policy.sites.contentVersion === 2) tale.siteCompletions[receiptID].dungeonID = slot.dungeonID;
      tale.work[`site-retirement:${receiptID}`] = { operationID: `site-retirement:${receiptID}`, kind: "site-retirement",
        atMs: receipt.completedAtMs, status: "pending", payload: { receiptID, instanceID: slot.instanceID } };
      slot.history.push({ event: "completed", operationID: slot.operationID, incarnation: slot.incarnation,
        instanceID: slot.instanceID, receiptID, atMs: receipt.completedAtMs });
      slot.state = accepted ? "waiting" : "closed"; slot.sequence++;
      slot.dueAtMs = receipt.completedAtMs + tale.policy.sites.respawnDelayMs;
      if (accepted) {
        tale.influence = { ...tale.influence, value: Math.min(1, before + tale.policy.sites.influencePerCompletion), lastUpdatedAtMs: clock };
        require("./incursionFinalSiteSlots").noteCompletion(tale, receipt, atMs);
        appendTransition(tale, "site-completed", clock);
      }
      return { changed: true, applied: accepted };
    });
  }
  function close(taleID, atMs = now()) {
    if (!positive(atMs)) fail("INCURSION_CLOCK_INVALID");
    return mutate(taleID, tale => {
      if (!enabled(tale) || live(tale, atMs)) return { changed: false };
      let count = 0;
      for (const slot of tale.siteSlots) {
        if (slot.state === "closed") continue;
        slot.state = "closed"; slot.sequence++; count++;
        if (tale.work[slot.operationID]?.status === "pending") tale.work[slot.operationID].status = "superseded";
      }
      return { changed: count > 0 };
    });
  }
  function failed(operationID, atMs = now()) {
    if (!positive(atMs)) fail("INCURSION_CLOCK_INVALID");
    let operation = require("./incursionRewardStore").getOperation(operationID);
    if (!operation || operation.status !== "retired" || operation.receiptID || operation.identity.operationID !== operationID ||
        operation.policyFingerprint !== fingerprint(operation.policy) || operation.failure?.version !== 1 ||
        operation.failure.kind !== "premature-terminal-death") fail("INCURSION_SITE_FAILURE_UNPROVEN");
    // Once accepted, the lifecycle proof survives ordinary dungeon purge.
    // A duplicate checks that immutable proof below instead of requiring the
    // retired physical journal to remain forever. First acceptance still
    // requires independent durable HP and the fenced actor cleanup.
    const known = store.read().tales[operation.identity.taleID]?.siteFailures?.[operationID];
    if (!known) operation = readFailure(operationID);
    const identity = operation.identity;
    const proof = fingerprint({ identity, policyFingerprint: operation.policyFingerprint, failure: operation.failure });
    return mutate(identity.taleID, tale => {
      const prior = tale.siteFailures?.[operationID];
      if (prior) {
        if (prior.proof !== proof) fail("INCURSION_SITE_FAILURE_CONFLICT");
        return { changed: false, applied: prior.applied, duplicate: true };
      }
      const slot = tale.siteSlots.find(row => row.slotID === identity.slotID);
      if (!enabled(tale) || tale.policy.sites.contentVersion !== 2 || identity.placement !== "tale-slot" ||
          identity.generation !== tale.generation || identity.poolGroupID !== tale.poolGroupID ||
          identity.securityBand !== tale.placement.securityBand || !slot || !["active", "closed"].includes(slot.state) ||
          slot.dungeonID !== 5175 || identity.dungeonID !== slot.dungeonID || identity.rewardID !== 3 ||
          slot.instanceID !== identity.instanceID || slot.operationID !== identity.slotOperationID ||
          slot.incarnation !== identity.incarnation || slot.solarSystemID !== identity.solarSystemID ||
          operation.failure.atMs < tale.createdAtMs || operation.failure.atMs > atMs) fail("INCURSION_SITE_FAILURE_SCOPE_MISMATCH");
      const accepted = live(tale, atMs) && operation.failure.atMs < tale.expiresAtMs;
      tale.siteFailures ||= {};
      tale.siteFailures[operationID] = { proof, identity: clone(identity), failure: clone(operation.failure),
        applied: accepted, position: clone(slot.position), siteID: slot.siteID };
      slot.history.push({ event: "failed", operationID: slot.operationID, incarnation: slot.incarnation,
        instanceID: slot.instanceID, atMs: operation.failure.atMs });
      slot.state = accepted ? "waiting" : "closed"; slot.sequence++;
      slot.dueAtMs = operation.failure.atMs + tale.policy.sites.respawnDelayMs;
      // The existing replacement deadline and position policy also apply to
      // a physically failed site. Failure never advances influence or LP.
      if (accepted) appendTransition(tale, "site-failed", atMs);
      return { changed: true, applied: accepted };
    });
  }
  function acknowledgeRetirement(taleID, receiptID) {
    return mutate(taleID, tale => {
      const completion = tale.siteCompletions?.[receiptID];
      if (!completion) fail("INCURSION_SITE_COMPLETION_UNPROVEN");
      if (completion.retirementAcknowledged) return { changed: false };
      completion.retirementAcknowledged = true;
      tale.work[`site-retirement:${receiptID}`].status = "applied";
      return { changed: true };
    });
  }
  return { admission, bind, retry, advance, complete, failed, close, acknowledgeRetirement,
    boundaries: tale => tale.siteSlots.map(slot => boundary(tale, slot)).filter(Boolean) };
}
module.exports = { VERSION, enabled, live, initialize, readCompletion, createSiteSlots, definition };
