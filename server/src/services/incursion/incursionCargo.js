"use strict";

// Physical delivery is an accepted dungeon command followed by an independent
// inventory consumption receipt. Neither an RPC nor a mutable container count
// is evidence that the objective was paid.
const { fingerprint, fail } = require("./incursionLifecycleContract");
const model = require("./incursionSiteModel");
const store = require("./incursionRewardStore");
const clock = require("./incursionClock");
const items = require("../inventory/itemStore");
const active = new Set();
const runtime = () => require("../dungeon/dungeonRuntime");
const VERSION = "evejs.incursion-cargo.v1";
const positive = value => Number.isSafeInteger(value) && value > 0;
const checked = result => { if (!result?.success) fail(result?.errorMsg || "INCURSION_CARGO_PENDING"); return result; };
const contentKey = rule => `incursion-cargo:${rule.nativeObjectID}`;
const journalOf = instance => instance?.spawnState?.incursionCargo || { version: 1, commands: {} };
const enabled = (operation, rule) => !rule.enabledWhen || require("./incursionSiteMechanics").evaluate(operation, rule.enabledWhen);
function rules(instance) {
  if (instance?.runtimeFlags?.incursionRuntime !== true || ![5165, 5167, 5175].includes(instance.sourceDungeonID)) return [];
  const policy = require("./incursionAdmission").admittedPolicy(instance);
  if (policy?.version !== 2) return [];
  return policy.mechanics.objectives.filter(rule => rule.acceptedTypeID).map(rule => {
    const objective = policy.objectives.find(row => row.key === rule.key), binding = policy.mechanics.objectBindings[rule.nativeObjectID];
    const repeatable = instance.sourceDungeonID === 5175;
    if (objective?.kind !== "cargo" || Boolean(objective.repeatable) !== repeatable || objective.typeID !== rule.acceptedTypeID ||
        objective.quantity !== rule.consumeQuantity || (!repeatable && rule.requiredQuantity !== rule.consumeQuantity) ||
        (repeatable && (rule.key !== "shield-control" || rule.acceptedTypeID !== 3501 || rule.consumeQuantity !== 1 || rule.suppressionDurationMs !== 120000)) ||
        binding?.typeID !== rule.typeID || binding.roomKey !== objective.roomKey ||
        !positive(rule.consumeQuantity) || rule.allowLegitimatePreexistingCargo !== true ||
        rule.maximumTransferRangeMeters !== 2500) fail("INCURSION_CARGO_POLICY_INVALID");
    // Neutral evacuation scenery uses the existing system-owned container
    // convention. Its native object does not establish a civilian corporation.
    return { rule, objective, binding, policy, receiverOwnerID: rule.hostile === false ? 1 : policy.mechanics.actorCorporationID };
  });
}
function projectPopulationHints(instance, hints) {
  const rows = rules(instance);
  if (!rows.length) return hints;
  const identity = require("./incursionAdmission").operationIdentity(instance), operation = store.getOperation(identity.operationID);
  const ownKeys = new Set(rows.map(row => contentKey(row.rule)));
  const props = (hints.environmentProps || []).filter(prop => !ownKeys.has(prop.key));
  const removed = (hints.environmentProps?.length || 0) - props.length;
  let added = 0;
  for (const [ordinal, row] of rows.entries()) {
    if (!operation || operation.status !== "active" ||
        !enabled(operation, row.rule)) continue;
    const { rule, binding } = row;
    const prop = { key: contentKey(rule), exact: true, typeID: binding.typeID, roomKey: binding.roomKey,
      ownerID: row.receiverOwnerID, dunObjectID: binding.objectID,
      dunObjectNameID: binding.nameID, positionOffset: structuredClone(binding.positionOffset),
      ...(binding.dunRotation ? { dunRotation: structuredClone(binding.dunRotation) } : {}),
      suppressSlimName: true, legacyEnvironmentOrdinal: 500 + ordinal };
    const old = props.find(candidate => candidate.dunObjectID === rule.nativeObjectID);
    if (old && fingerprint(old) !== fingerprint(prop)) fail("INCURSION_CARGO_PRESENTATION_CONFLICT");
    if (!old) { props.push(prop); added++; }
  }
  return { ...hints, environmentProps: props, exactContentCaps: { ...hints.exactContentCaps,
    environmentProps: (hints.exactContentCaps?.environmentProps ?? hints.environmentProps?.length ?? 0) - removed + added } };
}
function findReceiver(session, receiverID) {
  const scene = require("../../space/runtime").getSceneForSession(session), entity = scene?.getEntityByID(Number(receiverID));
  if (!entity?.dungeonMaterializedEnvironment || !positive(Number(entity.dungeonSiteInstanceID))) return null;
  const instance = runtime().getInstance(entity.dungeonSiteInstanceID);
  const row = rules(instance).find(row => row.rule.nativeObjectID === Number(entity.dunObjectID) &&
    row.binding.typeID === Number(entity.typeID) && Number(entity.ownerID) === row.receiverOwnerID && entity.dungeonEnvironmentKey === contentKey(row.rule));
  return row ? { ...row, instance, scene, entity } : null;
}
function isReceiver(session, receiverID) { return Boolean(findReceiver(session, receiverID)); }
function assertOpen(instance, operation, nowMs) {
  if (operation?.status !== "active") fail("INCURSION_CARGO_NOT_ACTIVE");
  require("./incursionTerminalContract").assertCompletionOpen(operation.identity, nowMs, nowMs);
  require("./incursionLifecycle").siteAdmission({ ...instance.metadata.incursionAdmission,
    instanceID: instance.instanceID, solarSystemID: instance.solarSystemID }, nowMs);
}
function resolveReceiver(session, receiverID) {
  const context = findReceiver(session, receiverID);
  if (!context) return null;
  const { instance, scene, rule, objective } = context;
  const ship = scene.getShipEntityForSession(session), encounter = require("./incursionEncounterRuntime");
  const pilot = ship && encounter.sourcePilot(scene, instance, ship);
  if (!pilot || ship.session !== session || Number(ship.groupID) === 29 ||
      ship.dungeonCurrentRoomKey !== objective.roomKey || ship.isCloaked || ship.cloakMode || ship.cloaked ||
      session.stationid || session.stationID) return null;
  const distance = Math.hypot(...["x", "y", "z"].map(axis => ship.position[axis] - context.entity.position[axis])) -
    Math.max(0, Number(ship.radius) || 0) - Math.max(0, Number(context.entity.radius) || 0);
  if (!Number.isFinite(distance) || distance > rule.maximumTransferRangeMeters) return null;
  const operation = encounter.reconcile(instance);
  try { assertOpen(instance, operation, clock.now()); } catch (_) { return null; }
  if (instance.sourceDungeonID === 5175 && require("./incursionStructures").getCommittedDeath(instance, "research-center")) return null;
  if (!enabled(operation, rule)) return null;
  return { ...context, operation, ship, characterID: pilot.characterID };
}
function receiverItem(session, receiverID) {
  const context = resolveReceiver(session, receiverID);
  if (!context) return null;
  const { entity, scene } = context;
  return { itemID: entity.itemID, typeID: entity.typeID, groupID: entity.groupID, categoryID: entity.categoryID,
    ownerID: entity.ownerID, locationID: scene.systemID, flagID: 0, singleton: 1, quantity: 1, stacksize: 1,
    itemName: entity.itemName || "", customInfo: "" };
}
function capacity(session, receiverID) {
  const context = resolveReceiver(session, receiverID);
  if (!context) return { capacity: 0, used: 0 };
  const amount = context.objective.repeatable ? 0 : context.operation.objectives[context.objective.key].quantity;
  const volume = items.getInventoryItemUnitVolume({ typeID: context.rule.acceptedTypeID });
  return { capacity: context.rule.consumeQuantity * volume, used: amount * volume };
}
function save(instanceID, journal) {
  return runtime().mergeSpawnState(instanceID, { incursionCargo: journal }, { durable: true, force: true });
}
function sourceFor(context, item) {
  const { instance, ship, characterID, scene } = context;
  const flags = context.rule.acceptedTypeID === 28620 ? [items.ITEM_FLAGS.CARGO_HOLD, items.ITEM_FLAGS.GENERAL_MINING_HOLD] : [items.ITEM_FLAGS.CARGO_HOLD];
  if (item.locationID === ship.itemID && flags.includes(item.flagID)) return { locationID: ship.itemID };
  if (instance.sourceDungeonID !== 5175 || item.flagID !== items.ITEM_FLAGS.CARGO_HOLD) return null;
  const parent = items.findItemById(item.locationID), entity = scene.getEntityByID(item.locationID);
  if (!require("../inventory/cargoLootAuthority").isDisposableJetcanRecord(parent) || parent.ownerID !== characterID ||
      parent.locationID !== instance.solarSystemID || parent.expiresAtMs <= clock.now() || entity?.kind !== "container" ||
      entity.typeID !== 23 || entity.destroyed || entity.destroying || entity.removed ||
      ["destroyed", "destroying"].includes(entity.destructionState) ||
      !require("../../space/destiny/identity/interactionScope").canEntitiesInteractLocally(ship, entity)) return null;
  const distance = Math.hypot(...["x", "y", "z"].map(axis => ship.position[axis] - entity.position?.[axis])) -
    Math.max(0, Number(ship.radius) || 0) - Math.max(0, Number(entity.radius) || 0);
  if (!Number.isFinite(distance) || distance > 2500) return null;
  return { locationID: parent.itemID, container: { itemID: parent.itemID, typeID: 23, ownerID: characterID } };
}
function validateIntent(instance, operation, key, intent) {
  const row = rules(instance).find(row => row.rule.key === intent.objectiveKey);
  const { request, snapshot } = intent;
  const sourceValid = request?.expectedLocationID === intent.shipID && !intent.sourceContainer ||
    instance.sourceDungeonID === 5175 && intent.sourceContainer?.typeID === 23 && positive(intent.sourceContainer.itemID) &&
      intent.sourceContainer.ownerID === intent.characterID && request?.expectedLocationID === intent.sourceContainer.itemID &&
      request.expectedFlagID === items.ITEM_FLAGS.CARGO_HOLD;
  if (!row || intent.version !== 1 || intent.policyVersion !== VERSION || intent.operationID !== operation.identity.operationID ||
      intent.policyFingerprint !== operation.policyFingerprint || intent.instanceID !== instance.instanceID ||
      !positive(intent.serial) || key !== `incursion-cargo:${instance.instanceID}:${row.rule.key}:${intent.serial}` ||
      !["prepared", "projected", "cancelled"].includes(intent.status) ||
      !positive(intent.receiverID) || intent.nativeObjectID !== row.rule.nativeObjectID ||
      intent.receiverOwnerID !== row.receiverOwnerID ||
      intent.receiverTypeID !== row.binding.typeID || intent.roomKey !== row.objective.roomKey ||
      !positive(intent.quantity) || intent.quantity > row.objective.quantity ||
      !positive(intent.characterID) || !positive(intent.shipID) || !positive(snapshot?.atMs) || snapshot.atMs > clock.now() ||
      !Array.isArray(snapshot.presence) || snapshot.presence.length > 4096 || snapshot.presence.some(row =>
        !positive(row.characterID) || !Number.isSafeInteger(row.fleetID) || row.fleetID < 0 || !positive(row.groupID) ||
        typeof row.activeShip !== "boolean" || typeof row.cloaked !== "boolean") || !request || !positive(request.itemID) ||
      request.quantity !== intent.quantity || request.expectedTypeID !== row.rule.acceptedTypeID ||
      request.expectedOwnerID !== intent.characterID || !sourceValid ||
      !(row.rule.acceptedTypeID === 28620 ? [items.ITEM_FLAGS.CARGO_HOLD, items.ITEM_FLAGS.GENERAL_MINING_HOLD] : [items.ITEM_FLAGS.CARGO_HOLD]).includes(request.expectedFlagID) ||
      !positive(request.expectedQuantity) || request.expectedQuantity < intent.quantity) fail("INCURSION_CARGO_INTENT_INVALID");
  require("../inventory/incursionCombatOutcomes").normalizeCompletionTaxProfiles(snapshot.taxProfiles, snapshot.presence);
  return row;
}
function proofFor(intent) {
  const { status, ...accepted } = intent;
  return { operation: "incursion-objective-cargo", ...accepted };
}
function receiptFor(key, intent) {
  const receipt = checked(items.getIdempotentGrantReceipt(key, { requireDurable: true, reconcileWriteRefusal: true }));
  if (!receipt.found) return null;
  if (!receipt.durable || receipt.data.operation !== "exchange-inventory-item-stacks" ||
      fingerprint(receipt.data.fingerprint) !== fingerprint(proofFor(intent)) ||
      (intent.objectiveKey === "shield-control" && (!positive(receipt.data.completedAtMs) || receipt.data.completedAtMs < intent.snapshot.atMs || receipt.data.completedAtMs > clock.now())) ||
      receipt.data.resultData?.consumedQuantity !== intent.quantity) fail("INCURSION_CARGO_RECEIPT_MISMATCH");
  return receipt.data;
}
function currentChanges(receipt, characterID) {
  return (receipt.resultData?.changes || []).map(change => {
    const previous = change.previousData || change.item, current = items.findItemById(previous.itemID);
    return { ...change, item: current?.ownerID === characterID ? current : items.buildRemovedItemNotificationState(previous) };
  });
}
function publish(intent, receipt) {
  const changes = currentChanges(receipt, intent.characterID);
  for (const session of require("../raffles/raffleInventory").getCharacterSessions(intent.characterID)) {
    require("../character/characterState").emitItemsChangedBatchForSession(session, changes);
  }
}
function reconcile(instance, previous, { closed = false } = {}) {
  if (!rules(instance).length) return previous;
  if (active.has(instance.instanceID)) return store.getOperation(previous.identity.operationID) || previous;
  active.add(instance.instanceID);
  try { return settleAccepted(instance, previous, closed); }
  finally { active.delete(instance.instanceID); }
}
function settleAccepted(instance, previous, closed) {
  let operation = store.getOperation(previous.identity.operationID) || previous;
  const current = runtime().getInstance(instance.instanceID) || instance, journal = structuredClone(journalOf(current));
  const entries = Object.entries(journal.commands).sort((left, right) => left[1].serial - right[1].serial);
  if (journal.version !== 1 || entries.length > 65536) fail("INCURSION_CARGO_JOURNAL_INVALID");
  if (entries.some(([key, intent], index) => intent.serial !== index + 1)) fail("INCURSION_CARGO_JOURNAL_INVALID");
  if (fingerprint(journalOf(runtime().getPersistedInstance(instance.instanceID))) !== fingerprint(journal)) save(instance.instanceID, journal);
  for (const [key, intent] of entries) {
    const row = validateIntent(instance, operation, key, intent);
    if (intent.status !== "prepared") continue;
    // A previous refused prepare can remain cached. Re-fence the exact command
    // before attempting any inventory mutation, including an idempotent retry.
    save(instance.instanceID, journal);
    let receipt = receiptFor(key, intent);
    const death = instance.sourceDungeonID === 5175 && require("./incursionStructures").getCommittedDeath(instance, "research-center");
    if (!receipt && death) { intent.status = "cancelled"; save(instance.instanceID, journal); continue; }
    if (!receipt && !closed) {
      assertOpen(instance, operation, clock.now());
      if (!enabled(operation, row.rule)) fail("INCURSION_CARGO_NOT_READY");
      const result = items.exchangeInventoryItemStacksIdempotent([intent.request], [], {
        receiptKey: key, fingerprint: proofFor(intent), completedAtMs: clock.now() });
      if (!result.success && ["ITEM_NOT_FOUND", "ITEM_CUSTODY_CHANGED"].includes(result.errorMsg)) {
        intent.status = "cancelled"; save(instance.instanceID, journal); continue;
      }
      checked(result); receipt = receiptFor(key, intent);
      if (!receipt) fail("INCURSION_CARGO_RECEIPT_PENDING");
    }
    if (!receipt) { intent.status = "cancelled"; save(instance.instanceID, journal); continue; }
    const fact = { receiptID: key, objectiveKey: row.objective.key, kind: "cargo", typeID: row.objective.typeID,
      roomKey: row.objective.roomKey, quantity: intent.quantity, proof: fingerprint(receipt) };
    const prior = operation.objectives[row.objective.key].receipts[key];
    if (prior && prior !== fingerprint(fact)) fail("INCURSION_CARGO_RECEIPT_MISMATCH");
    if ((closed || death && receipt.completedAtMs > death.atMs) && !prior) {
      // As with late health journals, consumed cargo is audited without
      // reopening a sealed/expired pool or rewriting its recipients.
      const path = `/terminalOutcomes/${operation.identity.operationID}`, outcomes = store.read(path) || {}, proof = fingerprint(fact);
      if (outcomes[key] && outcomes[key].proof !== proof) fail("INCURSION_CARGO_RECEIPT_MISMATCH");
      if (!outcomes[key]) { outcomes[key] = { proof, kind: "cargo", atMs: intent.snapshot.atMs, targetEntityID: intent.receiverID };
        store.transaction([[path, outcomes]]); }
    } else if (!prior) {
      let next = model.recordObjective(operation, fact);
      if (next.status === "ready") {
        next = model.finalize(next, intent.snapshot.presence, intent.snapshot.atMs);
        next.completion.taxProfiles = intent.snapshot.taxProfiles;
        require("./incursionRewards").sealCompletion({ completedOperation: next, recipients: next.completion.recipients,
          completedAtMs: intent.snapshot.atMs });
        operation = store.getOperation(next.identity.operationID);
      } else operation = store.saveOperation(next);
    }
    intent.status = "projected"; save(instance.instanceID, journal);
    publish(intent, receipt);
  }
  return operation;
}
function tryDeliver(session, receiverID, item, requestedQuantity) {
  if (!isReceiver(session, receiverID)) return null;
  const reject = { handled: true, success: false, changes: [] };
  try {
    const context = resolveReceiver(session, receiverID);
    if (!context) return reject;
    const { instance, operation, objective, rule, characterID, ship } = context;
    const available = Number(item?.stacksize ?? item?.quantity), requested = requestedQuantity == null ? available : Number(requestedQuantity);
    if (!item || item.ownerID !== characterID || item.typeID !== rule.acceptedTypeID ||
        !positive(available) || !positive(requested) || requested > available) return reject;
    const source = sourceFor(context, item); if (!source) return reject;
    const remaining = objective.repeatable ? objective.quantity : objective.quantity - operation.objectives[objective.key].quantity;
    if (!positive(remaining)) return reject;
    const journal = structuredClone(journalOf(runtime().getInstance(instance.instanceID)));
    if (Object.values(journal.commands).some(intent => intent.status === "prepared")) fail("INCURSION_CARGO_PENDING");
    const serial = Object.keys(journal.commands).length + 1, key = `incursion-cargo:${instance.instanceID}:${rule.key}:${serial}`;
    const quantity = Math.min(remaining, requested), presence = require("./incursionEncounterRuntime").presence(context.scene, instance);
    journal.commands[key] = { version: 1, policyVersion: VERSION, status: "prepared", instanceID: instance.instanceID,
      operationID: operation.identity.operationID, policyFingerprint: operation.policyFingerprint, objectiveKey: objective.key,
      serial, receiverID: Number(receiverID), nativeObjectID: rule.nativeObjectID, receiverTypeID: context.binding.typeID,
      receiverOwnerID: context.receiverOwnerID,
      roomKey: objective.roomKey, quantity, characterID, shipID: Number(ship.itemID),
      ...(source.container ? { sourceContainer: source.container } : {}),
      request: { itemID: item.itemID, quantity, expectedTypeID: item.typeID, expectedOwnerID: characterID,
        expectedLocationID: source.locationID, expectedFlagID: item.flagID, expectedQuantity: available },
      snapshot: { atMs: clock.now(), presence, taxProfiles: Object.fromEntries(presence.map(row => [row.characterID,
        require("../corporation/corporationTax").resolveCorporationTaxProfile(row.characterID)])) } };
    save(instance.instanceID, journal);
    reconcile(instance, operation);
    require("./incursionEncounterRuntime").reconcile(runtime().getInstance(instance.instanceID));
    return { handled: true, success: runtime().getInstance(instance.instanceID)?.spawnState?.incursionCargo?.commands[key]?.status === "projected", changes: [] };
  } catch (error) { return { ...reject, errorMsg: error.message }; }
}
function beforePurge(instance) {
  if (!instance || !Object.values(journalOf(instance).commands).some(intent => intent.status === "prepared")) return;
  const operation = store.getOperation(require("./incursionAdmission").operationIdentity(instance).operationID);
  if (!operation) fail("INCURSION_CARGO_OPERATION_MISSING");
  reconcile(instance, operation, { closed: true });
}
function objectiveProof(instance, operation, objectiveKey) {
  const row = rules(instance).find(row => row.objective.key === objectiveKey);
  if (!row || operation.objectives[objectiveKey]?.quantity < row.objective.quantity) return null;
  const durable = runtime().getPersistedInstance(instance.instanceID), proofs = [];
  let quantity = 0, last = null;
  for (const [key, intent] of Object.entries(journalOf(durable).commands)) {
    if (intent.objectiveKey !== objectiveKey || intent.status === "cancelled") continue;
    validateIntent(instance, operation, key, intent);
    const receipt = receiptFor(key, intent);
    if (!receipt) fail("INCURSION_CARGO_RECEIPT_MISSING");
    const fact = { receiptID: key, objectiveKey, kind: "cargo", typeID: row.objective.typeID,
      roomKey: row.objective.roomKey, quantity: intent.quantity, proof: fingerprint(receipt) };
    if (operation.objectives[objectiveKey].receipts[key] !== fingerprint(fact)) fail("INCURSION_CARGO_RECEIPT_MISMATCH");
    proofs.push({ receiptID: key, proof: fingerprint(receipt) }); quantity += intent.quantity;
    if (!last || intent.serial > last.serial) last = intent;
  }
  if (quantity !== operation.objectives[objectiveKey].quantity || (!row.objective.repeatable && quantity !== row.objective.quantity) ||
      !last || proofs.length !== Object.keys(operation.objectives[objectiveKey].receipts).length) {
    fail("INCURSION_CARGO_RECEIPT_MISMATCH");
  }
  proofs.sort((a, b) => a.receiptID.localeCompare(b.receiptID));
  return { objectiveKey, quantity, receipts: proofs, snapshot: structuredClone(last.snapshot), proof: fingerprint(proofs) };
}
function suppressionState(instance, operation) {
  const row = rules(instance).find(row => row.rule.key === "shield-control");
  if (!row) return null;
  const receipts = consumptionFacts(instance, operation, row.objective.key);
  return { untilMs: receipts.length ? Math.max(...receipts.map(receipt => receipt.atMs + row.rule.suppressionDurationMs)) : 0, receipts };
}
function consumptionFacts(instance, operation, objectiveKey) {
  const facts = [];
  for (const [key, intent] of Object.entries(journalOf(runtime().getPersistedInstance(instance.instanceID)).commands)) {
    if (intent.objectiveKey !== objectiveKey || intent.status === "cancelled") continue;
    validateIntent(instance, operation, key, intent);
    const receipt = receiptFor(key, intent);
    if (receipt) facts.push({ receiptID: key, proof: fingerprint(receipt), atMs: receipt.completedAtMs, quantity: intent.quantity });
  }
  return facts.sort((a, b) => a.receiptID.localeCompare(b.receiptID));
}
module.exports = { rules, projectPopulationHints, isReceiver, resolveReceiver, receiverItem, capacity, reconcile, tryDeliver, beforePurge, objectiveProof, suppressionState, consumptionFacts };
