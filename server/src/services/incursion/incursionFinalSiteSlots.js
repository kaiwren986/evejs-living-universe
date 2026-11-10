"use strict";

// The final-site reservation shares the lifecycle table with the HQ completion
// that authorizes it. Dungeon materialization happens only after this commit.
const { SITES, fingerprint, projectInfluence, fail } = require("./incursionLifecycleContract");
const VERSION = "evejs.incursion-final-sites.v1";
const positive = value => Number.isSafeInteger(value) && value > 0;
const clone = value => structuredClone(value);
const enabled = tale => tale?.policy?.boss?.version === VERSION && tale.policy.boss.automaticUnlock === true;
const live = (tale, nowMs) => enabled(tale) && !tale.terminal && nowMs >= tale.createdAtMs && nowMs < tale.expiresAtMs &&
  (!tale.policy.testOnly || process.env.EVEJS_TEST_STORE_ISOLATED === "1");
const fullControl = (tale, atMs) => projectInfluence(tale.influence, atMs) >= 1 - 1e-9;
function initialize(tale) {
  if (!enabled(tale)) return;
  const placement = tale.placement.finalSite, dungeonID = tale.policy.boss.securityDungeonBindings[tale.placement.securityBand];
  const minimumAgeMs = tale.policy.boss.minimumAgeMs[tale.placement.securityBand];
  if (!placement || !SITES.some(row => row.dungeonID === dungeonID && row.role === "boss") ||
      !Number.isSafeInteger(minimumAgeMs) || minimumAgeMs < 0 || !positive(tale.createdAtMs + minimumAgeMs)) {
    fail("INCURSION_FINAL_SITE_PROFILE_INVALID");
  }
  tale.boss = { ...tale.boss, state: "locked", sequence: 0, operationID: `sansha:${tale.taleID}:g${tale.generation}:final:0`,
    dungeonID, solarSystemID: placement.solarSystemID, position: clone(placement.position), minimumAgeMs,
    available: false, instanceID: null, siteID: null, dueAtMs: null, ageBoundaryApplied: false,
    unlockedAtMs: null, hqCompletion: null, history: [], reason: "awaiting-age-control-and-hq-completion" };
}
function reserveIfEligible(tale, atMs) {
  const boss = tale.boss;
  if (!live(tale, atMs) || boss.state !== "locked" || !boss.hqCompletion ||
      boss.hqCompletion.generation !== tale.generation || atMs < tale.createdAtMs + boss.minimumAgeMs || !fullControl(tale, atMs)) return false;
  boss.state = "reserved"; boss.sequence++; boss.dueAtMs = atMs; boss.unlockedAtMs = atMs;
  boss.ageBoundaryApplied = true; boss.reason = "approved-final-site-reserved";
  boss.history.push({ event: "reserved", atMs, operationID: boss.operationID, receiptID: boss.hqCompletion.receiptID });
  tale.work[boss.operationID] = { operationID: boss.operationID, kind: "final-site-materialization", atMs,
    status: "pending", payload: clone(boss) };
  return true;
}
function noteCompletion(tale, receipt, atMs) {
  if (!live(tale, atMs)) return false;
  const id = receipt.identity, native = SITES.find(row => row.dungeonID === id.dungeonID);
  if (!tale.boss.hqCompletion && native?.role === "headquarters" && id.rewardID === native.rewardGroupID &&
      id.generation === tale.generation && id.taleID === tale.taleID && id.poolGroupID === tale.poolGroupID && tale.influence.value >= 1 - 1e-9) {
    tale.boss.hqCompletion = { receiptID: receipt.id, generation: tale.generation,
      completedAtMs: receipt.completedAtMs, acceptedAtMs: atMs, dungeonID: native.dungeonID, controlAfter: tale.influence.value };
  }
  return reserveIfEligible(tale, atMs);
}
function boundary(tale) {
  if (!enabled(tale) || tale.terminal || ["active", "closed"].includes(tale.boss.state)) return null;
  const boss = tale.boss;
  const dueAtMs = boss.state === "reserved" ? boss.dueAtMs
    : !boss.ageBoundaryApplied ? tale.createdAtMs + boss.minimumAgeMs : null;
  if (!positive(dueAtMs) || dueAtMs >= tale.expiresAtMs) return null;
  return { taleID: tale.taleID, generation: tale.generation, revision: boss.sequence, kind: "final", dueAtMs,
    slotID: "final", incarnation: 0, operationID: boss.operationID };
}
function closeInPlace(tale, atMs) {
  if (!enabled(tale) || tale.boss.state === "closed") return false;
  const boss = tale.boss;
  boss.state = "closed"; boss.available = false; boss.sequence++;
  boss.history.push({ event: "closed", atMs, operationID: boss.operationID });
  if (tale.work[boss.operationID]?.status === "pending") tale.work[boss.operationID].status = "superseded";
  return true;
}
function createFinalSiteSlots({ store, changed, validateTale, appendTransition, now }) {
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
  function scopeMatches(tale, identity) {
    const boss = tale.boss;
    return identity?.placement === "tale-final" && identity.taleID === tale.taleID && identity.slotID === "final" && identity.incarnation === 0 &&
      identity.generation === tale.generation && identity.poolGroupID === tale.poolGroupID &&
      identity.slotOperationID === boss.operationID && identity.solarSystemID === boss.solarSystemID &&
      identity.securityBand === tale.placement.securityBand &&
      (identity.dungeonID === undefined || identity.dungeonID === boss.dungeonID) &&
      (!boss.instanceID || identity.instanceID === boss.instanceID);
  }
  function admission(identity, atMs = now()) {
    if (!positive(atMs)) fail("INCURSION_CLOCK_INVALID");
    const tale = store.read().tales[identity?.taleID];
    if (!tale) fail("INCURSION_FINAL_ADMISSION_REQUIRED");
    validateTale(tale);
    if (!live(tale, atMs) || !["reserved", "active"].includes(tale.boss.state) || !scopeMatches(tale, identity) ||
        atMs < tale.boss.dueAtMs || tale.placement.systems.find(row => row.solarSystemID === tale.boss.solarSystemID)?.sceneType !== 1 ||
        !tale.policy.encounters.some(row => row.dungeonID === tale.boss.dungeonID && row.materialize === true && row.capability === "incursion-sites-v2")) {
      fail("INCURSION_FINAL_ADMISSION_REQUIRED");
    }
    return { tale: clone(tale), boss: clone(tale.boss) };
  }
  function bind(identity, instanceID, siteID, atMs = now()) {
    admission(identity, atMs);
    return mutate(identity.taleID, tale => {
      const boss = tale.boss;
      if (!positive(instanceID) || !positive(siteID) || (boss.instanceID && (boss.instanceID !== instanceID || boss.siteID !== siteID)) ||
          (identity.instanceID !== undefined && identity.instanceID !== instanceID)) {
        fail("INCURSION_FINAL_BINDING_CONFLICT");
      }
      if (boss.state === "active") return { changed: false };
      boss.instanceID = instanceID; boss.siteID = siteID; boss.state = "active"; boss.available = true; boss.sequence++;
      delete boss.lastError;
      boss.history.push({ event: "bound", atMs, operationID: boss.operationID, instanceID, siteID });
      tale.work[boss.operationID].status = "applied";
      appendTransition(tale, "final-site-bound", atMs);
      return { changed: true };
    });
  }
  function retry(identity, reason, atMs = now()) {
    if (!positive(atMs)) fail("INCURSION_CLOCK_INVALID");
    return mutate(identity.taleID, tale => {
      if (!live(tale, atMs) || tale.boss.state !== "reserved" || !scopeMatches(tale, identity)) return { changed: false };
      tale.boss.sequence++; tale.boss.dueAtMs = atMs + tale.policy.sites.retryDelayMs;
      tale.boss.lastError = String(reason);
      return { changed: true };
    });
  }
  function advance(request, atMs = now()) {
    if (!positive(atMs)) fail("INCURSION_CLOCK_INVALID");
    return mutate(request?.taleID, tale => {
      const expected = boundary(tale);
      if (!expected || fingerprint(expected) !== fingerprint(request)) return { applied: false, reason: "stale" };
      if (atMs < expected.dueAtMs) return { applied: false, reason: "early" };
      if (!live(tale, atMs)) return { applied: false, reason: "expired" };
      const changed = tale.boss.state === "locked";
      if (changed) {
        tale.boss.ageBoundaryApplied = true; tale.boss.sequence++;
        if (reserveIfEligible(tale, atMs)) appendTransition(tale, "final-site-unlocked", atMs);
      }
      return { changed, applied: true, taleID: tale.taleID, kind: "final" };
    });
  }
  function close(taleID, atMs = now()) {
    if (!positive(atMs)) fail("INCURSION_CLOCK_INVALID");
    return mutate(taleID, tale => {
      if (!enabled(tale) || live(tale, atMs) || atMs < tale.createdAtMs) return { changed: false };
      const changed = closeInPlace(tale, atMs);
      if (changed) appendTransition(tale, "final-site-closed", atMs);
      return { changed };
    });
  }
  return { admission, bind, retry, advance, close, boundary };
}
module.exports = { VERSION, enabled, live, initialize, noteCompletion, boundary, closeInPlace, createFinalSiteSlots };
