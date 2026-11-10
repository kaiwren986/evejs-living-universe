"use strict";
const incursionClock = require("./incursionClock");

const lifecycle = require("./incursionLifecycle");
const slots = require("./incursionSiteSlots");
const admission = require("./incursionAdmission");
const dungeon = require("../dungeon/dungeonRuntime");
const { fingerprint } = require("./incursionLifecycleContract");
const identity = (tale, slot) => ({ placement: "tale-slot", taleID: tale.taleID, poolGroupID: tale.poolGroupID,
  generation: tale.generation, slotID: slot.slotID, slotOperationID: slot.operationID, incarnation: slot.incarnation,
  solarSystemID: slot.solarSystemID, securityBand: tale.placement.securityBand });
const siteKey = slot => `incursion:${slot.operationID}`;
function templateID(tale, slot) {
  const dungeonID = slot.dungeonID ?? 5166;
  if (dungeonID === 5166) return admission.TEMPLATE_ID;
  if (tale.policy.sites?.contentVersion !== 2 || !slots.definition(tale, slot)) throw new Error("INCURSION_SITE_CONTENT_UNAVAILABLE");
  return require("./incursionSiteAdmission").templateID(dungeonID);
}
function approvedTemplate(template, slot) {
  return (slot.dungeonID ?? 5166) === 5166 ? admission.isSharedTemplate(template)
    : require("./incursionSiteAdmission").isTemplate(template) && template.sourceDungeonID === slot.dungeonID;
}
function assertInstance(instance, tale, slot) {
  const expected = identity(tale, slot);
  if (!instance || instance.templateID !== templateID(tale, slot) || instance.siteKey !== siteKey(slot) ||
      instance.solarSystemID !== slot.solarSystemID || instance.instanceScope !== "shared" ||
      fingerprint(instance.metadata?.incursionAdmission) !== fingerprint(expected) ||
      fingerprint(instance.position) !== fingerprint(slot.position) || !admission.admittedPolicy(instance)) {
    throw new Error("INCURSION_SITE_INSTANCE_SCOPE_MISMATCH");
  }
}
function ensureInstance(tale, slot, nowMs) {
  const scope = identity(tale, slot);
  let instance = dungeon.findInstanceBySiteKey(siteKey(slot), { full: true });
  if (reconcileAdministrativeWithdrawal(instance)) throw new Error("INCURSION_SITE_ADMINISTRATIVELY_WITHDRAWN");
  lifecycle.siteAdmission({ ...scope, instanceID: slot.instanceID }, nowMs);
  if (!instance) {
    if (slot.instanceID) throw new Error("INCURSION_SITE_INSTANCE_MISSING");
    const selectedTemplateID = templateID(tale, slot);
    const template = require("../dungeon/dungeonAuthority").getTemplateByID(selectedTemplateID);
    if (!approvedTemplate(template, slot)) throw new Error("INCURSION_SITE_CONTENT_UNAVAILABLE");
    const label = (slot.dungeonID ?? 5166) === 5166 ? "Nation Commander Outpost" : template.populationHints.incursionPolicy.name;
    const siteID = 6800000000000 + dungeon.peekNextInstanceID();
    instance = dungeon.createInstance({ templateID: selectedTemplateID, solarSystemID: slot.solarSystemID,
      siteKey: siteKey(slot), lifecycleState: "active", instanceScope: "shared", siteFamily: template.siteFamily,
      siteKind: template.siteKind, siteOrigin: "sansha_incursion", position: slot.position, nowMs, durable: true,
      expiresAtMs: 0, spawnState: { siteID, label, entryObjectTypeID: template.entryObjectTypeID },
      runtimeFlags: { universeSeeded: true, universePersistent: false, lazyMaterialized: true, incursionRuntime: true },
      metadata: { providerID: "incursionTaleSlots", siteID, label, incursionAdmission: scope } });
  }
  assertInstance(instance, tale, slot);
  lifecycle.bindSiteInstance({ ...scope, instanceID: instance.instanceID }, instance.instanceID, instance.metadata.siteID, nowMs);
  return instance;
}
function acceptCompletion(instance, operation, nowMs = incursionClock.now()) {
  if (instance?.metadata?.incursionAdmission?.placement !== "tale-slot" || !operation?.receiptID) return false;
  const result = lifecycle.acceptSiteCompletion(operation.receiptID, nowMs);
  // Only independently sealed health/reward evidence can advance the slot.
  // Administrative deletion/completed flags supply no such receipt.
  retireCompletions(lifecycle.getTale(operation.identity.taleID), nowMs);
  if (result.changed) require("./incursionProjectionRuntime").reconcile();
  return result;
}
function retireCompletions(tale, nowMs) {
  for (const completion of Object.values(tale.siteCompletions || {})) {
    if (completion.retirementAcknowledged) continue;
    const oldSlot = { ...completion.identity, operationID: completion.identity.slotOperationID,
      dungeonID: completion.dungeonID ?? completion.identity.dungeonID ?? 5166,
      position: completion.position, instanceID: completion.instanceID };
    const instance = dungeon.getInstance(completion.instanceID) || dungeon.findInstanceBySiteKey(siteKey(oldSlot), { full: true });
    if (instance) assertInstance(instance, tale, oldSlot);
    // Completion can run inside the final lethal hit. The death owner still
    // needs its native row to commit wreck/loot; only survivors withdraw here.
    require("./incursionActorCleanup").retireActors({ identity: completion.identity }, nowMs, { preserveCombatDeaths: true });
    // A refused flush can leave an empty cached collection while disk still
    // contains the withdrawn actors. Every retry fences all four owners.
    const flushed = require("../../gameStore").flushTablesSync(["npcEntities", "npcRuntimeControllers", "npcModules", "npcCargo"]);
    if (!flushed?.success) throw new Error(flushed?.errorMsg || "INCURSION_SITE_ACTOR_CLEANUP_PENDING");
    if (instance) {
      if (["active", "seeded", "paused"].includes(instance.lifecycleState)) dungeon.setLifecycleState(instance.instanceID,
        "completed", { nowMs, completedAtMs: completion.completedAtMs, durable: true, lifecycleReason: "incursion-sealed-completion" });
    }
    lifecycle.acknowledgeSiteRetirement(tale.taleID, completion.receiptID);
  }
}
function reconcileAdministrativeWithdrawal(instance) {
  if (instance?.sourceDungeonID !== 5193) return false;
  try {
    const operation = require("./incursionRewardStore").getOperation(`incursion-v2:${instance.instanceID}`);
    if (!require("./incursionFriendlyActors").removalPending(operation)) return false;
    dungeon.purgeInstance(instance.instanceID);
  } catch (error) {
    require("../../utils/logger").warn(`[Incursion] Administrative withdrawal ${instance.instanceID} pending: ${error.message}`);
  }
  return true;
}
function reconcile({ nowMs = incursionClock.now() } = {}) {
  let created = 0, recovered = 0, blocked = 0;
  for (let tale of lifecycle.listTales().filter(slots.enabled)) {
    // Test-only records copied into an ordinary store cannot activate or tear
    // down another session's world.
    if (tale.policy.testOnly && process.env.EVEJS_TEST_STORE_ISOLATED !== "1") continue;
    retireCompletions(tale, nowMs);
    if (!slots.live(tale, nowMs)) {
      if (nowMs < tale.createdAtMs) continue;
      lifecycle.closeSiteSlots(tale.taleID, nowMs);
      for (const slot of tale.siteSlots) {
        const instance = slot.instanceID ? dungeon.getInstance(slot.instanceID)
          : dungeon.findInstanceBySiteKey(siteKey(slot), { full: true });
        if (instance) assertInstance(instance, tale, slot);
        if (reconcileAdministrativeWithdrawal(instance)) { blocked++; continue; }
        if (instance && ["active", "seeded", "paused"].includes(instance.lifecycleState)) dungeon.setLifecycleState(instance.instanceID,
          "despawned", { nowMs, durable: true, lifecycleReason: "incursion-site-admission-closed" });
      }
      continue;
    }
    for (const snapshot of tale.siteSlots) {
      const current = lifecycle.getTale(tale.taleID), slot = current.siteSlots.find(row => row.slotID === snapshot.slotID);
      if (slot.state === "active") {
        const instance = dungeon.getInstance(slot.instanceID);
        if (!instance) { blocked++; continue; }
        assertInstance(instance, current, slot);
        if (reconcileAdministrativeWithdrawal(instance)) { blocked++; continue; }
        let operation = require("./incursionRewardStore").getOperation(admission.operationIdentity(instance).operationID);
        operation = require("./incursionEncounterRuntime").reconcilePending(instance, operation);
        if (operation?.receiptID) { acceptCompletion(instance, operation, nowMs); recovered++; }
        else if (operation?.failure) {
          require("./incursionEncounterRuntime").reconcile(instance);
          if (dungeon.getPersistedInstance(instance.instanceID)?.lifecycleState !== "failed") { blocked++; continue; }
          lifecycle.acceptSiteFailure(operation.identity.operationID, nowMs); recovered++;
          require("./incursionProjectionRuntime").reconcile();
        }
      } else if (slot.state === "reserved" && slot.dueAtMs <= nowMs) {
        try { ensureInstance(current, slot, nowMs); created++; }
        catch (error) {
          lifecycle.retrySiteInstance(identity(current, slot), error.message, nowMs); blocked++;
          require("../../utils/logger").warn(`[Incursion] Site ${slot.operationID} pending: ${error.message}`);
        }
      }
    }
  }
  return { created, recovered, blocked };
}
module.exports = { reconcile, ensureInstance, acceptCompletion, identity, assertInstance, siteKey, templateID };
