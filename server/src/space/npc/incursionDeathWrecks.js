"use strict";

// The native HP outbox owns the immutable birth plan. Publication is separate
// from encounter acknowledgement and must survive NPC and wreck removal.
const database = require("../../gameStore");
const { isDeepStrictEqual } = require("node:util");
const { fingerprint } = require("../../services/incursion/incursionLifecycleContract");
const VERSION = "evejs.incursion-death-wreck.v1";
const uncertain = new Set();
const carrier = () => require("../../services/inventory/incursionCombatOutcomes");
const native = () => require("./nativeNpcStore");
const clone = value => JSON.parse(JSON.stringify(value));
const fail = code => { throw new Error(code); };
const checked = result => {
  if (!result?.success) fail(result?.errorMsg || "INCURSION_WRECK_PENDING");
  return result.data;
};
function row(table, path) {
  const result = database.read(table, path);
  if (result.success) return result.data;
  if (["ENTRY_NOT_FOUND", "TABLE_NOT_FOUND", "SQLITE_TABLE_NOT_FOUND"].includes(result.errorMsg)) return null;
  fail(result.errorMsg);
}
function binding(record) {
  return { entityID: Number(record.entityID || record.itemID), typeID: Number(record.typeID), ownerID: Number(record.ownerID),
    profileID: record.profileID, systemID: Number(record.systemID), dungeonSiteID: Number(record.dungeonSiteID),
    dungeonSiteInstanceID: Number(record.dungeonSiteInstanceID), dungeonSiteContentKey: record.dungeonSiteContentKey,
    dungeonEncounterKey: record.dungeonEncounterKey, incursionOperationID: record.incursionOperationID };
}
function prepare({ scene, entity, stored, event, sourceEntity }) {
  if (!event.destroyed || !scene) return null;
  if (!(event.amount > 0) || scene.getEntityByID?.(entity.itemID) !== entity || Number(scene.systemID) !== Number(stored.systemID) ||
      stored.transient !== false || stored.dungeonSiteContentRole !== "required_actor" || stored.dungeonMaterializedSiteContent !== true)
    fail("INCURSION_WRECK_SOURCE_INVALID");
  const owner = require("../runtime/combatDestruction").resolveNpcWreckOwnerContext(entity,
    { attackerEntity: sourceEntity, lethalDamageAmount: event.amount, destructionNowMs: event.atMs });
  const prepared = checked(require("./nativeNpcWreckService").prepareIncursionDeathWreck({ scene, entity, stored, event, owner }));
  const body = clone({ version: VERSION, eventID: event.eventID, eventProof: fingerprint(event), victim: binding(stored), ...prepared });
  const plan = { ...body, proof: fingerprint(body) };
  validate({ event, deathWreckPlan: plan, conditionState: entity.conditionState }, { ...stored, incursionDeathEventID: event.eventID });
  // Reserved IDs must be durable before an accepted HP receipt refers to them.
  checked(database.flushTablesSync(["npcWrecks", "npcWreckItems"]));
  return plan;
}
function validate(receipt, record) {
  const plan = receipt.deathWreckPlan, event = receipt.event;
  if (!plan || plan.version !== VERSION) fail("INCURSION_WRECK_VERSION_INVALID");
  const { proof, ...body } = plan;
  if (fingerprint(body) !== proof || plan.eventID !== event.eventID || plan.eventProof !== fingerprint(event) ||
      event.kind !== "damage" || event.destroyed !== true || !(event.amount > 0) || !(receipt.conditionState?.damage >= 1) ||
      plan.victim.entityID !== event.targetEntityID || plan.victim.typeID !== event.targetTypeID ||
      plan.victim.dungeonSiteInstanceID !== event.instanceID || plan.victim.incursionOperationID !== event.operationID ||
      plan.victim.dungeonSiteContentKey !== event.targetKey || plan.wreck?.sourceEntityID !== event.targetEntityID ||
      plan.wreck.incursionDeathEventID !== event.eventID || plan.wreck.transient !== false ||
      plan.wreck.systemID !== plan.victim.systemID || plan.wreck.profileID !== plan.victim.profileID ||
      Number(plan.wreck.dungeonSiteID) !== plan.victim.dungeonSiteID ||
      Number(plan.wreck.dungeonSiteInstanceID) !== plan.victim.dungeonSiteInstanceID ||
      plan.wreck.dungeonSiteContentKey !== plan.victim.dungeonSiteContentKey ||
      !Number.isSafeInteger(plan.wreck.createdAtMs) || plan.wreck.createdAtMs <= 0 ||
      !Number.isSafeInteger(plan.wreck.expiresAtMs) || plan.wreck.expiresAtMs <= plan.wreck.createdAtMs ||
      ["x", "y", "z"].some(axis => !Number.isFinite(plan.wreck.position?.[axis]) || !Number.isFinite(plan.wreck.direction?.[axis])) ||
      !Number.isSafeInteger(plan.wreck.wreckID) || plan.wreck.wreckID <= 0 || !Array.isArray(plan.items) || plan.items.length > 4096 ||
      new Set(plan.items.map(item => item.wreckItemID)).size !== plan.items.length || plan.items.some(item =>
        !Number.isSafeInteger(item.wreckItemID) || item.wreckItemID <= 0 || item.wreckID !== plan.wreck.wreckID ||
        item.incursionDeathEventID !== event.eventID || item.transient !== false || item.locationID !== plan.wreck.wreckID ||
        item.ownerID !== plan.wreck.ownerID || !Number.isSafeInteger(item.typeID) || item.typeID <= 0 ||
        !Number.isSafeInteger(item.quantity) || item.quantity <= 0)) fail("INCURSION_WRECK_PLAN_INVALID");
  if (record && (!isDeepStrictEqual(binding(record), plan.victim) || record.incursionDeathEventID !== event.eventID ||
      record.transient !== false || record.dungeonSiteContentRole !== "required_actor" ||
      record.dungeonMaterializedSiteContent !== true || !(record.conditionState?.damage >= 1))) fail("INCURSION_WRECK_ACTOR_MISMATCH");
  return plan;
}
function isPending(record) {
  const id = record?.incursionDeathEventID;
  if (id === undefined || id === null) return false;
  if (typeof id !== "string" || !id || id.length > 512) return true;
  if (uncertain.has(id)) return true;
  const receipt = row("npcEntities", `/incursionOutcomes/${carrier().storageKey(id)}`), plan = receipt?.deathWreckPlan;
  return receipt?.version !== 1 || receipt.deathWreckPublished !== true || plan?.version !== VERSION || plan.eventID !== id ||
    typeof plan.proof !== "string" || !/^[a-f0-9]{64}$/.test(plan.proof) || !Array.isArray(plan.items) ||
    record.incursionDeathPlanProof !== plan.proof || record.wreckID !== plan.wreck?.wreckID ||
    (record.wreckItemID && !plan.items?.some(item => item.wreckItemID === record.wreckItemID));
}
function publish(record) {
  if (record?.incursionDeathEventID === undefined || record?.incursionDeathEventID === null) return { success: true, handled: false };
  try {
    const id = record.incursionDeathEventID;
    const outcome = carrier().readNpcOutcome(id);
    const receipt = checked(outcome);
    if (!outcome.found) fail("INCURSION_WRECK_HP_PROOF_MISSING");
    const plan = validate(receipt, record);
    if (receipt.deathWreckPublished === true) {
      // readNpcOutcome fenced the source acknowledgement, including a retry
      // whose previous acknowledgement changed cache but failed to flush.
      uncertain.delete(id);
      return { success: true, handled: true, duplicate: true, data: { plan, wreck: native().getNativeWreck(plan.wreck.wreckID) } };
    }
    const wreck = { ...plan.wreck, incursionDeathPlanProof: plan.proof };
    const existing = row("npcWrecks", `/wrecks/${wreck.wreckID}`);
    if (existing && !isDeepStrictEqual(existing, wreck)) fail("INCURSION_WRECK_DESTINATION_CONFLICT");
    const items = plan.items.map(item => ({ ...item, incursionDeathPlanProof: plan.proof }));
    const currentItems = row("npcWreckItems", "/items") || {};
    for (const item of Object.values(currentItems).filter(item => item.wreckID === wreck.wreckID))
      if (!items.some(expected => isDeepStrictEqual(expected, item))) fail("INCURSION_WRECK_MANIFEST_CONFLICT");
    for (const item of items) if (currentItems[item.wreckItemID] && !isDeepStrictEqual(currentItems[item.wreckItemID], item))
      fail("INCURSION_WRECK_ITEM_ID_CONFLICT");
    if (!existing) checked(native().upsertNativeWreck(wreck, { transient: false }));
    for (const item of items) if (!currentItems[item.wreckItemID]) checked(native().upsertNativeWreckItem(item, { transient: false }));
    checked(database.flushTableSync("npcWrecks"));
    checked(database.flushTableSync("npcWreckItems"));
    // Never acknowledge publication until both destination tables are durable.
    uncertain.add(id);
    checked(database.write("npcEntities", `/incursionOutcomes/${carrier().storageKey(id)}`, { ...receipt, deathWreckPublished: true }));
    checked(database.flushTableSync("npcEntities"));
    uncertain.delete(id);
    return { success: true, handled: true, data: { plan, wreck: native().getNativeWreck(wreck.wreckID) } };
  } catch (error) { return { success: false, handled: true, errorMsg: error.message }; }
}
module.exports = { VERSION, prepare, publish, isPending };
