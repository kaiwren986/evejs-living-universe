"use strict";

// Finite Lyavite uses the existing mining/custody journal. This adapter admits
// the shared incursion rock and projects independent paid custody facts.
const { fingerprint, fail } = require("./incursionLifecycleContract");
const positive = value => Number.isSafeInteger(value) && value > 0;
function policyFor(instance) {
  if (instance?.runtimeFlags?.incursionRuntime !== true || instance.sourceDungeonID !== 5165) return null;
  const policy = require("./incursionAdmission").admittedPolicy(instance);
  if (policy?.version !== 2) return null;
  const resource = policy.mechanics.objectives.find(row => row.key === "lyavite-rock" && row.role === "resource");
  const binding = resource && policy.mechanics.objectBindings[resource.nativeObjectID];
  if (resource?.nativeObjectID !== 1010540 || resource.typeID !== 28620 || !positive(resource.quantity) ||
      binding?.typeID !== resource.typeID || !policy.roomKeys.includes(binding.roomKey)) fail("INCURSION_MINING_POLICY_INVALID");
  return { version: 1, owner: "incursion-shared", oreTypeID: resource.typeID, minimumMinedQuantity: 1,
    sourceObjectID: resource.nativeObjectID, quantity: resource.quantity, roomKey: binding.roomKey, binding };
}
function isRock(entity) {
  if (entity?.dungeonMaterializedMiningRock !== true) return false;
  const instance = require("../dungeon/dungeonRuntime").getInstance(Number(entity.dungeonSiteInstanceID)), policy = policyFor(instance);
  return Boolean(policy && Number(entity.dungeonSourceObjectID || entity.dunObjectID) === policy.sourceObjectID &&
    Number(entity.miningYieldTypeID || entity.slimTypeID) === policy.oreTypeID &&
    Number(entity.miningOriginalQuantity) === policy.quantity && entity.dungeonMiningRoomKey === policy.roomKey);
}
function canExtract(scene, instance, source, rock) {
  const policy = policyFor(instance);
  if (!policy || !source || !scene || !isRock(rock) || instance.instanceScope !== "shared" || source.dungeonCurrentRoomKey !== policy.roomKey ||
      Number(source.groupID) === 29 || (source.isCloaked ?? source.cloakMode ?? source.cloaked) ||
      !require("./incursionEncounterRuntime").sourcePilot(scene, instance, source)) return false;
  try {
    require("./incursionLifecycle").siteAdmission({ ...instance.metadata.incursionAdmission,
      instanceID: instance.instanceID, solarSystemID: instance.solarSystemID }, require("./incursionClock").now());
    return true;
  } catch (_) { return false; }
}
function projectPopulationHints(instance, hints) {
  const policy = policyFor(instance);
  if (!policy) return hints;
  const binding = policy.binding;
  return { ...hints, miningRocks: [{ count: 1, oreTypeID: policy.oreTypeID, typeID: policy.oreTypeID,
    quantity: policy.quantity, yieldKind: "ore", roomKey: policy.roomKey, dunObjectID: policy.sourceObjectID,
    sourceObjectID: policy.sourceObjectID, positionOffset: structuredClone(binding.positionOffset),
    ...(binding.radius ? { radius: binding.radius } : {}), ...(binding.nameID ? { dunObjectNameID: binding.nameID } : {}),
    ...(binding.dunRotation ? { dunRotation: structuredClone(binding.dunRotation) } : {}) }] };
}
function collect(instance, previous) {
  const policy = policyFor(instance);
  if (!policy || previous.status !== "active") return previous;
  const runtime = require("../dungeon/dungeonRuntime"), current = runtime.getInstance(instance.instanceID) || instance;
  const cached = current.spawnState?.missionMining?.extractionsByKey || {};
  if (!previous.mechanics?.pendingMiningReceipts?.length &&
      !Object.keys(cached).some(key => cached[key].status !== "cancelled" && !previous.mechanics?.miningReceipts?.[key])) return previous;
  const durable = runtime.getPersistedInstance(instance.instanceID);
  if (!durable) fail("INCURSION_MINING_INSTANCE_MISSING");
  const custody = require("../inventory/itemCustody"), next = structuredClone(previous), pending = [];
  for (const [key, intent] of Object.entries(durable.spawnState?.missionMining?.extractionsByKey || {})) {
    if (intent.status === "cancelled" || next.mechanics?.miningReceipts?.[key]) continue;
    if (!["prepared", "complete"].includes(intent.status) || !positive(intent.characterID) || !positive(intent.shipID) ||
        !positive(intent.rockID) || !positive(intent.moduleID) || !positive(intent.cycleAtMs) || !positive(intent.quantity) ||
        intent.quantity > policy.quantity || intent.typeID !== policy.oreTypeID || intent.dunObjectID !== policy.sourceObjectID ||
        !positive(intent.incursionAtMs) || intent.incursionAtMs > require("./incursionClock").now() ||
        key !== intent.grantKey || key !== `mission-mine:${instance.instanceID}:${intent.rockID}:${intent.shipID}:${intent.moduleID}:${intent.cycleAtMs}`) {
      fail("INCURSION_MINING_INTENT_INVALID");
    }
    const receipt = custody.getCommittedReceipt(key);
    if (!receipt.success || receipt.ambiguous) fail(receipt.errorMsg || "INCURSION_MINING_RECEIPT_PENDING");
    if (!receipt.committed) {
      if (intent.status === "complete") fail("INCURSION_MINING_RECEIPT_MISSING");
      pending.push(key);
      continue;
    }
    // The existing single-type mint receipt records concrete destination/type/
    // quantity fields and custody origin metadata, rather than an exchange
    // fingerprint. Read that actual owner contract after its durable fence.
    const proof = receipt.receipt, origin = proof.metadata?.itemCustody;
    if (origin?.commandType !== custody.CUSTODY_COMMAND_TYPE.TRANSFER || origin.idempotencyKey !== key ||
        origin.reason !== custody.CUSTODY_REASON.MISSION_REWARD_GRANT || proof.ownerID !== intent.characterID ||
        proof.typeID !== policy.oreTypeID || proof.quantity !== intent.quantity || proof.locationID !== intent.shipID ||
        proof.flagID !== intent.flagID || proof.onlyIfMissing || proof.resultData?.skippedExisting) {
      fail("INCURSION_MINING_RECEIPT_MISMATCH");
    }
    const fact = { receiptID: key, sourceObjectID: policy.sourceObjectID, quantity: intent.quantity,
      atMs: intent.incursionAtMs, characterID: intent.characterID, shipID: intent.shipID,
      proof: fingerprint(proof) };
    if (!positive(fact.atMs)) fail("INCURSION_MINING_INTENT_INVALID");
    next.mechanics ||= {}; next.mechanics.miningReceipts ||= {}; next.mechanics.miningReceipts[key] = fact;
  }
  next.mechanics ||= {}; next.mechanics.pendingMiningReceipts = pending.sort();
  return next;
}
module.exports = { policyFor, isRock, canExtract, projectPopulationHints, collect };
