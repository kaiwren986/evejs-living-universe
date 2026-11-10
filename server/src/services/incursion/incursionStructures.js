"use strict";

// Native static structures keep health and its outcome in the existing dungeon
// owner. The reward owner consumes only independently fenced health facts.
const { fingerprint, fail } = require("./incursionLifecycleContract");
const model = require("./incursionSiteModel");
const store = require("./incursionRewardStore");
const clock = require("./incursionClock");
const VERSION = "evejs.incursion-structure-health.v1";
const active = new Set(), sabotage = new WeakMap();
const runtime = () => require("../dungeon/dungeonRuntime");
const positive = value => Number.isSafeInteger(value) && value > 0;
const checked = value => { if (!value?.success) fail(value?.errorMsg || "INCURSION_STRUCTURE_PENDING"); return value; };
const journalOf = instance => instance?.spawnState?.incursionStructures || { version: 1, targets: {} };
function context(instance) {
  if (instance?.runtimeFlags?.incursionRuntime !== true || ![5165, 5114, 5175, 5158, 5201].includes(instance.sourceDungeonID)) return null;
  const policy = require("./incursionAdmission").admittedPolicy(instance);
  if (policy?.version !== 2) return null;
  const rules = policy.objectives.filter(objective => objective.kind === "structure").map(objective => {
    const rule = policy.mechanics.objectives.find(row => row.key === objective.key && row.role === "terminal");
    const binding = rule && policy.mechanics.objectBindings[rule.nativeObjectID];
    if (!rule || rule.typeID !== 3500 || binding?.typeID !== 3500 || binding.objectID !== objective.nativeObjectID ||
        binding.roomKey !== objective.roomKey || objective.quantity !== 1) fail("INCURSION_STRUCTURE_POLICY_INVALID");
    return { objective, rule, binding };
  });
  if ([5158, 5201].includes(instance.sourceDungeonID)) {
    for (const chain of policy.mechanics.logistics?.chains || []) {
      if (chain.initialState !== "hostile") continue;
      const binding = policy.mechanics.objectBindings[chain.initialObjectID];
      if (binding?.typeID !== 3509 || chain.hostileDestroyed?.replacementTypeID !== 3261) fail("INCURSION_STRUCTURE_POLICY_INVALID");
      rules.push({ objective: { key: `${chain.key}:health`, kind: "auxiliary", roomKey: binding.roomKey, nativeObjectID: binding.objectID },
        rule: { damageable: true }, binding });
    }
    if (rules.length !== 2) fail("INCURSION_STRUCTURE_POLICY_INVALID");
  } else if (rules.length !== 1) fail("INCURSION_STRUCTURE_POLICY_INVALID");
  return { policy, rules };
}
function operationFor(instance) { return store.getOperation(require("./incursionAdmission").operationIdentity(instance).operationID); }
function enabled(operation, rule) {
  return !rule.enabledWhen || require("./incursionSiteMechanics").evaluate(operation, rule.enabledWhen);
}
function propFor(instance, operation) {
  const ctx = context(instance);
  if (!ctx || !operation || operation.status !== "active" || ctx.rules[0].objective.kind !== "structure") return null;
  const { rule, binding } = ctx.rules[0];
  let selected = binding, phase = "health";
  if (!enabled(operation, rule)) {
    const scenery = ctx.policy.mechanics.objectives.filter(row => row.role === "environment" && row.enabledWhen && enabled(operation, row));
    if (scenery.length !== 1) return null;
    selected = ctx.policy.mechanics.objectBindings[scenery[0].nativeObjectID]; phase = "scenery";
    if (!selected || selected.typeID !== scenery[0].typeID) fail("INCURSION_STRUCTURE_POLICY_INVALID");
  }
  return { key: `incursion-structure:${rule.key}`, exact: true, typeID: selected.typeID, roomKey: selected.roomKey,
    ownerID: ctx.policy.mechanics.actorCorporationID, dunObjectID: selected.objectID, dunObjectNameID: selected.nameID,
    positionOffset: structuredClone(selected.positionOffset), ...(selected.dunRotation ? { dunRotation: structuredClone(selected.dunRotation) } : {}),
    suppressSlimName: true, legacyEnvironmentOrdinal: 600, incursionStructurePhase: phase };
}
function projectPopulationHints(instance, hints) {
  if (!context(instance)) return hints;
  const prop = propFor(instance, operationFor(instance));
  const props = (hints.environmentProps || []).filter(row => !row.key?.startsWith("incursion-structure:"));
  if (prop) props.push(prop);
  return { ...hints, environmentProps: props, exactContentCaps: { ...hints.exactContentCaps,
    environmentProps: (hints.exactContentCaps?.environmentProps ?? hints.environmentProps?.length ?? 0) + props.length - (hints.environmentProps?.length || 0) } };
}
function save(instanceID, journal) {
  return runtime().mergeSpawnState(instanceID, { incursionStructures: journal }, { durable: true, force: true });
}
function health(value) {
  if (!value || !["shieldCharge", "armorDamage", "damage"].every(key => Number.isFinite(value[key]) && value[key] >= 0 && value[key] <= 1)) {
    fail("INCURSION_STRUCTURE_HEALTH_INVALID");
  }
  return { shieldCharge: value.shieldCharge, armorDamage: value.armorDamage, damage: value.damage };
}
function validateTarget(instance, operation, key, target) {
  const row = context(instance)?.rules.find(row => row.objective.key === key);
  if (!row || target.version !== VERSION || target.instanceID !== instance.instanceID ||
      target.operationID !== operation.identity.operationID || target.policyFingerprint !== operation.policyFingerprint ||
      target.key !== key || !positive(target.entityID) || target.typeID !== row.binding.typeID ||
      target.ownerID !== operation.policy.mechanics.actorCorporationID ||
      target.nativeObjectID !== row.binding.objectID || target.roomKey !== row.binding.roomKey ||
      !["shieldCapacity", "armorHP", "structureHP"].every(field => Number.isFinite(target.maximum[field]) && target.maximum[field] >= 0) ||
      !(target.maximum.structureHP > 0) || !Number.isSafeInteger(target.sequence) || target.sequence < 0 ||
      Object.keys(target.events).length !== target.sequence) fail("INCURSION_STRUCTURE_TARGET_INVALID");
  health(target.conditionState);
  if (target.action) {
    if (instance.sourceDungeonID !== 5165 || target.action.kind !== "ore-sabotage") fail("INCURSION_SABOTAGE_CAUSE_INVALID");
    const cause = require("./incursionCargo").objectiveProof(instance, operation, "ore-refinery");
    if (!cause || cause.proof !== target.action.cargoProof || fingerprint(cause.snapshot) !== fingerprint(target.action.snapshot)) {
      fail("INCURSION_SABOTAGE_CAUSE_INVALID");
    }
  }
  let prior = { shieldCharge: target.maximum.shieldCapacity > 0 ? 1 : 0, armorDamage: 0, damage: 0 };
  const receipts = Object.entries(target.events).sort((a, b) => a[1].event.sequence - b[1].event.sequence);
  let previousRepairAtMs = 0;
  const repairBindings = receipts.some(([, receipt]) => receipt.event.kind === "repair")
    ? require("./incursionStructureRepair").bindings(instance) : null;
  for (const [index, [eventID, receipt]] of receipts.entries()) {
    const event = receipt.event, after = health(receipt.after), before = health(receipt.before);
    const repair = event.kind === "repair";
    const amount = repair ? (after.shieldCharge - before.shieldCharge) * target.maximum.shieldCapacity : (before.shieldCharge - after.shieldCharge) * target.maximum.shieldCapacity +
      (after.armorDamage - before.armorDamage) * target.maximum.armorHP + (after.damage - before.damage) * target.maximum.structureHP;
    if (eventID !== `incursion-structure:${instance.instanceID}:${key}:${index + 1}` || event.eventID !== eventID ||
        event.sequence !== index + 1 || event.operationID !== operation.identity.operationID || event.instanceID !== instance.instanceID ||
        event.targetKind !== "structure" || !["damage", "repair"].includes(event.kind) || event.targetKey !== key || event.targetEntityID !== target.entityID ||
        event.targetTypeID !== target.typeID || !positive(event.atMs) || typeof receipt.acknowledged !== "boolean" ||
        ![event.characterID, event.fleetID, event.sourceShipID, event.moduleID, event.targetCharacterID].every(value => Number.isSafeInteger(value) && value >= 0) ||
        (!event.characterID && event.fleetID) || event.targetCharacterID !== 0 || before.damage >= 1 ||
        fingerprint(prior) !== fingerprint(before) || !(amount > 0) || Math.abs(amount - event.amount) > Math.max(1e-6, amount * 1e-9) ||
        event.destroyed !== (after.damage >= 1) ||
        (repair ? instance.sourceDungeonID !== 5175 || after.armorDamage !== before.armorDamage || after.damage !== before.damage ||
          Math.abs(after.shieldCharge - Math.min(1, before.shieldCharge + 0.5)) > 1e-12
          : after.shieldCharge > before.shieldCharge || after.armorDamage < before.armorDamage || after.damage < before.damage ||
            (instance.sourceDungeonID === 5165 ? event.cause !== "ore-sabotage" || !target.action || event.characterID !== 0
              : event.cause !== "combat"))) fail("INCURSION_STRUCTURE_OUTCOME_INVALID");
    if (repair) {
      require("./incursionStructureRepair").validateEvent(instance, operation, target, event, previousRepairAtMs, repairBindings);
      previousRepairAtMs = event.atMs;
    }
    if (event.destroyed) {
      const snapshot = event.snapshot;
      if (!snapshot || !positive(snapshot.atMs) || snapshot.atMs > clock.now() || !Array.isArray(snapshot.presence) ||
          snapshot.presence.some(row => !positive(row.characterID) || !positive(row.groupID) || !Number.isSafeInteger(row.fleetID) || row.fleetID < 0 ||
            typeof row.activeShip !== "boolean" || typeof row.cloaked !== "boolean")) fail("INCURSION_STRUCTURE_SNAPSHOT_INVALID");
      require("../inventory/incursionCombatOutcomes").normalizeCompletionTaxProfiles(snapshot.taxProfiles, snapshot.presence);
      if (instance.sourceDungeonID === 5175) {
        const paid = require("./incursionCargo").consumptionFacts(instance, operation, "shield-control").filter(receipt => receipt.atMs <= snapshot.atMs);
        if (fingerprint(event.cargoReceipts || []) !== fingerprint(paid)) fail("INCURSION_TCRC_FATAL_CARGO_PROOF_INVALID");
      }
      if (target.action && fingerprint(target.action.snapshot) !== fingerprint(snapshot)) fail("INCURSION_SABOTAGE_CAUSE_INVALID");
    }
    prior = after;
  }
  if (fingerprint(prior) !== fingerprint(target.conditionState)) fail("INCURSION_STRUCTURE_OUTCOME_INVALID");
  return row;
}
function describe(instance, prop) { return require("../dungeon/dungeonUniverseSiteService").incursionStructurePorts.describe(instance, prop); }
function ensureTarget(instance, operation, row, entity) {
  const current = runtime().getInstance(instance.instanceID) || instance, journal = structuredClone(journalOf(current));
  let record = journal.targets[row.objective.key];
  if (!record) {
    record = { version: VERSION, instanceID: instance.instanceID, operationID: operation.identity.operationID,
      policyFingerprint: operation.policyFingerprint, key: row.objective.key, entityID: Number(entity.itemID),
      ownerID: operation.policy.mechanics.actorCorporationID,
      typeID: Number(entity.typeID), nativeObjectID: row.binding.objectID, roomKey: row.binding.roomKey,
      maximum: Object.fromEntries(["shieldCapacity", "armorHP", "structureHP"].map(key => [key, Number(entity[key])])),
      conditionState: health(entity.conditionState), sequence: 0, events: {}, action: null };
    journal.targets[row.objective.key] = record;
  }
  validateTarget(instance, operation, row.objective.key, record);
  if (record.entityID !== Number(entity.itemID) || record.typeID !== Number(entity.typeID) || entity.dunObjectID !== record.nativeObjectID || entity.ownerID !== record.ownerID) {
    fail("INCURSION_STRUCTURE_BINDING_MISMATCH");
  }
  // Fence cached births too: a prior flush refusal is not a durable identity.
  const persisted = journalOf(runtime().getPersistedInstance(instance.instanceID)).targets[row.objective.key];
  if (!persisted || fingerprint(persisted) !== fingerprint(record)) save(instance.instanceID, journal);
  return record;
}
function prepareEntity(instance, entity) {
  if (!entity?.dungeonEnvironmentKey?.startsWith("incursion-structure:")) return entity;
  const ctx = context(instance), operation = operationFor(instance), prop = propFor(instance, operation);
  if (!ctx || !prop || entity.dungeonEnvironmentKey !== prop.key || entity.typeID !== prop.typeID || entity.dunObjectID !== prop.dunObjectID) return null;
  const row = ctx.rules[0];
  Object.assign(entity, { incursionOperationID: operation.identity.operationID,
    incursionStructureObjectiveKey: row.objective.key, incursionStructurePhase: prop.incursionStructurePhase,
    dungeonSiteContentKey: prop.key });
  if (prop.incursionStructurePhase === "scenery") return entity;
  const record = ensureTarget(instance, operation, row, entity);
  if (record.conditionState.damage >= 1) return null;
  return Object.assign(entity, record.maximum, { kind: "siteKillableStructure", runtimeKind: "missionCombatStructure",
    dungeonMaterializedKillableStructure: true, conditionState: structuredClone(record.conditionState) });
}
function prepareAuxiliaryEntity(instance, entity, key) {
  const operation = operationFor(instance), row = context(instance)?.rules.find(row => row.objective.key === key && row.objective.kind === "auxiliary");
  if (!operation || !row || entity.typeID !== row.binding.typeID || entity.dunObjectID !== row.binding.objectID) fail("INCURSION_STRUCTURE_BINDING_MISMATCH");
  const record = ensureTarget(instance, operation, row, entity);
  if (record.conditionState.damage >= 1) return null;
  return Object.assign(entity, record.maximum, { kind: "siteKillableStructure", runtimeKind: "missionCombatStructure",
    dungeonMaterializedKillableStructure: true, incursionOperationID: operation.identity.operationID,
    incursionStructureObjectiveKey: key, incursionStructurePhase: "health", conditionState: structuredClone(record.conditionState) });
}
function canDamage(target) {
  if (!target?.incursionStructureObjectiveKey) return true;
  const instance = runtime().getInstance(target.dungeonSiteInstanceID), ctx = context(instance), operation = ctx && operationFor(instance);
  const row = ctx?.rules.find(row => row.objective.key === target.incursionStructureObjectiveKey);
  return Boolean(row && operation?.status === "active" && target.incursionStructurePhase === "health" &&
    target.typeID === row.binding.typeID && target.dunObjectID === row.binding.objectID && row.rule.ordinaryPlayerDamageAllowed !== false &&
    target.ownerID === operation.policy.mechanics.actorCorporationID &&
    enabled(operation, row.rule) && (row.objective.kind !== "auxiliary" || operation.policy.stages.every(stage =>
      operation.stages[stage.key].active && stage.actors.every(actor => operation.births[actor.key]))));
}
function completionSnapshot(scene, instance) {
  const presence = require("./incursionEncounterRuntime").presence(scene, instance);
  return { atMs: clock.now(), presence, taxProfiles: Object.fromEntries(presence.map(row => [row.characterID,
    require("../corporation/corporationTax").resolveCorporationTaxProfile(row.characterID)])) };
}
function assertOpen(instance, operation) {
  if (operation.status !== "active") fail("INCURSION_STRUCTURE_NOT_ACTIVE");
  require("./incursionTerminalContract").assertCompletionOpen(operation.identity, clock.now());
  const id = { ...instance.metadata.incursionAdmission, instanceID: instance.instanceID, solarSystemID: instance.solarSystemID };
  const lifecycle = require("./incursionLifecycle");
  if (operation.identity.placement === "tale-final") lifecycle.finalAdmission(id, clock.now()); else lifecycle.siteAdmission(id, clock.now());
}
function commitDamage(scene, source, entity, damageResult, previousConditionState, whenMs) {
  let attempted = false;
  try {
    const instance = runtime().getInstance(entity.dungeonSiteInstanceID), ctx = context(instance), operation = ctx && operationFor(instance);
    const row = ctx?.rules.find(row => row.objective.key === entity.incursionStructureObjectiveKey), authored = sabotage.get(entity);
    if (!row || !operation || entity.incursionOperationID !== operation.identity.operationID ||
        (!authored && (!canDamage(entity) || scene?.getEntityByID(entity.itemID) !== entity))) fail("INCURSION_STRUCTURE_DAMAGE_INVALID");
    assertOpen(instance, operation);
    const journal = structuredClone(journalOf(runtime().getInstance(instance.instanceID))), record = journal.targets[row.objective.key];
    validateTarget(instance, operation, row.objective.key, record);
    if (record.entityID !== entity.itemID || fingerprint(health(previousConditionState)) !== fingerprint(record.conditionState) ||
        record.conditionState.damage >= 1 || record.sequence >= 65536) fail("INCURSION_STRUCTURE_DAMAGE_CONFLICT");
    const after = health(entity.conditionState), before = record.conditionState;
    const amount = (before.shieldCharge - after.shieldCharge) * record.maximum.shieldCapacity +
      (after.armorDamage - before.armorDamage) * record.maximum.armorHP + (after.damage - before.damage) * record.maximum.structureHP;
    const applied = require("../../space/runtime/combatDamageMessages").getAppliedDamageAmount(damageResult);
    if (!(amount > 0) || Math.abs(amount - applied) > Math.max(1e-6, amount * 1e-9) ||
        after.shieldCharge > before.shieldCharge || after.armorDamage < before.armorDamage || after.damage < before.damage ||
        damageResult.data.destroyed !== (after.damage >= 1)) fail("INCURSION_STRUCTURE_DAMAGE_AMOUNT_INVALID");
    const pilot = !authored && require("./incursionEncounterRuntime").sourcePilot(scene, instance, source);
    if (pilot && scene.getEntityByID(pilot.sourceShipID)?.dungeonCurrentRoomKey !== row.binding.roomKey) fail("INCURSION_STRUCTURE_DAMAGE_SCOPE");
    const eventID = `incursion-structure:${instance.instanceID}:${row.objective.key}:${record.sequence + 1}`;
    const event = { eventID, sequence: record.sequence + 1, operationID: operation.identity.operationID, kind: "damage", targetKind: "structure",
      instanceID: instance.instanceID, characterID: pilot?.characterID || 0, fleetID: pilot?.fleetID || 0,
      amount, targetKey: row.objective.key, targetEntityID: record.entityID, targetTypeID: record.typeID,
      targetCharacterID: 0, sourceShipID: pilot?.sourceShipID || 0, moduleID: 0,
      atMs: Math.max(1, Math.trunc(whenMs)), destroyed: after.damage >= 1, cause: authored ? "ore-sabotage" : "combat",
      ...(after.damage >= 1 ? { snapshot: structuredClone(authored?.snapshot || completionSnapshot(scene, instance)) } : {}) };
    if (instance.sourceDungeonID === 5175 && event.destroyed) event.cargoReceipts = require("./incursionCargo").consumptionFacts(
      instance, operation, "shield-control").filter(receipt => receipt.atMs <= event.snapshot.atMs);
    record.conditionState = after; record.sequence++;
    record.events[eventID] = { event, before: structuredClone(before), after: structuredClone(after), acknowledged: false };
    attempted = true; save(instance.instanceID, journal);
    return { success: true, handled: true, durable: true, accepted: true, pending: false };
  } catch (error) {
    entity.conditionState = structuredClone(previousConditionState);
    if (attempted) entity.incursionHealthPending = true;
    return { success: false, handled: true, pending: attempted, errorMsg: error.message };
  }
}
function reserveSabotage(instance, operation, row, record) {
  if (instance.sourceDungeonID !== 5165 || record.conditionState.damage >= 1) return record;
  const cargo = require("./incursionCargo").objectiveProof(instance, operation, "ore-refinery");
  if (!cargo) return record;
  const action = { kind: "ore-sabotage", cargoProof: cargo.proof, snapshot: cargo.snapshot };
  if (record.action && fingerprint(record.action) !== fingerprint(action)) fail("INCURSION_SABOTAGE_CAUSE_CONFLICT");
  if (!record.action) {
    const journal = structuredClone(journalOf(runtime().getInstance(instance.instanceID)));
    journal.targets[row.objective.key].action = action; save(instance.instanceID, journal);
  }
  return journalOf(runtime().getPersistedInstance(instance.instanceID)).targets[row.objective.key];
}
function loadedScene(instance) { return require.cache[require.resolve("../../space/runtime")]?.exports?.scenes?.get(instance.solarSystemID) || null; }
function objectiveFact(row, receipt) {
  const { event, before, after } = receipt;
  return { receiptID: event.eventID, objectiveKey: row.objective.key, kind: "structure", roomKey: row.objective.roomKey,
    quantity: 1, reason: "destroyed", cause: event.cause, proof: fingerprint({ event, before, after }) };
}
function projectOutcome(instance, operation, record, receipt) {
  const { event } = receipt, row = validateTarget(instance, operation, record.key, record);
  let next = model.recordStructureBirth(operation, { key: record.key, entityID: record.entityID, typeID: record.typeID, nativeObjectID: record.nativeObjectID });
  next = model.recordContribution(next, event);
  if (event.destroyed) {
    next.mechanics.healthReceipts ||= {}; next.mechanics.healthReceipts[row.objective.key] = { receiptID: event.eventID, reason: "destroyed", cause: event.cause };
    if (row.objective.kind === "auxiliary") return store.saveOperation(next);
    const fact = objectiveFact(row, receipt);
    if (instance.sourceDungeonID === 5175 && !event.cargoReceipts?.length) {
      next.status = "retired";
      next.failure = { version: 1, kind: "premature-terminal-death", eventID: event.eventID, atMs: event.snapshot.atMs,
        proof: fingerprint({ event, before: receipt.before, after: receipt.after }) };
      return store.saveOperation(next);
    }
    next = model.recordObjective(next, fact);
    if (next.status === "ready") {
      next = model.finalize(next, event.snapshot.presence, event.snapshot.atMs); next.completion.taxProfiles = event.snapshot.taxProfiles;
      require("./incursionRewards").sealCompletion({ completedOperation: next, recipients: next.completion.recipients, completedAtMs: event.snapshot.atMs });
      return store.getOperation(next.identity.operationID);
    }
  }
  return store.saveOperation(next);
}
function reconcile(instance, previous, { closed = false } = {}) {
  const ctx = context(instance);
  if (!ctx || !previous) return previous;
  if (active.has(instance.instanceID)) return store.getOperation(previous.identity.operationID) || previous;
  active.add(instance.instanceID);
  try {
    let operation = store.getOperation(previous.identity.operationID) || previous;
    const row = ctx.rules[0], scene = loadedScene(instance);
    if (!closed && row.objective.kind === "structure" && operation.status === "active" && enabled(operation, row.rule)) {
      assertOpen(instance, operation);
      const prop = propFor(instance, operation), descriptor = describe(instance, prop);
      let record = ensureTarget(instance, operation, row, descriptor);
      record = reserveSabotage(instance, operation, row, record);
      if (record.action && record.conditionState.damage < 1) {
        if (scene) {
          const live = scene.getEntityByID(record.entityID);
          if (live?.typeID !== record.typeID || live?.dunObjectID !== record.nativeObjectID || live?.incursionStructurePhase !== "health") {
            require("../dungeon/dungeonUniverseSiteService").incursionStructurePorts.materialize(scene, instance);
          }
        }
        const target = scene ? scene.getEntityByID(record.entityID) : prepareEntity(instance, descriptor);
        if (!target || target.incursionStructurePhase !== "health") fail("INCURSION_SABOTAGE_TARGET_MISSING");
        const before = structuredClone(record.conditionState); target.conditionState = structuredClone(before);
        sabotage.set(target, record.action);
        try {
          const result = require("../../space/combat/damage").applyResolvedDamageAmountToEntity(target,
            record.maximum.shieldCapacity + record.maximum.armorHP + record.maximum.structureHP);
          checked(result); checked(commitDamage(scene, null, target, result, before, record.action.snapshot.atMs));
        } finally { sabotage.delete(target); }
      }
    }
    const current = runtime().getInstance(instance.instanceID) || instance, journal = structuredClone(journalOf(current));
    if (fingerprint(journalOf(runtime().getPersistedInstance(instance.instanceID))) !== fingerprint(journal)) save(instance.instanceID, journal);
    for (const [key, record] of Object.entries(journal.targets)) {
      const targetRule = validateTarget(instance, operation, key, record);
      const entity = scene?.getEntityByID(record.entityID);
      if (entity && require("./incursionHooks").isDamageInProgress(entity)) continue;
      if (entity?.incursionStructureObjectiveKey === key && entity.typeID === record.typeID && entity.dunObjectID === record.nativeObjectID &&
          entity.incursionStructurePhase === "health") {
        const changed = entity.incursionHealthPending || fingerprint(health(entity.conditionState)) !== fingerprint(record.conditionState);
        entity.conditionState = structuredClone(record.conditionState); delete entity.incursionHealthPending;
        if (changed) require("../../space/runtime/shipHealthState").broadcastDamageStateChange(scene, entity, clock.now());
        if (record.conditionState.damage >= 1) checked(require("../../space/runtime/combatDestruction").destroyCombatEntity(scene, entity,
          { destructionNowMs: clock.now(), destructionReason: "combat" }));
      }
      for (const [eventID, receipt] of Object.entries(record.events).sort((a, b) => a[1].event.sequence - b[1].event.sequence)) {
        const proof = fingerprint(receipt.event), prior = operation.events[eventID];
        if (prior && prior !== proof) fail("INCURSION_STRUCTURE_OUTCOME_CONFLICT");
        if (prior && receipt.event.destroyed && targetRule.objective.kind === "structure" &&
            !(operation.failure && verifyFailure(instance, operation)) && operation.objectives[key].receipts[eventID] !== fingerprint(objectiveFact(targetRule, receipt))) {
          fail("INCURSION_STRUCTURE_OUTCOME_CONFLICT");
        }
        if (receipt.acknowledged) {
          if (!prior && store.read(`/terminalOutcomes/${operation.identity.operationID}`)?.[eventID]?.proof !== proof) fail("INCURSION_STRUCTURE_ACK_WITHOUT_OUTCOME");
          continue;
        }
        if (!prior && closed) {
          const path = `/terminalOutcomes/${operation.identity.operationID}`, outcomes = store.read(path) || {};
          if (outcomes[eventID] && outcomes[eventID].proof !== proof) fail("INCURSION_STRUCTURE_OUTCOME_CONFLICT");
          outcomes[eventID] = { proof, kind: "structure", atMs: receipt.event.atMs, targetEntityID: record.entityID, destroyed: receipt.event.destroyed };
          store.transaction([[path, outcomes]]);
        } else if (!prior) operation = projectOutcome(instance, operation, record, receipt);
        receipt.acknowledged = true; save(instance.instanceID, journal);
      }
    }
    return operation;
  } finally { active.delete(instance.instanceID); }
}
function getCommittedDeath(instance, key) {
  const operation = operationFor(instance), record = journalOf(runtime().getPersistedInstance(instance.instanceID)).targets[key];
  if (!record) return null;
  validateTarget(instance, operation, key, record);
  if (record.conditionState.damage < 1) return null;
  const receipt = Object.values(record.events).find(row => row.event.destroyed);
  if (!receipt) fail("INCURSION_STRUCTURE_OUTCOME_INVALID");
  return { eventID: receipt.event.eventID, atMs: instance.sourceDungeonID === 5175 ? receipt.event.snapshot.atMs : receipt.event.atMs, entityID: record.entityID,
    proof: fingerprint({ event: receipt.event, before: receipt.before, after: receipt.after }) };
}
function commitShieldRepair(request, scene, target, calculate) {
  let attempted = false;
  try {
    const instance = runtime().getInstance(request?.instanceID), operation = instance && operationFor(instance);
    const controller = require("./incursionStructureRepair"), spec = controller.spec(instance);
    if (!spec || !operation || request.version !== controller.VERSION || request.operationID !== operation.identity.operationID ||
        request.targetKey !== spec.key) fail("INCURSION_TCRC_REPAIR_REQUEST_INVALID");
    const journal = structuredClone(journalOf(runtime().getInstance(instance.instanceID))), record = journal.targets[request.targetKey];
    validateTarget(instance, operation, request.targetKey, record);
    if (request.targetEntityID !== record.entityID || request.targetTypeID !== record.typeID) fail("INCURSION_TCRC_REPAIR_REQUEST_INVALID");
    const eventID = `incursion-structure:${instance.instanceID}:${record.key}:${request.sequence}`;
    const repair = { version: request.version, sourceProof: request.sourceProof, maximumAmount: request.maximumAmount,
      consumptions: structuredClone(request.consumptions) };
    const existing = record.events[eventID];
    if (existing) {
      if (existing.event.kind !== "repair" || existing.event.atMs !== request.atMs || fingerprint(existing.event.repair) !== fingerprint(repair))
        fail("INCURSION_TCRC_REPAIR_REQUEST_CONFLICT");
      save(instance.instanceID, journal);
      return { success: true, accepted: true, durable: true, duplicate: true, receipt: existing, conditionState: structuredClone(record.conditionState) };
    }
    assertOpen(instance, operation);
    if (request.sequence !== record.sequence + 1 || record.sequence >= 65536 || request.atMs > clock.now() || clock.now() >= request.atMs + spec.periodMs ||
        !controller.eligible(instance, operation, record, scene, controller.bindings(instance, spec)) ||
        fingerprint(request.consumptions) !== fingerprint(controller.facts(instance, operation)) || !controller.unsuppressed(request.consumptions, request.atMs))
      return { success: true, skipped: true };
    const changed = calculate();
    if (!changed || changed.skipped) return { success: true, skipped: true };
    const before = health(changed.before), after = health(changed.after), amount = (after.shieldCharge - before.shieldCharge) * record.maximum.shieldCapacity;
    if (fingerprint(before) !== fingerprint(record.conditionState) || !(amount > 0) || !Number.isFinite(changed.amount) ||
        Math.abs(amount - changed.amount) > 1e-6 || after.armorDamage !== before.armorDamage || after.damage !== before.damage ||
        Math.abs(after.shieldCharge - Math.min(1, before.shieldCharge + 0.5)) > 1e-12) fail("INCURSION_TCRC_REPAIR_AMOUNT_INVALID");
    const event = { eventID, sequence: request.sequence, operationID: operation.identity.operationID, instanceID: instance.instanceID,
      targetKind: "structure", kind: "repair", targetKey: record.key, targetEntityID: record.entityID, targetTypeID: record.typeID,
      characterID: 0, fleetID: 0, sourceShipID: 0, moduleID: 0, targetCharacterID: 0, atMs: request.atMs,
      amount, destroyed: false, cause: "tcrc-shield-links", repair };
    record.events[eventID] = { event, before, after, acknowledged: false }; record.sequence++; record.conditionState = after;
    validateTarget(instance, operation, record.key, record);
    attempted = true; save(instance.instanceID, journal);
    return { success: true, accepted: true, durable: true, duplicate: false, receipt: structuredClone(record.events[eventID]), conditionState: structuredClone(after) };
  } catch (error) {
    if (attempted && target) target.incursionHealthPending = true;
    return { success: false, accepted: false, pending: attempted, errorMsg: error.message };
  }
}
function tickRepairs(scene, instance, operation) {
  const controller = require("./incursionStructureRepair"), spec = controller.spec(instance);
  if (!spec || operation.status !== "active") return;
  const record = journalOf(runtime().getInstance(instance.instanceID)).targets[spec.key];
  if (!record) return;
  validateTarget(instance, operation, spec.key, record);
  const request = controller.request(instance, operation, record, scene);
  if (!request) return;
  const result = require("../../space/modules/assistanceModuleRuntime").applyIncursionStructureShieldPulse({ request, scene,
    target: scene.getEntityByID(record.entityID) });
  checked(result);
  if (result.accepted && result.durable) reconcile(instance, operation);
}
function verifyFailure(instance, operation) {
  const failure = operation.failure, death = getCommittedDeath(instance, "research-center");
  const record = journalOf(runtime().getPersistedInstance(instance.instanceID)).targets["research-center"];
  const receipt = record && Object.values(record.events).find(row => row.event.destroyed);
  if (instance.sourceDungeonID !== 5175 || operation.status !== "retired" || failure?.version !== 1 ||
      failure.kind !== "premature-terminal-death" || !death || death.eventID !== failure.eventID || death.atMs !== failure.atMs ||
      death.proof !== failure.proof || receipt.event.cargoReceipts?.length) fail("INCURSION_SITE_FAILURE_PROOF_INVALID");
  return true;
}
function beforePurge(instance) {
  if (!instance || !Object.keys(journalOf(instance).targets).length) return;
  const operation = operationFor(instance);
  if (!operation) fail("INCURSION_STRUCTURE_OPERATION_MISSING");
  reconcile(instance, operation, { closed: true });
}
module.exports = { VERSION, projectPopulationHints, prepareEntity, prepareAuxiliaryEntity, canDamage, commitDamage, reconcile, beforePurge,
  getCommittedDeath, verifyFailure, commitShieldRepair, tickRepairs };
