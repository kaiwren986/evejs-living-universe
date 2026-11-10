"use strict";

// The dungeon owns cadence/recipients; inventory and native NPC owners commit
// HP with a bounded latest-pulse receipt. Offline time never queues new heals.
const { fingerprint, fail } = require("./incursionLifecycleContract");
const clock = require("./incursionClock"), store = require("./incursionRewardStore");
const VERSION = "evejs.incursion-logistics-support.v1", active = new Set();
const dungeon = () => require("../dungeon/dungeonRuntime");
const logistics = () => require("./incursionLogistics");
const positive = value => Number.isSafeInteger(value) && value > 0;
function specs(instance) {
  const ctx = logistics().context(instance);
  if (!ctx) return [];
  if (instance.sourceDungeonID === 5164) {
    const rule = ctx.policy.mechanics.objectives.find(row => row.key === "remote-logistics-station"), repair = rule?.repair;
    if (repair?.periodMs !== 1000 || repair.fractionOfTargetMaximumShieldPerCycle !== 0.03) fail("INCURSION_SUPPORT_POLICY_INVALID");
    return [{ stationObjectID: rule.nativeObjectID, controlKey: ctx.controls[0].key, periodMs: repair.periodMs,
      fraction: repair.fractionOfTargetMaximumShieldPerCycle, domain: "npc", maxTargets: 4096, rangeMeters: Infinity }];
  }
  const rule = ctx.policy.mechanics.logistics.friendlySupport;
  if (rule?.amountPerTarget !== 4500 || rule.cycleMs !== 5000 || rule.maxTargets !== 3 || rule.rangeMeters !== 52000 ||
      rule.qualificationCredit !== false) fail("INCURSION_SUPPORT_POLICY_INVALID");
  return ctx.controls.map(control => ({ stationObjectID: control.chain.stationObjectID, controlKey: control.key,
    domain: "player", periodMs: rule.cycleMs, amount: rule.amountPerTarget, maxTargets: rule.maxTargets, rangeMeters: rule.rangeMeters }));
}
const journalOf = instance => instance?.spawnState?.incursionLogisticsSupport;
const save = (id, journal) => dungeon().mergeSpawnState(id, { incursionLogisticsSupport: journal }, { durable: true, force: true });
const pulseProof = pulse => fingerprint({ ...pulse, proof: undefined, acknowledgements: undefined });
function ensure(instance, operation) {
  let journal = journalOf(dungeon().getInstance(instance.instanceID));
  if (!journal) {
    if (operation.status !== "active") return null;
    journal = { version: VERSION, operationID: operation.identity.operationID, policyFingerprint: operation.policyFingerprint, sources: {} };
    save(instance.instanceID, journal);
  }
  if (journal.version !== VERSION || journal.operationID !== operation.identity.operationID || journal.policyFingerprint !== operation.policyFingerprint ||
      !journal.sources || Object.keys(journal.sources).length > specs(instance).length) fail("INCURSION_SUPPORT_STATE_INVALID");
  for (const [key, row] of Object.entries(journal.sources)) {
    const spec = specs(instance).find(spec => String(spec.stationObjectID) === key), pulse = row.pulse;
    if (!spec || !Number.isSafeInteger(row.sequence) || row.sequence < 0 || !positive(row.nextAtMs) || typeof row.epoch !== "string") fail("INCURSION_SUPPORT_STATE_INVALID");
    if (pulse && (pulse.sequence !== row.sequence || pulse.nextAtMs !== row.nextAtMs || !positive(pulse.atMs) || pulse.atMs > clock.now() ||
        pulse.nextAtMs !== pulse.atMs + spec.periodMs || pulse.sourceKey !== `${journal.operationID}:${key}` ||
        pulse.domain !== spec.domain || pulse.stationObjectID !== spec.stationObjectID || !positive(pulse.sourceEntityID) ||
        pulse.pulseID !== `${pulse.sourceKey}:${pulse.sequence}` || pulse.proof !== pulseProof(pulse) ||
        !Array.isArray(pulse.targets) || pulse.targets.length > spec.maxTargets || new Set(pulse.targets.map(target => target.entityID)).size !== pulse.targets.length ||
        pulse.targets.some(target => !positive(target.entityID) || !positive(target.typeID) || !positive(target.ownerID) ||
          !(target.shieldCapacity > 0) || !Number.isFinite(target.shieldCapacity) || !(target.maximumAmount > 0) ||
          target.maximumAmount !== (spec.amount || target.shieldCapacity * spec.fraction) ||
          (spec.domain === "player" ? !positive(target.inventoryCustodyRevision) : typeof target.actorKey !== "string")) ||
        !pulse.acknowledgements || Object.keys(pulse.acknowledgements).some(id => !pulse.targets.some(target => String(target.entityID) === id)))) fail("INCURSION_SUPPORT_PULSE_INVALID");
  }
  if (fingerprint(journalOf(dungeon().getPersistedInstance(instance.instanceID))) !== fingerprint(journal)) save(instance.instanceID, journal);
  return structuredClone(journal);
}
function operationFor(instance) { return store.getOperation(require("./incursionAdmission").operationIdentity(instance).operationID); }
function enabled(instance, operation, spec) {
  try {
    logistics().assertOpen(instance, operation);
    const control = logistics().readControlState(instance, operation).controls[spec.controlKey];
    return spec.domain === "npc" ? clock.now() >= control.suppressedUntilMs
      : control.phase === "friendly" && clock.now() < control.friendlyUntilMs;
  } catch (_) { return false; }
}
function sourceInScene(scene, instance, spec, id = null) {
  const source = id ? scene?.getEntityByID?.(id) : [...(scene?.staticEntities || [])].find(entity =>
    entity.dungeonSiteInstanceID === instance.instanceID && entity.dunObjectID === spec.stationObjectID && entity.incursionLogisticsStation);
  const binding = logistics().context(instance).policy.mechanics.objectBindings[spec.stationObjectID];
  return source?.incursionLogisticsStation && source.typeID === 3510 && source.dungeonSiteInstanceID === instance.instanceID &&
    source.dunObjectID === spec.stationObjectID && source.dungeonRoomKey === binding.roomKey && scene.getEntityByID(source.itemID) === source ? source : null;
}
function eligible(scene, instance, operation, spec, source, target) {
  const abilities = require("../../space/npc/nativeNpcAbilities");
  if (!source || !abilities.live(target) || scene.getEntityByID(target.itemID) !== target ||
      require("./incursionHooks").isDamageInProgress(target) ||
      target.isCloaked || target.cloaked || !(target.shieldCapacity > 0) ||
      !(Number(target.conditionState?.shieldCharge ?? 1) < (spec.domain === "player" ? 0.5 : 1)) ||
      !abilities.sameScope(source, target) || abilities.distance(source, target) > spec.rangeMeters + 1) return false;
  if (spec.domain === "player") return Number(target.groupID) !== 29 && !target.nativeNpc && Boolean(require("./incursionEncounterRuntime").sourcePilot(scene, instance, target));
  const birth = operation.births[target.dungeonSiteContentKey];
  return target.nativeNpc === true && target.incursionOperationID === operation.identity.operationID && birth?.entityID === target.itemID &&
    birth.typeID === target.typeID && !operation.retirements[target.dungeonSiteContentKey] && require("./incursionSiteModel").birthsReady(operation, target.dungeonSiteContentKey);
}
function requestFor(instance, pulse, target) {
  return { instanceID: instance.instanceID, stationObjectID: pulse.stationObjectID, pulseID: pulse.pulseID,
    sequence: pulse.sequence, sourceKey: pulse.sourceKey, proof: pulse.proof, targetID: target.entityID };
}
function validateRequest(request) {
  const instance = dungeon().getInstance(request?.instanceID), operation = instance && operationFor(instance);
  if (!operation || !specs(instance).length) fail("INCURSION_SUPPORT_REQUEST_INVALID");
  const journal = ensure(instance, operation), spec = specs(instance).find(spec => spec.stationObjectID === request.stationObjectID);
  const pulse = journal?.sources[request.stationObjectID]?.pulse, target = pulse?.targets.find(target => target.entityID === request.targetID);
  if (!spec || !pulse || !target || pulse.proof !== request.proof || pulse.pulseID !== request.pulseID ||
      pulse.sequence !== request.sequence || pulse.sourceKey !== request.sourceKey) fail("INCURSION_SUPPORT_REQUEST_INVALID");
  return { instance, operation, spec, pulse, target };
}
function freshAllowed(request, scene, source, target) {
  const scope = validateRequest(request), { instance, operation, spec, pulse } = scope;
  return Boolean(scene && clock.now() < pulse.nextAtMs && enabled(instance, operation, spec) &&
    sourceInScene(scene, instance, spec, pulse.sourceEntityID) === source && eligible(scene, instance, operation, spec, source, target) &&
    target.typeID === scope.target.typeID && target.ownerID === scope.target.ownerID && target.shieldCapacity === scope.target.shieldCapacity);
}
// Called by each HP owner before its atomic mutation. Never accept an old
// health preimage just because a controller retried an already committed pulse.
function healthCommit(request, prior, calculate) {
  const scope = validateRequest(request), { pulse, target } = scope;
  if (prior && (prior.sequence > pulse.sequence || prior.sequence === pulse.sequence && prior.proof !== pulse.proof)) fail("INCURSION_SUPPORT_HEALTH_FENCE");
  const state = prior?.sequence === pulse.sequence ? structuredClone(prior)
    : { sequence: pulse.sequence, pulseID: pulse.pulseID, proof: pulse.proof, applied: {} };
  if (state.applied[target.entityID]) return { duplicate: true, state, receipt: state.applied[target.entityID], scope };
  const result = calculate(target);
  if (!result || result.skipped) return { skipped: true, scope };
  const { before, after, amount } = result;
  if (![before, after].every(row => row && ["shieldCharge", "armorDamage", "damage"].every(key => Number.isFinite(row[key]) && row[key] >= 0 && row[key] <= 1)) ||
      before.armorDamage !== after.armorDamage || before.damage !== after.damage || before.damage >= 1 ||
      !(amount > 0) || amount > target.maximumAmount + 1e-6 || Math.abs(amount - (after.shieldCharge - before.shieldCharge) * target.shieldCapacity) > 1e-6) fail("INCURSION_SUPPORT_HEALTH_AMOUNT_INVALID");
  const receipt = { before, after, amount }; state.applied[target.entityID] = structuredClone(receipt);
  return { scope, state, receipt, duplicate: false };
}
function reconcile(instance, operation, { scene = null } = {}) {
  if (!specs(instance).length || !journalOf(dungeon().getInstance(instance.instanceID))) return;
  if (active.has(instance.instanceID)) return;
  active.add(instance.instanceID);
  try {
    scene ||= require.cache[require.resolve("../../space/runtime")]?.exports?.scenes?.get(instance.solarSystemID) || null;
    let journal = ensure(instance, operation);
    for (const [key, row] of Object.entries(journal.sources)) {
      const pulse = row.pulse, spec = specs(instance).find(spec => String(spec.stationObjectID) === key);
      if (!pulse) continue;
      for (const target of pulse.targets) {
        if (pulse.acknowledgements[target.entityID] && scene?.getEntityByID?.(target.entityID)?.incursionLogisticsRepairPending !== pulse.pulseID) continue;
        const result = require("../../space/modules/assistanceModuleRuntime").applyIncursionShieldPulse({
          request: requestFor(instance, pulse, target), scene, source: sourceInScene(scene, instance, spec, pulse.sourceEntityID),
          target: scene?.getEntityByID?.(target.entityID) });
        if (!result.success || result.pending) continue;
        // Reread after the health owner: reentrant writes must not be lost.
        journal = ensure(instance, operation);
        journal.sources[key].pulse.acknowledgements[target.entityID] = result.skipped ? "skipped" : "applied";
        save(instance.instanceID, journal);
      }
    }
  } finally { active.delete(instance.instanceID); }
}
function tick(scene, instance, operation) {
  if (!specs(instance).length) return;
  reconcile(instance, operation, { scene });
  if (operation.status !== "active") return;
  let journal = ensure(instance, operation);
  for (const spec of specs(instance)) {
    if (!enabled(instance, operation, spec)) continue;
    const source = sourceInScene(scene, instance, spec); if (!source) continue;
    const key = String(spec.stationObjectID), controls = logistics().readControlState(instance, operation).controls;
    const epoch = spec.domain === "player" ? controls[spec.controlKey].lastWinID : "station";
    let row = journal.sources[key];
    if (row?.pulse && row.pulse.targets.some(target => !row.pulse.acknowledgements[target.entityID])) continue;
    if (!row || row.epoch !== epoch) {
      row = journal.sources[key] = { sequence: row?.sequence || 0, epoch, nextAtMs: clock.now() + spec.periodMs, pulse: null };
      save(instance.instanceID, journal); continue;
    }
    if (clock.now() < row.nextAtMs) continue;
    const targets = [...(scene.dynamicEntities?.values() || [])].filter(target => eligible(scene, instance, operation, spec, source, target))
      .sort((a, b) => Number(a.conditionState.shieldCharge) - Number(b.conditionState.shieldCharge) ||
        require("../../space/npc/nativeNpcAbilities").distance(source, a) - require("../../space/npc/nativeNpcAbilities").distance(source, b) || a.itemID - b.itemID).slice(0, spec.maxTargets);
    if (!targets.length) continue;
    const snapshots = targets.map(target => {
      let inventoryCustodyRevision;
      if (spec.domain === "player") {
        const tracked = require("../inventory/itemStore").trackItemCustodyRevision(target.itemID);
        if (!tracked.success) fail(tracked.errorMsg); inventoryCustodyRevision = tracked.data.inventoryCustodyRevision;
      }
      return { entityID: target.itemID, typeID: target.typeID, ownerID: target.ownerID, shieldCapacity: target.shieldCapacity,
        maximumAmount: spec.amount || target.shieldCapacity * spec.fraction,
        ...(spec.domain === "player" ? { inventoryCustodyRevision } : { actorKey: target.dungeonSiteContentKey }) };
    });
    const sequence = row.sequence + 1, sourceKey = `${operation.identity.operationID}:${key}`;
    if (!positive(sequence)) fail("INCURSION_SUPPORT_SEQUENCE_LIMIT");
    const pulse = { sequence, sourceKey, pulseID: `${sourceKey}:${sequence}`, stationObjectID: spec.stationObjectID, sourceEntityID: source.itemID,
      domain: spec.domain, atMs: clock.now(), nextAtMs: clock.now() + spec.periodMs, targets: snapshots, acknowledgements: {} };
    pulse.proof = pulseProof(pulse); row.pulse = pulse; row.sequence = sequence; row.nextAtMs = pulse.nextAtMs;
    save(instance.instanceID, journal); reconcile(instance, operation, { scene }); journal = ensure(instance, operation);
  }
}
function beforePurge(instance) {
  if (!instance || !journalOf(instance)) return;
  const operation = operationFor(instance);
  if (!operation) fail("INCURSION_SUPPORT_OPERATION_MISSING");
  reconcile(instance, operation);
  if (Object.values(ensure(instance, operation).sources).some(row => row.pulse?.targets.some(target => !row.pulse.acknowledgements[target.entityID])))
    fail("INCURSION_SUPPORT_HEALTH_PENDING");
}
module.exports = { VERSION, specs, validateRequest, freshAllowed, healthCommit, reconcile, tick, beforePurge };
