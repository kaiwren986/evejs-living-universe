"use strict";

// Friendly bindings are already frozen in the reviewed client-derived policy.
// They use native required-actor persistence but never earn combat contribution
// or satisfy a hostile stage. Neutral ownership is explicit emulator policy.
const { fingerprint, fail } = require("./incursionLifecycleContract");
const VERSION = "evejs.incursion-friendly-actors.v1";
const removing = new Set();
const PASSIVE = Object.freeze({ autoAggro: false, autoAggroTargetClasses: [], autoActivateWeapons: false,
  allowFriendlyNpcTargets: false, returnToHomeWhenIdle: false });
function declarations(policy) {
  const rows = policy?.mechanics?.friendlyActors || [];
  if (!Array.isArray(rows)) fail("INCURSION_FRIENDLY_POLICY_INVALID");
  if (!rows.length) return [];
  const actor = rows[0];
  if (rows.length !== 1 || policy.dungeonID !== 5193 || actor.key !== "civilian-orca" || actor.anchorObjectID !== 1012867 ||
      actor.nativeGroupingReference !== 31662 || actor.nativeNameID !== 120412 || actor.typeID !== 32449 ||
      actor.profileID !== "parity_mission_special_entities_32449_civilian_orca" || actor.ownerID !== 0 || actor.factionID !== 0 ||
      actor.role !== "friendly" || actor.requiredForCompletion !== false || actor.roomKey !== "room:23409" ||
      actor.targetPolicy?.autoAggro !== false || actor.targetPolicy.acquirePlayerTargets !== false || actor.targetPolicy.hostileNPCMayTarget !== false ||
      actor.deathPolicy !== "no site failure; retain death and skip survivor escape" ||
      !actor.positionOffset || ["x", "y", "z"].some(axis => !Number.isFinite(actor.positionOffset[axis])) ||
      !policy.stages.some(stage => stage.roomKey === actor.roomKey) || policy.stages.some(stage => stage.actors.some(row => row.key === actor.key)))
    fail("INCURSION_FRIENDLY_POLICY_INVALID");
  return [{ ...structuredClone(actor), ownerID: 1, auxiliary: true, encounterKey: `incursion:friendly:${actor.key}` }];
}
function actorDeclaration(policy, key) { return declarations(policy).find(actor => actor.key === key) || null; }
function assertVersion(state, required = false) {
  const actors = declarations(state.policy), version = state.mechanics?.friendlyActorPolicyVersion;
  if (actors.length && (required || version !== undefined || actors.some(actor => state.births[actor.key])) && version !== VERSION)
    fail("INCURSION_FRIENDLY_VERSION_INVALID");
}
function freeze(state) {
  const actors = declarations(state.policy), version = state.mechanics?.friendlyActorPolicyVersion;
  if (!actors.length) return state;
  assertVersion(state);
  if (version === VERSION || state.status !== "active") return state;
  return { ...structuredClone(state), mechanics: { ...structuredClone(state.mechanics || {}), friendlyActorPolicyVersion: VERSION } };
}
function cohorts(state) {
  return declarations(state.policy).map(actor => ({ key: actor.encounterKey, encounterKey: actor.encounterKey,
    roomKey: actor.roomKey, actors: [actor], active: state.policy.stages.some(stage =>
      stage.roomKey === actor.roomKey && state.stages[stage.key]?.active) }));
}
function projectPopulationHints(instance, hints) {
  if (instance?.runtimeFlags?.incursionRuntime !== true || hints?.incursionPolicy?.version !== 2) return hints;
  const actors = declarations(hints.incursionPolicy);
  if (!actors.length) return hints;
  const policy = require("./incursionAdmission").admittedPolicy(instance);
  if (fingerprint(policy) !== fingerprint(hints.incursionPolicy)) fail("INCURSION_FRIENDLY_SCOPE_INVALID");
  const plans = [...hints.encounters];
  for (const actor of actors) {
    const spawnEntries = [{ key: actor.key, entityKind: "npc", typeID: actor.typeID, profileID: actor.profileID,
      spawnQuery: actor.profileID, ownerID: actor.ownerID, factionID: actor.factionID, label: "Civilian Orca",
      nameID: actor.nativeNameID, positionOffset: actor.positionOffset, blocksEncounterProgress: false, incursionActorRole: "friendly" }];
    const plan = { key: actor.encounterKey, roomKey: actor.roomKey, trigger: "on_room_active", supported: true, exact: true, deadspace: true,
      spawnQuery: actor.profileID, waveIndex: 1, amount: 1, maxSpawnEntries: 1, spawnChance: 1, spawnEntries, incursionPhaseOwned: true };
    const prior = plans.find(row => row.key === plan.key);
    if (prior && fingerprint(prior) !== fingerprint(plan)) fail("INCURSION_FRIENDLY_PLAN_CONFLICT");
    if (!prior) plans.push(plan);
  }
  return { ...hints, encounters: plans };
}
function spawnOverrides(instance, entry) {
  if (instance?.runtimeFlags?.incursionRuntime !== true || instance.sourceDungeonID !== 5193) return undefined;
  const actor = actorDeclaration(require("./incursionAdmission").admittedPolicy(instance), entry.key);
  if (!actor) return undefined;
  if (entry.typeID !== actor.typeID || entry.ownerID !== actor.ownerID || entry.profileID !== actor.profileID || entry.blocksEncounterProgress !== false)
    fail("INCURSION_FRIENDLY_PLAN_INVALID");
  return structuredClone(PASSIVE);
}

function npcPresentationOverrides(record) {
  if (record.dungeonSiteContentKey !== "civilian-orca" || record.typeID !== 32449) return undefined;
  const instance = require("../dungeon/dungeonRuntime").getInstanceRef(record.dungeonSiteInstanceID);
  if (instance?.runtimeFlags?.incursionRuntime !== true || instance.sourceDungeonID !== 5193 ||
      instance.metadata.siteID !== record.dungeonSiteID) return undefined;
  const actor = actorDeclaration(require("./incursionAdmission").admittedPolicy(instance), record.dungeonSiteContentKey);
  if (!actor || actor.ownerID !== record.ownerID || actor.profileID !== record.profileID ||
      record.dungeonEncounterKey !== `instance:${instance.instanceID}:${actor.encounterKey}`) return undefined;

  // Use the native neutral standing range and no hostile-rat bounty.
  return { hostileResponseThreshold: -11, friendlyResponseThreshold: 11, bounty: 0 };
}
function beforePurge(instance) {
  if (instance?.runtimeFlags?.incursionRuntime !== true || instance.sourceDungeonID !== 5193) return;
  if (removing.has(instance.instanceID)) fail("INCURSION_FRIENDLY_CLEANUP_REENTRANT");
  removing.add(instance.instanceID);
  try { settleRemoval(instance); }
  finally { removing.delete(instance.instanceID); }
}
function settleRemoval(instance) {
  if (instance?.runtimeFlags?.incursionRuntime !== true || instance.sourceDungeonID !== 5193) return;
  const admission = require("./incursionAdmission"), policy = admission.admittedPolicy(instance);
  if (!declarations(policy).length) return;
  const store = require("./incursionRewardStore"), identity = admission.operationIdentity(instance);
  let operation = store.getOperation(identity.operationID);
  const npcs = require("../../space/npc/nativeNpcStore"), native = require("../../space/npc/nativeNpcService");
  const records = npcs.listNativeEntitiesForSystem(instance.solarSystemID).filter(row => Number(row.dungeonSiteInstanceID) === instance.instanceID);
  if (!operation) {
    if (records.length) fail("INCURSION_FRIENDLY_CLEANUP_OPERATION_MISSING");
    return;
  }
  if (fingerprint(operation.identity) !== fingerprint(identity) || operation.policyFingerprint !== fingerprint(policy)) fail("INCURSION_FRIENDLY_SCOPE_INVALID");
  const checked = result => { if (!result?.success) fail(result?.errorMsg || "INCURSION_FRIENDLY_CLEANUP_PENDING"); return result; };
  const clock = require("./incursionClock"), carrier = require("../inventory/incursionCombatOutcomes");
  if (!operation.receiptID && operation.status !== "retired") operation = store.saveOperation({ ...operation, status: "retired",
    administrativeRetirement: { version: VERSION, reason: "site-removal", atMs: clock.now() } });
  checked(carrier.fence());
  for (const receipt of checked(carrier.listPending({ instanceID: instance.instanceID })).data) {
    const event = receipt.event;
    if (event.operationID !== identity.operationID) fail("INCURSION_OUTCOME_SCOPE_MISMATCH");
    if (receipt.carrier !== "npc" || !event.destroyed) continue;
    const record = records.find(row => Number(row.entityID) === event.targetEntityID);
    if (!record) continue; // The independent outcome is still audited after physical cleanup.
    if (fingerprint(carrier.normalizeEvent(event)) !== fingerprint(event) || event.kind !== "damage" || !(event.amount > 0) ||
        receipt.conditionState?.damage < 1 || !Number.isFinite(receipt.conditionState?.damage) ||
        Number(record.conditionState?.damage) < 1 || !Number.isFinite(Number(record.conditionState?.damage)) ||
        record.dungeonSiteContentKey !== event.targetKey || Number(record.typeID) !== event.targetTypeID ||
        record.incursionOperationID !== identity.operationID) fail("INCURSION_FRIENDLY_CLEANUP_DEATH_INVALID");
    // Retain the real fatal reason before acknowledging the HP outbox. A crash
    // between that acknowledgement and deletion must not turn death into escape.
    checked(native.retireRequiredDungeonActor(record, "destroyed", event.atMs));
  }
  const tale = require("./incursionLifecycle").getTale(identity.taleID);
  if (!tale) fail("INCURSION_FRIENDLY_CLEANUP_TALE_MISSING");
  operation = require("./incursionEncounterRuntime").retireOperation(operation, tale, clock.now());
  require("./incursionActorCleanup").retireActors(operation, clock.now(), { includePreparing: true });
  // Cached deletion is not a durable cleanup acknowledgement. Retry this fence
  // even when a previous attempt already removed every cached native row.
  checked(require("../../gameStore").flushTablesSync(["npcEntities", "npcRuntimeControllers", "npcModules", "npcCargo"]));
}
function removalPending(operation) {
  const retirement = operation?.administrativeRetirement;
  if (!retirement) return false;
  if (operation.policy?.dungeonID !== 5193 || retirement.version !== VERSION || retirement.reason !== "site-removal" ||
      operation.status !== "retired" || operation.receiptID || !Number.isSafeInteger(retirement.atMs) || retirement.atMs <= 0)
    fail("INCURSION_FRIENDLY_REMOVAL_INVALID");
  return true;
}
function reconcileRemoval(instance, operation) {
  if (!removalPending(operation)) return false;
  // Scene reconstruction may arrive before the scheduler. Withdraw actors
  // without deleting an instance from inside its materializer. The scheduler
  // finishes the dungeon removal through the same durable purge owner.
  if (!removing.has(instance.instanceID)) beforePurge(instance);
  return true;
}
module.exports = { VERSION, declarations, actorDeclaration, assertVersion, freeze, cohorts, projectPopulationHints, spawnOverrides, npcPresentationOverrides,
  beforePurge, removalPending, reconcileRemoval };
