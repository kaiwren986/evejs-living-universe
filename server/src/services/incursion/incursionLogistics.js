"use strict";

// Normal analyzer outcomes drive these reviewed controls. A content generation
// owns one hacking opportunity; a delivered receipt never rearms that generation.
const { fingerprint, fail } = require("./incursionLifecycleContract");
const clock = require("./incursionClock");
const store = require("./incursionRewardStore");
const model = require("./incursionSiteModel");
const VERSION = "evejs.incursion-logistics.v1", prepared = new WeakSet(), active = new Set();
const runtime = () => require("../dungeon/dungeonRuntime");
const positive = value => Number.isSafeInteger(value) && value > 0;
const contentKey = (key, generation) => `incursion-hack:${key}:${generation}`;
const propKey = key => `incursion-control:${key}`;
function context(instance) {
  if (instance?.runtimeFlags?.incursionRuntime !== true || ![5164, 5158, 5201].includes(instance.sourceDungeonID)) return null;
  const policy = require("./incursionAdmission").admittedPolicy(instance);
  if (policy?.version !== 2) return null;
  const controls = policy.objectives.filter(objective => objective.kind === "hack").map((objective, index) => {
    const rule = policy.mechanics.objectives.find(row => row.key === objective.key && row.role === "optional-hack");
    const chain = policy.mechanics.logistics?.chains?.find(row => row.key === rule?.chainKey);
    const objectIDs = rule?.activeNativeObjectCycle || [rule?.nativeObjectID];
    if (!rule || rule.interactiveTypeID !== 3261 || objective.repeatable !== true || !objectIDs.length ||
        objectIDs.some(id => !positive(id) || !policy.mechanics.objectBindings[id]) ||
        (chain ? chain.initialObjectID !== rule.nativeObjectID || chain.neutralHacked?.durationMs !== 60000 ||
          !policy.mechanics.objectBindings[chain.stationObjectID] : rule.hacking?.suppressionDurationMs !== 360000)) fail("INCURSION_LOGISTICS_POLICY_INVALID");
    return { key: chain?.key || rule.key, objective, rule, chain, objectIDs, ordinal: 700 + index };
  });
  if (controls.length !== (instance.sourceDungeonID === 5164 ? 1 : 3)) fail("INCURSION_LOGISTICS_POLICY_INVALID");
  const stationObjectIDs = instance.sourceDungeonID === 5164
    ? [policy.mechanics.objectives.find(row => row.key === "remote-logistics-station")?.nativeObjectID]
    : controls.map(spec => spec.chain.stationObjectID);
  return { policy, controls, stationObjectIDs };
}
function operationFor(instance) { return store.getOperation(require("./incursionAdmission").operationIdentity(instance).operationID); }
function journalOf(instance) { return instance?.spawnState?.incursionLogistics || null; }
function save(instanceID, journal) {
  return runtime().mergeSpawnState(instanceID, { incursionLogistics: journal }, { durable: true, force: true });
}
function validate(instance, operation, journal) {
  const ctx = context(instance);
  if (!ctx || journal?.version !== VERSION || journal.operationID !== operation.identity.operationID ||
      journal.policyFingerprint !== operation.policyFingerprint || Object.keys(journal.controls || {}).length !== ctx.controls.length ||
      !journal.wins || Object.keys(journal.wins).length > 65536) fail("INCURSION_LOGISTICS_STATE_INVALID");
  for (const spec of ctx.controls) {
    const row = journal.controls[spec.key];
    if (!row || row.key !== spec.key || !Number.isSafeInteger(row.generation) || row.generation < 0 || row.generation > 65536 ||
        !["hostile", "neutral", "friendly"].includes(row.phase) ||
        (!spec.chain && row.phase !== "neutral") || (row.phase === "hostile" && (spec.chain?.initialState !== "hostile" || row.generation !== 0)) ||
        !Number.isSafeInteger(row.suppressedUntilMs) || row.suppressedUntilMs < 0 ||
        !Number.isSafeInteger(row.friendlyUntilMs) || row.friendlyUntilMs < 0 ||
        (row.phase === "friendly" && (!positive(row.friendlyUntilMs) || !row.lastWinID))) fail("INCURSION_LOGISTICS_STATE_INVALID");
    const wins = Object.entries(journal.wins).filter(([, win]) => win.controlKey === spec.key).sort((a, b) => a[1].generation - b[1].generation);
    let base = 0;
    if (spec.chain?.initialState === "hostile" && row.phase !== "hostile") {
      const death = require("./incursionStructures").getCommittedDeath(instance, `${spec.key}:health`);
      if (!death || fingerprint(death) !== fingerprint(row.death)) fail("INCURSION_LOGISTICS_DEATH_PROOF_REQUIRED");
      base = 1;
    }
    let deadline = 0;
    for (const [index, [id, win]] of wins.entries()) {
      const record = runtime().getPersistedInstance(instance.instanceID)?.spawnState?.hackingContainers?.[win.contentKey];
      const receipt = record?.outcomes?.[win.outcomeID];
      if (!receipt || win.generation !== base + index) fail("INCURSION_LOGISTICS_WIN_PROOF_REQUIRED");
      const verified = validateReceipt(instance, operation, record, receipt);
      if (verified.id !== id || fingerprint(win) !== fingerprint({ ...receipt.incursionWin, proof: verified.proof })) fail("INCURSION_LOGISTICS_WIN_PROOF_REQUIRED");
      deadline = spec.chain ? win.atMs + 60000 : Math.max(deadline, win.atMs + 360000);
    }
    if (row.lastWinID !== (wins.at(-1)?.[0] || null) ||
        row.generation !== base + wins.length - (row.phase === "friendly" ? 1 : 0) ||
        (spec.chain ? row.friendlyUntilMs !== deadline || row.suppressedUntilMs !== 0 ||
          row.phase === "neutral" && wins.length > 0 && clock.now() < deadline
          : row.suppressedUntilMs !== deadline || row.friendlyUntilMs !== 0)) fail("INCURSION_LOGISTICS_DEADLINE_CONFLICT");
  }
  if (Object.values(journal.wins).some(win => !ctx.controls.some(spec => spec.key === win.controlKey))) fail("INCURSION_LOGISTICS_STATE_INVALID");
  return ctx;
}
function ensure(instance, operation) {
  const ctx = context(instance);
  if (!ctx || !operation) return null;
  let journal = journalOf(runtime().getInstance(instance.instanceID) || instance);
  if (!journal) {
    if (operation.status !== "active") return null;
    journal = { version: VERSION, operationID: operation.identity.operationID, policyFingerprint: operation.policyFingerprint,
      wins: {}, controls: Object.fromEntries(ctx.controls.map(spec => [spec.key, { key: spec.key, generation: 0,
        phase: spec.chain?.initialState || "neutral", suppressedUntilMs: 0, friendlyUntilMs: 0, lastWinID: null }])) };
    save(instance.instanceID, journal);
  }
  validate(instance, operation, journal);
  const persisted = journalOf(runtime().getPersistedInstance(instance.instanceID));
  if (!persisted || fingerprint(persisted) !== fingerprint(journal)) save(instance.instanceID, journal);
  return structuredClone(journal);
}
function assertOpen(instance, operation) {
  if (!operation || operation.status !== "active") fail("INCURSION_LOGISTICS_NOT_ACTIVE");
  require("./incursionTerminalContract").assertCompletionOpen(operation.identity, clock.now());
  const id = { ...instance.metadata.incursionAdmission, instanceID: instance.instanceID, solarSystemID: instance.solarSystemID };
  const lifecycle = require("./incursionLifecycle");
  if (operation.identity.placement === "tale-final") lifecycle.finalAdmission(id, clock.now()); else lifecycle.siteAdmission(id, clock.now());
}
function selectedBinding(ctx, spec, row) {
  const id = spec.objectIDs[row.generation % spec.objectIDs.length];
  return ctx.policy.mechanics.objectBindings[id];
}
function projectPopulationHints(instance, hints) {
  const ctx = context(instance), operation = ctx && operationFor(instance), journal = operation && ensure(instance, operation);
  if (!ctx || !journal) return hints;
  const props = (hints.environmentProps || []).filter(row => !row.key?.startsWith("incursion-control:") && !row.key?.startsWith("incursion-logistics-station:"));
  if (operation.status === "active") for (const spec of ctx.controls) {
    const row = journal.controls[spec.key], binding = selectedBinding(ctx, spec, row), typeID = row.phase === "hostile" ? binding.typeID : 3261;
    props.push({ key: propKey(spec.key), exact: true, typeID, roomKey: binding.roomKey, ownerID: ctx.policy.mechanics.actorCorporationID,
      dunObjectID: binding.objectID, dunObjectNameID: binding.nameID, positionOffset: structuredClone(binding.positionOffset),
      ...(binding.dunRotation ? { dunRotation: structuredClone(binding.dunRotation) } : {}),
      suppressSlimName: true, legacyEnvironmentOrdinal: spec.ordinal });
  }
  if (operation.status === "active") for (const [index, id] of ctx.stationObjectIDs.entries()) {
    const binding = ctx.policy.mechanics.objectBindings[id];
    if (binding?.typeID !== 3510) fail("INCURSION_LOGISTICS_POLICY_INVALID");
    props.push({ key: `incursion-logistics-station:${id}`, exact: true, typeID: 3510, roomKey: binding.roomKey,
      ownerID: ctx.policy.mechanics.actorCorporationID, dunObjectID: id, dunObjectNameID: binding.nameID,
      positionOffset: structuredClone(binding.positionOffset), ...(binding.dunRotation ? { dunRotation: structuredClone(binding.dunRotation) } : {}),
      suppressSlimName: true, legacyEnvironmentOrdinal: 750 + index });
  }
  return { ...hints, environmentProps: props, exactContentCaps: { ...hints.exactContentCaps,
    environmentProps: (hints.exactContentCaps?.environmentProps ?? hints.environmentProps?.length ?? 0) + props.length - (hints.environmentProps?.length || 0) } };
}
function prepareEntity(instance, entity) {
  const key = entity?.dungeonEnvironmentKey;
  // The operation owns these stations. Skip their layout copies after ID
  // assignment so nearby scenery and existing repair receipts keep their IDs.
  if (entity?.typeID === 3510 && key === `native-object:${entity.dunObjectID}` &&
      context(instance)?.stationObjectIDs.includes(entity.dunObjectID)) return null;
  if (!key?.startsWith("incursion-control:") && !key?.startsWith("incursion-logistics-station:")) return entity;
  const ctx = context(instance), operation = operationFor(instance), journal = ensure(instance, operation);
  if (!ctx || !journal || operation.status !== "active") return null;
  if (key.startsWith("incursion-logistics-station:")) {
    return Object.assign(entity, { incursionLogisticsStation: true, dungeonRoomKey: ctx.policy.mechanics.objectBindings[entity.dunObjectID]?.roomKey });
  }
  const spec = ctx.controls.find(spec => propKey(spec.key) === key), row = spec && journal.controls[spec.key], binding = row && selectedBinding(ctx, spec, row);
  if (!binding || entity.dunObjectID !== binding.objectID || entity.typeID !== (row.phase === "hostile" ? binding.typeID : 3261)) fail("INCURSION_LOGISTICS_BINDING_INVALID");
  Object.assign(entity, { incursionControlKey: spec.key, incursionControlGeneration: row.generation, incursionControlPhase: row.phase,
    dungeonRoomKey: binding.roomKey, dungeonSiteContentKey: contentKey(spec.key, row.generation) });
  if (row.phase === "hostile") return require("./incursionStructures").prepareAuxiliaryEntity(instance, entity, `${spec.key}:health`);
  Object.assign(entity, { kind: "container", dungeonMaterializedContainer: true, dungeonSiteContentAnalyzer: "data",
    dungeonSiteContentRole: "incursion_control", dungeonSiteContentFailureNeverDestroys: true, dungeonSiteContentFailureLocksOut: false,
    dungeonSiteContentFailureExplodes: false, dungeonSourceObjectID: binding.objectID,
    dungeonSiteContentHackingDifficulty: 3 });
  require("../exploration/hackingContainerState").restore(entity, { instance: runtime().getInstance(instance.instanceID), nowMs: clock.now() });
  return entity;
}
function canHack(scene, ship, entity) {
  if (!entity?.incursionControlKey) return true;
  try {
    const instance = runtime().getInstance(entity.dungeonSiteInstanceID), operation = operationFor(instance), ctx = context(instance), journal = ensure(instance, operation);
    assertOpen(instance, operation);
    const spec = ctx.controls.find(spec => spec.key === entity.incursionControlKey), row = journal.controls[spec.key], binding = selectedBinding(ctx, spec, row);
    return Boolean(row.phase === "neutral" && row.generation < 65536 && row.generation === entity.incursionControlGeneration &&
      entity.typeID === 3261 && entity.dunObjectID === binding.objectID && entity.dungeonSiteContentKey === contentKey(spec.key, row.generation) &&
      scene.getEntityByID(entity.itemID) === entity && ship?.session && ship.dungeonCurrentRoomKey === binding.roomKey && Number(ship.groupID) !== 29 &&
      !ship.isCloaked && !ship.cloaked && require("./incursionEncounterRuntime").sourcePilot(scene, instance, ship));
  } catch (_) { return false; }
}
function prepareWin(attempt, session) {
  const entity = attempt?.target?.entity, scene = attempt?.target?.scene;
  if (!entity?.incursionControlKey) return null;
  const characterID = require("../_shared/sessionIdentity").resolveSessionCharacterID(session), ship = scene.getShipEntityForSession(session);
  const module = require("../inventory/itemStore").findItemById(attempt.moduleItemID), fitting = require("../fitting/liveFittingState");
  if (attempt.serverAnalyzer !== true || attempt.qa || attempt.pendingWin?.outcome !== "won" || attempt.session !== session ||
      Number(attempt.key) !== characterID || !positive(attempt.moduleItemID) || !canHack(scene, ship, entity) ||
      module?.ownerID !== characterID || module.locationID !== ship.itemID || module.typeID !== attempt.moduleTypeID ||
      attempt.shipID !== ship.itemID || !fitting.isShipFittingFlag(module.flagID) || !fitting.isEffectivelyOnlineModule(module)) fail("INCURSION_HACK_AUTHORIZATION_INVALID");
  const instance = runtime().getInstance(entity.dungeonSiteInstanceID), operation = operationFor(instance);
  const value = Object.freeze({ version: VERSION, instanceID: instance.instanceID, operationID: operation.identity.operationID,
    policyFingerprint: operation.policyFingerprint, controlKey: entity.incursionControlKey, generation: entity.incursionControlGeneration,
    contentKey: entity.dungeonSiteContentKey, sourceObjectID: entity.dunObjectID, outcomeID: attempt.outcomeID,
    characterID, moduleItemID: attempt.moduleItemID, atMs: clock.now() });
  prepared.add(value); return value;
}
function winProof(receipt) {
  return fingerprint({ outcomeID: receipt.outcomeID, outcome: receipt.outcome, atMs: receipt.atMs,
    characterID: receipt.characterID, moduleItemID: receipt.moduleItemID, incursionWin: receipt.incursionWin });
}
function validateReceipt(instance, operation, record, receipt) {
  const ctx = context(instance), win = receipt.incursionWin, spec = ctx.controls.find(row => row.key === win?.controlKey);
  if (!spec || win.version !== VERSION || win.instanceID !== instance.instanceID || win.operationID !== operation.identity.operationID ||
      win.policyFingerprint !== operation.policyFingerprint || receipt.outcome !== "won" || win.outcomeID !== receipt.outcomeID ||
      win.characterID !== receipt.characterID || win.moduleItemID !== receipt.moduleItemID || !positive(win.characterID) || !positive(win.moduleItemID) ||
      !positive(win.atMs) || win.atMs > clock.now() || !Number.isSafeInteger(win.generation) || win.generation < 0 || win.generation >= 65536 ||
      win.contentKey !== contentKey(spec.key, win.generation) || record.contentKey !== win.contentKey ||
      record.sourceObjectID !== win.sourceObjectID || win.sourceObjectID !== spec.objectIDs[win.generation % spec.objectIDs.length] || record.state !== 2) {
    fail("INCURSION_HACK_RECEIPT_INVALID");
  }
  return { ctx, spec, win, id: `${win.contentKey}:${win.outcomeID}`, proof: winProof(receipt) };
}
function consumeReceipt(instance, previous, record, receipt, closed) {
  let operation = store.getOperation(previous.identity.operationID) || previous;
  const { spec, win, id, proof } = validateReceipt(instance, operation, record, receipt);
  const journal = ensure(instance, operation);
  if (!journal) fail("INCURSION_LOGISTICS_STATE_MISSING");
  const prior = journal.wins[id];
  if (prior && prior.proof !== proof) fail("INCURSION_HACK_RECEIPT_CONFLICT");
  const fact = { receiptID: id, objectiveKey: spec.objective.key, kind: "hack", roomKey: spec.objective.roomKey, quantity: 1, proof };
  if (!closed && operation.status === "active") {
    assertOpen(instance, operation);
    if (!prior) {
      const row = journal.controls[spec.key];
      if (row.phase !== "neutral" || row.generation !== win.generation) fail("INCURSION_HACK_GENERATION_CONFLICT");
      journal.wins[id] = { ...win, proof };
      row.lastWinID = id;
      if (spec.chain) { row.phase = "friendly"; row.friendlyUntilMs = win.atMs + spec.chain.neutralHacked.durationMs; }
      else { row.generation++; row.suppressedUntilMs = Math.max(row.suppressedUntilMs, win.atMs + spec.rule.hacking.suppressionDurationMs); }
      save(instance.instanceID, journal);
    }
    if (!operation.objectives[spec.objective.key].receipts[id]) operation = store.saveOperation(model.recordObjective(operation, fact));
    else if (operation.objectives[spec.objective.key].receipts[id] !== fingerprint(fact)) fail("INCURSION_HACK_RECEIPT_CONFLICT");
  } else if (!operation.objectives[spec.objective.key].receipts[id]) {
    const path = `/terminalOutcomes/${operation.identity.operationID}`, outcomes = store.read(path) || {};
    if (outcomes[id] && outcomes[id].proof !== proof) fail("INCURSION_HACK_RECEIPT_CONFLICT");
    outcomes[id] = { kind: "hack", proof, atMs: win.atMs }; store.transaction([[path, outcomes]]);
  }
  const entity = { typeID: 3261, dungeonMaterializedContainer: true, dungeonMaterializedSiteContent: true,
    dungeonSiteContentAnalyzer: "data", dungeonSiteInstanceID: instance.instanceID, dungeonSiteContentKey: win.contentKey, dunObjectID: win.sourceObjectID };
  const marked = require("../exploration/hackingContainerState").markSuccessEffectsDelivered(entity, receipt.outcomeID, { nowMs: clock.now() });
  if (!marked.success) fail(marked.errorMsg);
  return operation;
}
function acceptWin(entity, outcomeID) {
  const instance = runtime().getInstance(entity.dungeonSiteInstanceID), operation = operationFor(instance);
  const durable = runtime().getPersistedInstance(instance.instanceID), record = durable.spawnState?.hackingContainers?.[entity.dungeonSiteContentKey], receipt = record?.outcomes?.[outcomeID];
  if (!receipt) fail("INCURSION_HACK_RECEIPT_MISSING");
  consumeReceipt(instance, operation, record, receipt, false);
  return { success: true };
}
function reconcile(instance, previous, { closed = false } = {}) {
  if (!context(instance) || !previous) return previous;
  if (active.has(instance.instanceID)) return store.getOperation(previous.identity.operationID) || previous;
  active.add(instance.instanceID);
  try {
    let operation = store.getOperation(previous.identity.operationID) || previous;
    let journal = ensure(instance, operation);
    if (!journal) return operation;
    const durable = runtime().getPersistedInstance(instance.instanceID);
    for (const record of Object.values(durable.spawnState?.hackingContainers || {})) for (const receipt of Object.values(record.outcomes || {})) {
      if (receipt.incursionWin && receipt.outcome === "won" && !receipt.successEffectsDelivered) operation = consumeReceipt(instance, operation, record, receipt, closed);
    }
    journal = ensure(instance, operation);
    if (!closed && operation.status === "active") {
      assertOpen(instance, operation);
      let changed = false;
      for (const spec of context(instance).controls) {
        const row = journal.controls[spec.key];
        if (row.phase === "hostile") {
          const death = require("./incursionStructures").getCommittedDeath(instance, `${spec.key}:health`);
          if (death) { row.phase = "neutral"; row.generation++; row.death = death; changed = true; }
        }
        if (row.phase === "friendly" && clock.now() >= row.friendlyUntilMs) {
          row.phase = "neutral"; row.generation++; changed = true;
        }
        if (row.generation > 65536) fail("INCURSION_LOGISTICS_GENERATION_LIMIT");
      }
      if (changed) save(instance.instanceID, journal);
    }
    return operation;
  } finally { active.delete(instance.instanceID); }
}
function canDamage(entity) { return !entity?.incursionLogisticsStation && (!entity?.incursionControlKey ||
  entity.incursionControlPhase === "hostile" && require("./incursionStructures").canDamage(entity)); }
function beforePurge(instance) { if (journalOf(instance)) reconcile(instance, operationFor(instance), { closed: true }); }
module.exports = { VERSION, context, projectPopulationHints, prepareEntity, canHack, canDamage, prepareWin,
  isPreparedWin: win => prepared.has(win), acceptWin, reconcile, beforePurge, readControlState: ensure, assertOpen };
