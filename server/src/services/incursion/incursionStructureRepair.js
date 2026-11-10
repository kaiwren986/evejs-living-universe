"use strict";

// One aggregate shield link connects the nine native anchors to TCRC's tower.
// Cadence is derived from room entry and committed HP events, not a second timer
// or health authority. Only a loaded native room may create a fresh pulse.
const { fingerprint, fail } = require("./incursionLifecycleContract"), clock = require("./incursionClock");
const VERSION = "evejs.incursion-tcrc-repair.v1";
function spec(instance) {
  if (instance?.sourceDungeonID !== 5175 || instance.runtimeFlags?.incursionRuntime !== true) return null;
  const policy = require("./incursionAdmission").admittedPolicy(instance);
  const rule = policy?.mechanics?.objectives.find(row => row.key === "research-center"), link = rule?.repairLink;
  const objectIDs = Array.from({ length: 9 }, (_, index) => 1012978 + index);
  if (policy?.version !== 2 || rule?.nativeObjectID !== 1011574 || link?.periodMs !== 1000 ||
      link.amountPerCycle?.shield !== "50percent-of-native-maximum" || link.amountPerCycle.armor !== 0 ||
      link.capAtNativeMaximum !== true || fingerprint(link.sourceNativeObjectIDs) !== fingerprint(objectIDs) ||
      objectIDs.some(id => policy.mechanics.objectBindings[id]?.typeID !== 3620)) fail("INCURSION_TCRC_REPAIR_POLICY_INVALID");
  return { policy, key: rule.key, objectIDs, roomKey: policy.mechanics.objectBindings[rule.nativeObjectID].roomKey, periodMs: 1000, fraction: 0.5 };
}
function bindings(instance, current = spec(instance)) {
  const descriptors = require("../dungeon/dungeonUniverseSiteService").incursionStructurePorts.sources(instance, current.objectIDs);
  if (descriptors.length !== 9 || new Set(descriptors.map(row => row.itemID)).size !== 9) fail("INCURSION_TCRC_REPAIR_SOURCES_INVALID");
  return current.objectIDs.map(nativeObjectID => {
    const row = descriptors.find(row => row.dunObjectID === nativeObjectID);
    // Ordinary LCOs can omit room tags. Their native binding and exact world
    // position still establish the room independently of a caller's request.
    const roomKey = current.policy.mechanics.objectBindings[nativeObjectID].roomKey;
    if (!row || row.typeID !== 3620 || roomKey !== current.roomKey || (row.dungeonRoomKey && row.dungeonRoomKey !== roomKey) || row.dungeonSiteInstanceID !== instance.instanceID ||
        !(row.itemID > 0)) fail("INCURSION_TCRC_REPAIR_SOURCES_INVALID");
    return { nativeObjectID, entityID: row.itemID, typeID: row.typeID, ownerID: row.ownerID,
      roomKey, position: structuredClone(row.position) };
  });
}
function facts(instance, operation) { return require("./incursionCargo").consumptionFacts(instance, operation, "shield-control"); }
function unsuppressed(receipts, atMs) { return receipts.every(row => atMs >= row.atMs + 120000); }
function eligible(instance, operation, record, scene, sourceBindings) {
  const target = scene?.getEntityByID?.(record.entityID);
  if (!target || operation.status !== "active" || target.incursionStructurePhase !== "health" || target.typeID !== record.typeID ||
      target.dunObjectID !== record.nativeObjectID || target.dungeonSiteInstanceID !== instance.instanceID ||
      target.incursionHealthPending || require("./incursionHooks").isDamageInProgress(target) ||
      record.conditionState.damage >= 1 || target.conditionState?.damage >= 1 || target.destroyed || target.destroying ||
      ["shieldCharge", "armorDamage", "damage"].some(key => target.conditionState?.[key] !== record.conditionState[key])) return false;
  return sourceBindings.every(binding => {
    const source = scene.getEntityByID(binding.entityID);
    return source?.dungeonMaterializedEnvironment === true && source.dungeonSiteInstanceID === instance.instanceID &&
      (!source.dungeonRoomKey || source.dungeonRoomKey === binding.roomKey) && source.typeID === binding.typeID && source.ownerID === binding.ownerID &&
      source.dunObjectID === binding.nativeObjectID && !source.destroyed && !source.destroying &&
      fingerprint(source.position) === fingerprint(binding.position);
  });
}
function validateEvent(instance, operation, record, event, previousAtMs, sourceBindings) {
  const current = spec(instance), enteredAt = operation.mechanics?.roomEntries?.[current.roomKey];
  const actual = facts(instance, operation), frozen = event.repair?.consumptions;
  if (event.repair?.version !== VERSION || event.cause !== "tcrc-shield-links" || event.characterID !== 0 || event.fleetID !== 0 ||
      event.sourceShipID !== 0 || event.moduleID !== 0 || event.targetCharacterID !== 0 || event.destroyed ||
      !(enteredAt > 0) || event.atMs > clock.now() || event.atMs < Math.max(enteredAt, previousAtMs) + current.periodMs ||
      event.repair.sourceProof !== fingerprint(sourceBindings) || event.repair.maximumAmount !== record.maximum.shieldCapacity * current.fraction ||
      !Array.isArray(frozen) || !unsuppressed(frozen, event.atMs) ||
      new Set(frozen.map(row => row.receiptID)).size !== frozen.length ||
      frozen.some(row => row.atMs > event.atMs || !actual.some(other => fingerprint(other) === fingerprint(row))) ||
      actual.some(row => row.atMs < event.atMs && !frozen.some(other => fingerprint(other) === fingerprint(row)))) fail("INCURSION_TCRC_REPAIR_PROOF_INVALID");
  // A handover after this HP commit can share its clock millisecond. The frozen
  // receipt set records that causal order; later same-time receipts cannot
  // invalidate a prior pulse. Strictly older physical receipts must be present.
}
function request(instance, operation, record, scene) {
  const current = spec(instance); if (!current) return null;
  const enteredAt = operation.mechanics?.roomEntries?.[current.roomKey], nowMs = clock.now();
  const last = Object.values(record.events).reduce((at, row) => row.event.kind === "repair" ? Math.max(at, row.event.atMs) : at, 0);
  if (!(enteredAt > 0) || nowMs < Math.max(enteredAt, last) + current.periodMs || record.conditionState.shieldCharge >= 1) return null;
  const consumptions = facts(instance, operation);
  if (!unsuppressed(consumptions, nowMs)) return null;
  const sourceBindings = bindings(instance, current);
  if (!eligible(instance, operation, record, scene, sourceBindings)) return null;
  return { version: VERSION, instanceID: instance.instanceID, operationID: operation.identity.operationID,
    targetKey: record.key, targetEntityID: record.entityID, targetTypeID: record.typeID, sequence: record.sequence + 1,
    atMs: nowMs, sourceProof: fingerprint(sourceBindings), maximumAmount: record.maximum.shieldCapacity * current.fraction, consumptions };
}
module.exports = { VERSION, spec, bindings, eligible, facts, unsuppressed, validateEvent, request };
