"use strict";
const incursionClock = require("./incursionClock");

// The dungeon and native health owners supply facts. This adapter projects
// their durable outboxes into one frozen encounter and its economic outbox.
const admission = require("./incursionAdmission");
const model = require("./incursionEncounterModel");
const siteModel = require("./incursionSiteModel");
const rulesFor = value => value?.version === 2 ? siteModel : model;
const store = require("./incursionRewardStore");
const rewards = require("./incursionRewards");
const carrier = require("../inventory/incursionCombatOutcomes");
const clone = value => structuredClone(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const charID = entity => Number(entity?.characterID || entity?.pilotCharacterID || entity?.session?.characterID || entity?.session?.charid) || 0;
const native = () => require("../../space/npc/nativeNpcService");
const npcStore = () => require("../../space/npc/nativeNpcStore");
const dungeon = () => require("../dungeon/dungeonRuntime");
const activeDamage = new WeakSet();
function checked(result) {
  if (!result?.success) throw new Error(result?.errorMsg || "INCURSION_OWNER_UNAVAILABLE");
  return result;
}
function ensureOperation(instance) {
  const policy = admission.admittedPolicy(instance);
  if (!policy) return null;
  const identity = admission.operationIdentity(instance);
  let operation = store.getOperation(identity.operationID);
  if (operation) {
    if (model.fingerprint(operation.identity) !== model.fingerprint(identity) ||
        operation.policyFingerprint !== model.fingerprint(policy)) throw new Error("INCURSION_OPERATION_SCOPE_MISMATCH");
  } else {
    require("./incursionTerminalContract").assertCompletionOpen(identity, incursionClock.now());
    rewards.assertPoolIdentity(identity.poolGroupID, identity.taleID);
    operation = store.saveOperation((policy.version === 2 ? siteModel : model).createOperation(identity, policy, incursionClock.now()));
  }
  if (operation.version === 2) {
    const pinned = require("./incursionFriendlyActors").freeze(operation);
    if (pinned !== operation) operation = store.saveOperation(pinned);
  }
  return operation;
}
function closedTale(operation, nowMs = incursionClock.now()) {
  if (!["tale-slot", "tale-final"].includes(operation?.identity?.placement)) return null;
  const tale = require("./incursionLifecycle").getTale(operation.identity.taleID);
  return require("./incursionTerminalContract").enabled(tale) && (tale.terminal || nowMs >= tale.expiresAtMs) ? tale : null;
}
function retireOperation(operation, tale, nowMs = incursionClock.now()) {
  if (operation.identity.taleID !== tale.taleID || operation.identity.poolGroupID !== tale.poolGroupID ||
      operation.identity.generation !== tale.generation) throw new Error("INCURSION_TERMINAL_OPERATION_SCOPE");
  let next = operation;
  if (!operation.receiptID && operation.status !== "retired") next = store.saveOperation({ ...operation, status: "retired",
    terminalCutoff: { taleID: tale.taleID, eventID: tale.terminal?.eventID ?? null,
      cutoffAtMs: Math.min(nowMs, tale.expiresAtMs), reason: "reward-seal-after-terminal-cutoff" } });
  const instance = dungeon().getInstance(operation.identity.instanceID);
  if (instance && operation.version === 2) require("./incursionCivilianDrops").reconcile(instance, next, { closed: true });
  if (instance && operation.version === 2) require("./incursionFactory").reconcile(instance, next,
    { scene: require.cache[require.resolve("../../space/runtime")]?.exports?.scenes?.get(instance.solarSystemID) || null });
  if (instance && operation.version === 2) next = require("./incursionCargo").reconcile(instance, next, { closed: true });
  if (instance && operation.version === 2) next = require("./incursionStructures").reconcile(instance, next, { closed: true });
  if (instance && operation.version === 2) next = require("./incursionLogistics").reconcile(instance, next, { closed: true });
  if (instance && operation.version === 2) require("./incursionLogisticsSupport").reconcile(instance, next);
  checked(carrier.fence());
  for (const receipt of checked(carrier.listPending({ instanceID: operation.identity.instanceID })).data) {
    const event = receipt.event;
    if (event.operationID !== operation.identity.operationID || receipt.carrier !== (event.kind === "damage" ? "npc" : "items")) {
      throw new Error("INCURSION_OUTCOME_SCOPE_MISMATCH");
    }
    const prior = next.events?.[event.eventID], proof = model.fingerprint(event);
    if (prior && prior !== proof) throw new Error("INCURSION_CONTRIBUTION_CONFLICT");
    if (!prior) {
      // Retain an audit before acknowledging an independently durable health
      // journal. Closure never converts its late projection into a fresh award.
      const path = `/terminalOutcomes/${operation.identity.operationID}`, outcomes = store.read(path) || {};
      if (outcomes[event.eventID]?.proof && outcomes[event.eventID].proof !== proof) throw new Error("INCURSION_CONTRIBUTION_CONFLICT");
      if (!outcomes[event.eventID]) {
        outcomes[event.eventID] = { proof, kind: event.kind, atMs: event.atMs,
          targetEntityID: event.targetEntityID, destroyed: event.destroyed === true };
        store.transaction([[path, outcomes]]);
      }
    }
    if (event.destroyed && dungeon().getInstance(operation.identity.instanceID)) checked(native().retireRequiredDungeonActor(
      { itemID: event.targetEntityID }, "destroyed", event.atMs));
    checked(carrier.acknowledge(event.eventID));
  }
  return next;
}
function fleetID(characterID) {
  return Number(require("../fleets/fleetRuntime").getFleetForCharacter(characterID)?.fleetID) || 0;
}
function worldPosition(instance) {
  const room = instance.roomStatesByKey?.[admission.admittedPolicy(instance).roomKey]?.metadata?.rawRoomProfile;
  const vector = room?.position;
  const lobby = instance.roomStatesByKey?.[admission.admittedPolicy(instance).lobbyRoomKey]?.metadata?.rawRoomProfile?.position;
  if (!vector || !lobby || !instance.position) throw new Error("INCURSION_FROZEN_ROOM_POSITION_MISSING");
  return Object.fromEntries(["x", "y", "z"].map((key, i) => [key, Number(instance.position[key]) +
    Number(Array.isArray(vector) ? vector[i] : vector[key]) - Number(Array.isArray(lobby) ? lobby[i] : lobby[key])]));
}
function siteRoomPosition(instance, roomKey) {
  const room = instance.roomStatesByKey?.[roomKey]?.metadata?.rawRoomProfile;
  const lobby = instance.roomStatesByKey?.[admission.admittedPolicy(instance).lobbyRoomKey]?.metadata?.rawRoomProfile;
  if (!room?.position || !lobby?.position || !instance.position) throw new Error("INCURSION_FROZEN_ROOM_POSITION_MISSING");
  return Object.fromEntries(["x", "y", "z"].map((axis, index) => [axis, Number(instance.position[axis]) +
    Number(Array.isArray(room.position) ? room.position[index] : room.position[axis]) -
    Number(Array.isArray(lobby.position) ? lobby.position[index] : lobby.position[axis])]));
}
function inRoom(instance, entity) {
  const policy = admission.admittedPolicy(instance);
  if (!policy || !entity || entity.nativeNpc === true || entity.kind !== "ship" || entity.destroyed ||
      entity.destroying || entity.warpState || String(entity.mode).toUpperCase() === "WARP" ||
      Number(entity.dungeonCurrentInstanceID) !== instance.instanceID ||
      (policy.version === 2 ? !policy.roomKeys.includes(entity.dungeonCurrentRoomKey) : entity.dungeonCurrentRoomKey !== policy.roomKey)) return false;
  const center = policy.version === 2 ? siteRoomPosition(instance, entity.dungeonCurrentRoomKey) : worldPosition(instance);
  return Math.hypot(...["x", "y", "z"].map(key => Number(entity.position?.[key]) - center[key])) <= policy.participation.radiusMeters;
}
function presence(scene, instance) {
  const result = [], seen = new Set();
  for (const session of scene.sessions?.values() || []) {
    const entity = scene.getShipEntityForSession?.(session), characterID = charID(entity);
    if (session.socket?.destroyed || !positive(characterID) || seen.has(characterID) || !inRoom(instance, entity) ||
        scene.getEntityByID?.(entity.itemID) !== entity) continue;
    const groupID = Number(entity.groupID);
    if (!positive(groupID)) throw new Error("INCURSION_PILOT_GROUP_MISSING");
    seen.add(characterID);
    result.push({ characterID, fleetID: fleetID(characterID), groupID,
      activeShip: groupID !== 29,
      cloaked: Boolean(entity.isCloaked || entity.cloakMode || entity.cloaked) });
  }
  return result.sort((a, b) => a.characterID - b.characterID);
}
function sourcePilot(scene, instance, source) {
  if (!source || source.nativeNpc === true || scene.getEntityByID?.(source.itemID) !== source) return null;
  let ship = source;
  if (["drone", "fighter"].includes(source.kind)) {
    const owner = charID(source) || Number(source.ownerID);
    ship = [...(scene.sessions?.values() || [])].map(session => scene.getShipEntityForSession?.(session))
      .find(entity => charID(entity) === owner);
  }
  const characterID = charID(ship);
  if (!positive(characterID) || !ship?.session || ship.session.socket?.destroyed || !inRoom(instance, ship) ||
      scene.getEntityByID?.(ship.itemID) !== ship) return null;
  return { characterID, fleetID: fleetID(characterID), sourceShipID: Number(ship.itemID) };
}
function recoverBirths(instance, operation) {
  if (operation.status !== "active") return operation;
  let result = operation;
  const actors = operation.version === 2 ? [...operation.policy.stages.filter(stage => operation.stages[stage.key].active).flatMap(stage => stage.actors),
    ...require("./incursionReinforcements").cohorts(operation).filter(group => group.active).flatMap(group => group.actors),
    ...require("./incursionFriendlyActors").cohorts(operation).filter(group => group.active).flatMap(group => group.actors)]
    : operation.policy.waves[operation.waveIndex].actors;
  for (const record of npcStore().listNativeEntitiesForSystem(instance.solarSystemID)) {
    const actor = actors.find(row => row.key === record.dungeonSiteContentKey);
    if (!actor || Number(record.dungeonSiteInstanceID) !== instance.instanceID ||
        record.incursionOperationID !== operation.identity.operationID) continue;
    if (record.transient !== false || record.dungeonSiteContentRole !== "required_actor" ||
        Number(record.typeID) !== actor.typeID || Number(record.dungeonSiteID) !== Number(instance.metadata?.siteID) ||
        actor.role === "friendly" && (Number(record.ownerID) !== actor.ownerID || record.profileID !== actor.profileID)) {
      throw new Error("INCURSION_BIRTH_OWNER_MISMATCH");
    }
    const entityID = Number(record.entityID);
    const projected = result.births[actor.key];
    // The V2 reconciliation has already validated the frozen policy. A matching
    // durable birth needs no new operation snapshot. Missing and conflicting
    // births still go through the model's admission and identity checks.
    if (result.version === 2 && positive(entityID) && projected?.entityID === entityID && projected.typeID === actor.typeID) continue;
    result = rulesFor(result).recordBirth(result, { key: actor.key, entityID, typeID: actor.typeID });
  }
  return result;
}
function enqueueSettlement() {
  require("./incursionRewardScheduler").recoverPending();
}
function holdForRecovery(entity, held, whenMs = incursionClock.now()) {
  entity.incursionWaveHeld = held;
  const registry = require("../../space/npc/npcRegistry");
  const controller = registry.getControllerByEntityID(entity.itemID);
  if (!controller) return;
  if (held) registry.pauseController(entity.itemID, "incursion-wave-recovery");
  else if (controller.pausedReason === "incursion-wave-recovery") registry.activateController(entity.itemID, whenMs);
}
function reconcilePending(instance, operation) {
  if (!operation) return operation;
  // The health owner can commit before the encounter projection. Scheduler
  // recovery must drain that durable outbox without waiting for a room tick,
  // including a flagship death that supplies the terminal completion proof.
  const pending = checked(carrier.listPending({ instanceID: instance.instanceID })).data;
  return pending.length ? reconcile(instance) : operation;
}
function reconcile(instance) {
  let operation = ensureOperation(instance);
  if (!operation) return null;
  if (require("./incursionFriendlyActors").reconcileRemoval(instance, operation)) return store.getOperation(operation.identity.operationID);
  if (operation.failure) return reconcileFailure(instance, operation);
  const closed = closedTale(operation);
  if (closed) return retireOperation(operation, closed);
  if (operation.version === 2 && operation.status === "active") {
    const mined = require("./incursionMining").collect(instance, operation);
    const activated = require("./incursionSiteMechanics").advance(instance, mined);
    if (model.fingerprint(activated) !== model.fingerprint(operation)) operation = store.saveOperation(activated);
    require("./incursionSiteMechanics").reconcileGates(instance, operation);
  }
  checked(carrier.fence());
  let next = recoverBirths(instance, operation);
  if (model.fingerprint(next) !== model.fingerprint(operation)) operation = store.saveOperation(next);
  const pending = checked(carrier.listPending({ instanceID: instance.instanceID })).data;
  for (const receipt of pending) {
    const event = receipt.event;
    if (event.operationID !== operation.identity.operationID || receipt.carrier !== (event.kind === "damage" ? "npc" : "items")) {
      throw new Error("INCURSION_OUTCOME_SCOPE_MISMATCH");
    }
    const prior = operation.events[event.eventID];
    if (prior && prior !== model.fingerprint(event)) throw new Error("INCURSION_CONTRIBUTION_CONFLICT");
    if (!prior) {
      if (operation.status !== "active") throw new Error("INCURSION_LATE_OUTCOME");
      next = operation;
      if (event.kind === "damage") {
        // This purgesafe health-owner receipt independently proves the original
        // native birth even if its encounter checkpoint never committed.
        next = rulesFor(next).recordBirth(next, { key: event.targetKey, entityID: event.targetEntityID, typeID: event.targetTypeID });
      }
      next = rulesFor(next).recordContribution(next, event);
      if (event.destroyed) next = rulesFor(next).recordRetirement(next,
        { key: event.targetKey, entityID: event.targetEntityID, typeID: event.targetTypeID, reason: "destroyed",
          ...(next.version === 2 ? { atMs: event.completionWallTimeMs,
            ...(event.deathPosition ? { deathEventID: event.eventID } : {}) } : {}) });
      if (next.status === "ready") {
        if (!event.completionPresence || !positive(event.completionWallTimeMs)) throw new Error("INCURSION_COMPLETION_SNAPSHOT_REQUIRED");
        next = rulesFor(next).finalize(next, event.completionPresence, event.completionWallTimeMs);
        next.completion.taxProfiles = clone(event.completionTaxProfiles);
        rewards.sealCompletion({ completedOperation: next, recipients: next.completion.recipients,
          completedAtMs: next.completion.completedAtMs });
        operation = store.getOperation(next.identity.operationID);
      } else operation = store.saveOperation(next);
    }
    if (event.destroyed) checked(native().retireRequiredDungeonActor({ itemID: event.targetEntityID }, "destroyed", event.atMs));
    checked(carrier.acknowledge(event.eventID));
  }
  if (operation.version === 2 && operation.status === "active") {
    const next = require("./incursionSiteMechanics").advance(instance, operation);
    if (model.fingerprint(next) !== model.fingerprint(operation)) operation = store.saveOperation(next);
  }
  if (operation.version === 2) operation = require("./incursionCargo").reconcile(instance, operation);
  if (operation.version === 2) require("./incursionCivilianDrops").reconcile(instance, operation,
    { scene: require.cache[require.resolve("../../space/runtime")]?.exports?.scenes?.get(instance.solarSystemID) || null });
  if (operation.version === 2) operation = require("./incursionStructures").reconcile(instance, operation);
  if (operation.version === 2) require("./incursionFactory").reconcile(instance, operation,
    { scene: require.cache[require.resolve("../../space/runtime")]?.exports?.scenes?.get(instance.solarSystemID) || null });
  if (operation.failure) return reconcileFailure(instance, operation);
  if (operation.version === 2) operation = require("./incursionLogistics").reconcile(instance, operation);
  if (operation.version === 2) require("./incursionLogisticsSupport").reconcile(instance, operation,
    { scene: require.cache[require.resolve("../../space/runtime")]?.exports?.scenes?.get(instance.solarSystemID) || null });
  if (operation.receiptID) {
    if (operation.identity.placement === "tale-final") require("./incursionFinalSiteRuntime").acceptCompletion(instance, operation);
    else require("./incursionSiteRuntime").acceptCompletion(instance, operation);
    enqueueSettlement();
  }
  return operation;
}
function reconcileFailure(instance, operation) {
  require("./incursionStructures").verifyFailure(instance, operation);
  const tale = require("./incursionLifecycle").getTale(operation.identity.taleID);
  operation = retireOperation(operation, tale);
  require("./incursionActorCleanup").retireActors(operation, incursionClock.now(), { preserveCombatDeaths: true, preserveInFlightDamage: true });
  checked(require("../../gameStore").flushTablesSync(["npcEntities", "npcRuntimeControllers", "npcModules", "npcCargo"]));
  const scene = require.cache[require.resolve("../../space/runtime")]?.exports?.scenes?.get(instance.solarSystemID);
  if (npcStore().listNativeEntitiesForSystem(instance.solarSystemID).some(record => record.incursionOperationID === operation.identity.operationID &&
      require("./incursionHooks").isDamageInProgress(scene?.getEntityByID?.(record.entityID)))) return operation;
  if (["active", "seeded", "paused"].includes(dungeon().getInstance(instance.instanceID)?.lifecycleState))
    dungeon().setLifecycleState(instance.instanceID, "failed", { nowMs: operation.failure.atMs, failedAtMs: operation.failure.atMs,
      durable: true, lifecycleReason: "incursion-premature-terminal-death" });
  return operation;
}
function initializeActor(scene, instance, entry, entity) {
  const operation = ensureOperation(instance);
  if (!operation) return false;
  if (entity.dungeonSiteContentKey !== entry.key || Number(entity.typeID) !== Number(entry.typeID) ||
      Number(entity.dungeonSiteInstanceID) !== instance.instanceID) throw new Error("INCURSION_ACTOR_SCOPE_MISMATCH");
  // The surrounding exact-wave spawn may still roll back. Bind the durable
  // native birth here; project membership after the complete wave is accepted.
  checked(native().bindNpcOperation(entity, operation.identity.operationID));
  if (operation.version === 2) {
    const actor = siteModel.actorDeclaration(operation, entry.key);
    if (!actor || actor.typeID !== entity.typeID) throw new Error("INCURSION_ACTOR_SCOPE_MISMATCH");
    if ([5158, 5201].includes(operation.policy.dungeonID) && actor.role === "terminal" &&
        [2192, 3071].includes(actor.typeID) && operation.policy.npcBossAbilityPolicyVersion === "evejs.sansha-boss-abilities.v1") {
      entity.npcBossAbilityPolicyVersion = operation.policy.npcBossAbilityPolicyVersion;
      entity.npcBossCombatRoomKey = actor.roomKey;
      const record = npcStore().getNativeEntity(entity.itemID);
      checked(npcStore().upsertNativeEntity({ ...record, npcBossAbilityPolicyVersion: entity.npcBossAbilityPolicyVersion,
        npcBossCombatRoomKey: actor.roomKey }, { transient: false }));
      checked(require("../../gameStore").flushTableSync("npcEntities"));
    }
    holdForRecovery(entity, operation.status === "active" && !siteModel.birthsReady(operation, entry.key), scene.getCurrentSimTimeMs?.());
    return true;
  }
  const wave = operation.policy.waves[operation.waveIndex];
  holdForRecovery(entity, operation.status === "active" && !wave.actors.every(actor => operation.births[actor.key]), scene.getCurrentSimTimeMs?.());
  return true;
}
function canSpawnEncounter(instance, template, plan, { siteTickReconciled = false } = {}) {
  const policy = admission.admittedPolicy(instance);
  if (!policy) return true;
  if (instance.metadata?.incursionAdmission?.placement === "tale-slot") {
    try {
      require("./incursionLifecycle").siteAdmission({ ...instance.metadata.incursionAdmission,
        instanceID: instance.instanceID, solarSystemID: instance.solarSystemID });
    } catch (_) { return false; }
  }
  if (instance.metadata?.incursionAdmission?.placement === "tale-final") {
    try { require("./incursionLifecycle").finalAdmission({ ...instance.metadata.incursionAdmission,
      instanceID: instance.instanceID, solarSystemID: instance.solarSystemID }); } catch (_) { return false; }
  }
  // The periodic room-spawn pass has already drained this site's outboxes.
  // Read the latest operation so an earlier spawn in the same pass is visible.
  const operation = siteTickReconciled && policy.version === 2
    ? store.getOperation(`incursion-v2:${instance.instanceID}`) : reconcile(instance);
  if (!operation) return false;
  if (operation.version === 2) return siteModel.canSpawn(operation, plan.key);
  return operation.status === "active" && operation.policy.waves[operation.waveIndex]?.encounterKey === plan.key;
}
function canComplete(instance) {
  return !admission.admittedPolicy(instance) || Boolean(reconcile(instance)?.receiptID);
}
function eventIdentity(fields, previous, after, discriminator) {
  return `incursion-effect:${model.fingerprint({ ...fields, previous, after, discriminator })}`;
}
function commitDamage(scene, source, target, damageResult, previousConditionState, whenMs, options = {}) {
  if (!target?.incursionOperationID) return { success: true, handled: false };
  if (target.incursionStructureObjectiveKey) {
    const nested = activeDamage.has(target); activeDamage.add(target);
    try { return require("./incursionStructures").commitDamage(scene, source, target, damageResult, previousConditionState, whenMs); }
    finally { if (!nested) activeDamage.delete(target); }
  }
  const nested = activeDamage.has(target);
  activeDamage.add(target);
  let accepted = false;
  let terminalHP = null;
  try {
    const instance = dungeon().getInstance(target.dungeonSiteInstanceID);
    const operation = reconcile(instance);
    if (!operation || operation.status !== "active" || operation.identity.operationID !== target.incursionOperationID ||
        scene.getEntityByID?.(target.itemID) !== target || Number(scene.systemID) !== instance.solarSystemID) throw new Error("INCURSION_DAMAGE_CONTEXT_INVALID");
    if (operation.version === 2 ? !siteModel.birthsReady(operation, target.dungeonSiteContentKey)
      : !operation.policy.waves[operation.waveIndex].actors.every(actor => operation.births[actor.key])) {
      throw new Error("INCURSION_WAVE_BIRTH_PENDING");
    }
    const amount = require("../../space/runtime/combatDamageMessages").getAppliedDamageAmount(damageResult);
    if (!(amount > 0)) return { success: true, handled: false };
    const pilot = sourcePilot(scene, instance, source);
    const fields = { operationID: operation.identity.operationID, instanceID: instance.instanceID, kind: "damage",
      characterID: pilot?.characterID || 0, fleetID: pilot?.fleetID || 0, amount,
      targetKey: target.dungeonSiteContentKey, targetEntityID: Number(target.itemID), targetTypeID: Number(target.typeID),
      targetCharacterID: 0, sourceShipID: pilot?.sourceShipID || 0, moduleID: Number(options.moduleID) || 0,
      atMs: Math.max(1, Math.trunc(whenMs)), destroyed: damageResult.data.destroyed === true };
    const present = fields.destroyed ? presence(scene, instance) : null;
    const event = { ...fields, eventID: eventIdentity(fields, previousConditionState, target.conditionState,
      options.cycleID || options.action || "damage"),
      ...(fields.destroyed ? { completionPresence: present, completionWallTimeMs: incursionClock.now(),
        completionTaxProfiles: Object.fromEntries(present.map(row => [row.characterID,
          require("../corporation/corporationTax").resolveCorporationTaxProfile(row.characterID)])),
        ...(instance.sourceDungeonID === 5167 ? { deathPosition: clone(target.position) } : {}) } : {}) };
    const committed = carrier.commitNpcDamage({ scene, entity: target, sourceEntity: source, event, previousConditionState });
    accepted = committed.accepted === true;
    if (committed.errorMsg === "INCURSION_NPC_DEATH_ALREADY_COMMITTED") {
      const record = npcStore().getNativeEntity(target.itemID);
      if (record?.incursionDeathEventID && record.typeID === target.typeID && record.incursionOperationID === target.incursionOperationID &&
          Number(record.dungeonSiteInstanceID) === Number(target.dungeonSiteInstanceID)) terminalHP = clone(record.conditionState);
    }
    checked(committed);
    if (!committed.durable) { target.incursionHealthPending = true; holdForRecovery(target, true); return { ...committed, pending: true }; }
    reconcile(instance);
    return { ...committed, pending: false };
  } catch (error) {
    if (!accepted) target.conditionState = terminalHP || clone(previousConditionState);
    else { target.incursionHealthPending = true; holdForRecovery(target, true); }
    return { success: accepted, handled: true, accepted, pending: accepted, errorMsg: error.message };
  } finally {
    if (!nested) activeDamage.delete(target);
  }
}
function commitRepair(scene, source, target, amount, whenMs, effectState, previousConditionState, careerOutcome = null) {
  if (!(amount > 0) || !source || !target || source === target) return { success: true, handled: false };
  const instance = dungeon().getInstance(target.dungeonCurrentInstanceID);
  if (!admission.admittedPolicy(instance) || !inRoom(instance, target) || !inRoom(instance, source)) return { success: true, handled: false };
  let accepted = false;
  try {
    const pilot = sourcePilot(scene, instance, source), other = charID(target);
    if (!pilot || !other || !pilot.fleetID || pilot.fleetID !== fleetID(other)) return { success: true, handled: false };
    const operation = reconcile(instance);
    if (operation.status !== "active") return { success: true, handled: false };
    const fields = { operationID: operation.identity.operationID, instanceID: instance.instanceID, kind: "repair",
      ...pilot, amount, targetKey: `player:${target.itemID}`, targetEntityID: Number(target.itemID), targetTypeID: Number(target.typeID),
      targetCharacterID: other, moduleID: Number(effectState.moduleID), atMs: Math.max(1, Math.trunc(whenMs)), destroyed: false };
    const event = { ...fields, eventID: eventIdentity(fields, previousConditionState, target.conditionState, effectState.startedAtMs) };
    const committed = carrier.commitPlayerRepair({ targetEntity: target, event, previousConditionState,
      changedEntities: [source, target], careerOutcome });
    accepted = committed.accepted === true;
    checked(committed);
    if (committed.durable) reconcile(instance);
    else target.incursionRepairPending ||= { instanceID: instance.instanceID, previousConditionState: clone(previousConditionState) };
    return { ...committed, pending: !committed.durable };
  } catch (error) {
    if (!accepted) target.conditionState = clone(previousConditionState);
    else target.incursionRepairPending ||= { instanceID: instance.instanceID, previousConditionState: clone(previousConditionState) };
    return { success: accepted, handled: true, accepted, pending: accepted, errorMsg: error.message };
  }
}
function tick(scene, instance) {
  const operation = reconcile(instance);
  if (!operation) return false;
  // An accepted HP write may have parked publication before the native death
  // handler ran. Finish through that same handler after its durable projection.
  for (const entity of scene.getDynamicEntities?.() || []) {
    const repair = entity.incursionRepairPending;
    if (repair?.instanceID === instance.instanceID) {
      const health = require("../../space/runtime/shipHealthState");
      const now = scene.getCurrentSimTimeMs?.() || incursionClock.now();
      if (entity.session && !entity.session.socket?.destroyed) health.notifyShipHealthAttributesToSession(
        entity.session, entity, health.buildShipHealthTransitionResult(entity, repair.previousConditionState), now);
      health.broadcastDamageStateChange(scene, entity, now);
      delete entity.incursionRepairPending;
    }
    if (entity.incursionOperationID !== operation.identity.operationID) continue;
    holdForRecovery(entity, operation.status === "active" && (operation.version === 2
      ? !siteModel.birthsReady(operation, entity.dungeonSiteContentKey)
      : !operation.policy.waves[operation.waveIndex].actors.every(actor => operation.births[actor.key])), scene.getCurrentSimTimeMs?.());
    const retired = operation.retirements[entity.dungeonSiteContentKey];
    if (retired && Number(entity.conditionState?.damage) >= 1 && !activeDamage.has(entity)) {
      const result = require("../../space/runtime/combatDestruction").destroyCombatEntity(scene, entity,
        { destructionNowMs: scene.getCurrentSimTimeMs?.() || incursionClock.now(), destructionReason: "combat" });
      checked(result);
    } else if (entity.incursionHealthPending && !entity.incursionLogisticsRepairPending) {
      delete entity.incursionHealthPending;
      require("../../space/runtime/shipHealthState").broadcastDamageStateChange(scene, entity);
    }
  }
  if (operation.version === 2) require("./incursionLogisticsSupport").tick(scene, instance, operation);
  if (operation.version === 2) require("./incursionStructures").tickRepairs(scene, instance, operation);
  return true;
}

module.exports = { tick, canSpawnEncounter, initializeActor, commitDamage, commitRepair, canComplete,
  ensureOperation, reconcile, reconcilePending, presence, sourcePilot, retireOperation, siteRoomPosition,
  isDamageInProgress: entity => activeDamage.has(entity) };
