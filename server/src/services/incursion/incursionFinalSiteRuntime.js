"use strict";
const incursionClock = require("./incursionClock");

// The dungeon owner commits the physical final site before lifecycle binding
// advertises it. Recovery uses one stable key and never creates a second scene.
const lifecycle = require("./incursionLifecycle");
const slots = require("./incursionFinalSiteSlots");
const admission = require("./incursionSiteAdmission");
const dungeon = require("../dungeon/dungeonRuntime");
const { fingerprint } = require("./incursionLifecycleContract");
const identity = (tale, boss = tale.boss) => ({ placement: "tale-final", taleID: tale.taleID, poolGroupID: tale.poolGroupID,
  generation: tale.generation, slotID: "final", slotOperationID: boss.operationID, incarnation: 0,
  solarSystemID: boss.solarSystemID, securityBand: tale.placement.securityBand });
const siteKey = boss => `incursion-final:${boss.operationID}`;
function assertInstance(instance, tale, boss = tale.boss) {
  if (!instance || instance.templateID !== admission.templateID(boss.dungeonID) || instance.sourceDungeonID !== boss.dungeonID ||
      instance.siteKey !== siteKey(boss) || instance.solarSystemID !== boss.solarSystemID || instance.instanceScope !== "shared" ||
      fingerprint(instance.metadata?.incursionAdmission) !== fingerprint(identity(tale, boss)) ||
      fingerprint(instance.position) !== fingerprint(boss.position) || !admission.admittedPolicy(instance)) {
    throw new Error("INCURSION_FINAL_INSTANCE_SCOPE_MISMATCH");
  }
}
function ensureInstance(tale, boss = tale.boss, nowMs = incursionClock.now()) {
  const scope = identity(tale, boss);
  lifecycle.finalAdmission({ ...scope, instanceID: boss.instanceID }, nowMs);
  let instance = dungeon.findInstanceBySiteKey(siteKey(boss), { full: true });
  if (!instance) {
    if (boss.instanceID) throw new Error("INCURSION_FINAL_INSTANCE_MISSING");
    const templateID = admission.templateID(boss.dungeonID);
    const template = require("../dungeon/dungeonAuthority").getTemplateByID(templateID);
    if (!admission.isTemplate(template) || template.sourceDungeonID !== boss.dungeonID) throw new Error("INCURSION_FINAL_CONTENT_UNAVAILABLE");
    const label = template.populationHints.incursionPolicy.name, siteID = 6800000000000 + dungeon.peekNextInstanceID();
    instance = dungeon.createInstance({ templateID, solarSystemID: boss.solarSystemID, siteKey: siteKey(boss),
      lifecycleState: "active", instanceScope: "shared", siteFamily: template.siteFamily, siteKind: template.siteKind,
      siteOrigin: "sansha_incursion", position: boss.position, nowMs, durable: true, expiresAtMs: 0,
      spawnState: { siteID, label, entryObjectTypeID: template.entryObjectTypeID },
      runtimeFlags: { universeSeeded: true, universePersistent: false, lazyMaterialized: true, incursionRuntime: true },
      metadata: { providerID: "incursionFinalSite", siteID, label, incursionAdmission: scope } });
  }
  assertInstance(instance, tale, boss);
  lifecycle.bindFinalInstance({ ...scope, instanceID: instance.instanceID }, instance.instanceID, instance.metadata.siteID, nowMs);
  return instance;
}
function acceptCompletion(instance, operation, nowMs = incursionClock.now()) {
  if (instance?.metadata?.incursionAdmission?.placement !== "tale-final" || !operation?.receiptID) return false;
  if (fingerprint(admission.operationIdentity(instance)) !== fingerprint(operation.identity)) throw new Error("INCURSION_FINAL_COMPLETION_SCOPE_MISMATCH");
  const result = lifecycle.acceptFinalCompletion(operation.receiptID, nowMs);
  if (result.applied) require("./incursionProjectionRuntime").reconcile();
  return result;
}
function reconcile({ nowMs = incursionClock.now() } = {}) {
  let created = 0, recovered = 0, blocked = 0;
  for (const tale of lifecycle.listTales().filter(slots.enabled)) {
    if (tale.policy.testOnly && process.env.EVEJS_TEST_STORE_ISOLATED !== "1") continue;
    if (!slots.live(tale, nowMs)) {
      if (nowMs < tale.createdAtMs) continue;
      lifecycle.closeFinalSite(tale.taleID, nowMs);
      const boss = lifecycle.getTale(tale.taleID).boss;
      const instance = boss.instanceID ? dungeon.getInstance(boss.instanceID) : dungeon.findInstanceBySiteKey(siteKey(boss), { full: true });
      if (instance) assertInstance(instance, tale, boss);
      if (instance && ["active", "seeded", "paused"].includes(instance.lifecycleState)) dungeon.setLifecycleState(instance.instanceID,
        tale.terminal?.outcome === "defeated" ? "completed" : "despawned", { nowMs, durable: true,
          lifecycleReason: "incursion-final-admission-closed", ...(tale.terminal?.outcome === "defeated" ? { completedAtMs: tale.terminal.causeAtMs } : {}) });
      continue;
    }
    const boss = tale.boss;
    if (boss.state === "active") {
      const instance = dungeon.getInstance(boss.instanceID);
      if (!instance) { blocked++; continue; }
      assertInstance(instance, tale, boss);
      let operation = require("./incursionRewardStore").getOperation(admission.operationIdentity(instance).operationID);
      operation = require("./incursionEncounterRuntime").reconcilePending(instance, operation);
      if (operation?.receiptID) { acceptCompletion(instance, operation, nowMs); recovered++; }
    } else if (boss.state === "reserved" && boss.dueAtMs <= nowMs) {
      try { ensureInstance(tale, boss, nowMs); created++; }
      catch (error) {
        lifecycle.retryFinalInstance(identity(tale, boss), error.message, nowMs); blocked++;
        require("../../utils/logger").warn(`[Incursion] Final site ${boss.operationID} pending: ${error.message}`);
      }
    }
  }
  return { created, recovered, blocked };
}
module.exports = { identity, siteKey, assertInstance, ensureInstance, acceptCompletion, reconcile };
