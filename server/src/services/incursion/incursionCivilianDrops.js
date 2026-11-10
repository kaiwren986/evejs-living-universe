"use strict";

// OCF's reviewed short-range groups release real cargo. A retirement is only
// an index: native health receipts independently prove every death and its
// position. Inventory receipts permanently own each hull and stock birth.
const { fail, fingerprint } = require("./incursionLifecycleContract");
const clock = require("./incursionClock"), model = require("./incursionSiteModel");
const carrier = require("../inventory/incursionCombatOutcomes"), items = require("../inventory/itemStore");
const VERSION = "evejs.incursion-ocf-civilian-drops.v1", LIFETIME_MS = 2 * 60 * 60 * 1000;
const anchors = [1010578, 1010581, 1010582, 1010583], active = new Set();
const positive = value => Number.isSafeInteger(value) && value > 0;
const checked = result => { if (!result?.success) fail(result?.errorMsg || "INCURSION_CIVILIAN_DROP_PENDING"); return result; };
const runtime = () => require("../dungeon/dungeonRuntime");
function rules(instance, operation) {
  if (instance?.runtimeFlags?.incursionRuntime !== true || instance.sourceDungeonID !== 5167 || operation?.version !== 2) return [];
  if (operation.identity.instanceID !== instance.instanceID || operation.identity.dungeonID !== 5167 ||
      fingerprint(require("./incursionAdmission").admittedPolicy(instance)) !== operation.policyFingerprint) fail("INCURSION_CIVILIAN_DROP_SCOPE_INVALID");
  return anchors.map((anchor, index) => {
    const stageKey = `ocf-${index + 1}`, stage = operation.policy.stages.find(row => row.key === stageKey);
    const rule = operation.policy.mechanics.stageRules.find(row => row.key === stageKey);
    const drop = rule?.onShortRangeGroupDestroyed?.spawnRealCargo;
    const group = rule?.groups.find(row => row.key === `anchor-${anchor}` && row.anchorObjectID === anchor);
    const actors = stage?.actors.filter(actor => actor.groupKey === group?.key && actor.nativeAnchorObjectID === anchor);
    if (!group?.actorKeys?.length || !actors?.length || fingerprint(actors.map(actor => actor.key).sort()) !== fingerprint([...group.actorKeys].sort()) ||
        drop?.typeID !== 3483 || drop.quantity !== 15 || drop.containerTypeID !== 23 || drop.at !== "last destroyed short-range actor position" ||
        drop.receiptKey !== `ocf:wave:${index + 1}:civilians` || stage.roomKey !== "room:23354") fail("INCURSION_CIVILIAN_DROP_POLICY_INVALID");
    return { stageKey, group, actors, drop, roomKey: stage.roomKey };
  });
}
function deaths(operation, rule) {
  if (!rule.actors.every(actor => model.birthsReady(operation, actor.key) && operation.retirements[actor.key]?.deathEventID)) return null;
  const facts = rule.actors.map(actor => {
    const birth = operation.births[actor.key], retired = operation.retirements[actor.key];
    const result = checked(carrier.readNpcOutcome(retired.deathEventID)), receipt = result.data, event = receipt?.event;
    if (!result.found || retired.reason !== "destroyed" || retired.entityID !== birth.entityID || retired.typeID !== actor.typeID ||
        birth.typeID !== actor.typeID || !positive(receipt.ordinal) || receipt.conditionState?.damage < 1 ||
        !Number.isFinite(receipt.conditionState?.damage) || event.operationID !== operation.identity.operationID ||
        event.instanceID !== operation.identity.instanceID || event.targetKey !== actor.key || event.targetEntityID !== birth.entityID ||
        event.targetTypeID !== actor.typeID || event.kind !== "damage" || event.destroyed !== true || !(event.amount > 0) ||
        event.completionWallTimeMs !== retired.retiredAtMs || !positive(event.completionWallTimeMs) || event.completionWallTimeMs > clock.now() ||
        !event.deathPosition || ["x", "y", "z"].some(axis => !Number.isFinite(event.deathPosition[axis])) ||
        operation.events[event.eventID] !== fingerprint(event)) fail("INCURSION_CIVILIAN_DEATH_PROOF_INVALID");
    return { eventID: event.eventID, ordinal: receipt.ordinal, atMs: event.completionWallTimeMs,
      position: structuredClone(event.deathPosition), proof: fingerprint({ event, ordinal: receipt.ordinal, conditionState: receipt.conditionState }) };
  }).sort((a, b) => a.ordinal - b.ordinal);
  if (new Set(facts.map(row => row.ordinal)).size !== facts.length || new Set(facts.map(row => row.eventID)).size !== facts.length)
    fail("INCURSION_CIVILIAN_DEATH_PROOF_INVALID");
  return { facts, position: facts.at(-1).position, atMs: facts.at(-1).atMs };
}
function save(instance, journal) {
  const current = runtime().getInstance(instance.instanceID)?.spawnState?.incursionCivilianDrops;
  if (fingerprint(current || null) !== fingerprint(journal)) runtime().mergeSpawnState(instance.instanceID,
    { incursionCivilianDrops: journal }, { durable: true, force: true });
  // A previous accepted merge may still be dirty after its refused fence.
  checked(require("../../gameStore").flushTableSync("dungeonRuntimeState"));
}
function open(instance, operation) {
  if (operation.status !== "active") return false;
  const lifecycle = require("./incursionLifecycle"), tale = lifecycle.getTale(operation.identity.taleID);
  if (!tale || tale.poolGroupID !== operation.identity.poolGroupID || tale.generation !== operation.identity.generation) fail("INCURSION_CIVILIAN_DROP_SCOPE_INVALID");
  if (tale.terminal || clock.now() >= tale.expiresAtMs) return false;
  require("./incursionTerminalContract").assertCompletionOpen(operation.identity, clock.now());
  lifecycle.siteAdmission({ ...instance.metadata.incursionAdmission, instanceID: instance.instanceID, solarSystemID: instance.solarSystemID }, clock.now());
  return true;
}
function grantProof(key, ownerID, locationID, flagID, typeID, quantity) {
  const result = checked(items.getIdempotentGrantReceipt(key, { requireDurable: true, reconcileWriteRefusal: true }));
  if (!result.found) return null;
  const receipt = result.data, ids = receipt.resultData?.itemIDs;
  if (!result.durable || receipt.ownerID !== ownerID || receipt.locationID !== locationID || receipt.flagID !== flagID ||
      !Array.isArray(ids) || ids.length !== 1 || !positive(ids[0]) ||
      fingerprint(receipt.manifest) !== fingerprint([{ typeID, quantity }])) fail("INCURSION_CIVILIAN_BIRTH_PROOF_INVALID");
  return { itemID: ids[0], proof: fingerprint(receipt) };
}
function hull(instance, row) {
  const item = row.hullID && items.findItemById(row.hullID);
  if (!item) return null;
  if (item.typeID !== 23 || item.ownerID !== 1 || item.locationID !== instance.solarSystemID || item.flagID !== 0 ||
      item.spaceState?.dungeonSiteInstanceID !== instance.instanceID || item.spaceState?.dungeonSiteContentKey !== row.key ||
      item.expiresAtMs !== row.atMs + LIFETIME_MS) fail("INCURSION_CIVILIAN_HULL_INVALID");
  return item;
}
function removeHull(instance, row, scene) {
  const item = hull(instance, row), entity = liveHull(instance, row, scene);
  if (item) checked(items.removeInventoryItem(item.itemID, { removeContents: true }));
  checked(require("../../gameStore").flushTableSync("items"));
  if (entity) checked(require("../../space/runtime").removeDynamicEntity(instance.solarSystemID,
    row.hullID, { allowSessionOwned: true, broadcast: true }));
}
function liveHull(instance, row, scene) {
  const entity = row.hullID && scene?.getEntityByID(row.hullID);
  if (!entity) return null;
  if (entity.kind !== "container" || entity.typeID !== 23 || entity.ownerID !== 1 ||
      entity.dungeonSiteInstanceID !== instance.instanceID || entity.dungeonSiteContentKey !== row.key)
    fail("INCURSION_CIVILIAN_ENTITY_COLLISION");
  return entity;
}
function reconcile(instance, operation, { scene = null, closed = false, purge = false } = {}) {
  const reviewed = rules(instance, operation);
  if (!reviewed.length || active.has(instance.instanceID)) return;
  active.add(instance.instanceID);
  try {
    let journal = structuredClone(runtime().getInstance(instance.instanceID)?.spawnState?.incursionCivilianDrops || null);
    const mayProduce = !closed && !purge && open(instance, operation);
    if (!journal && !mayProduce) return;
    if (journal && (journal.version !== VERSION || journal.operationID !== operation.identity.operationID || journal.policyFingerprint !== operation.policyFingerprint ||
        !journal.drops || Object.keys(journal.drops).some(key => !reviewed.some(rule => rule.stageKey === key)))) fail("INCURSION_CIVILIAN_DROP_STATE_INVALID");
    for (const rule of reviewed) {
      let row = journal?.drops[rule.stageKey];
      const fact = deaths(operation, rule);
      if (!row && (!mayProduce || !fact || clock.now() >= fact.atMs + LIFETIME_MS)) continue;
      if (!journal) journal = { version: VERSION, operationID: operation.identity.operationID, policyFingerprint: operation.policyFingerprint, drops: {} };
      if (!row) {
        row = { key: `incursion-civilians:${instance.instanceID}:${rule.drop.receiptKey}`, ...fact, status: "prepared" };
        journal.drops[rule.stageKey] = row;
      }
      if (!fact || fingerprint({ facts: row.facts, position: row.position, atMs: row.atMs }) !== fingerprint(fact) ||
          row.key !== `incursion-civilians:${instance.instanceID}:${rule.drop.receiptKey}` || !["prepared", "born", "cancelled"].includes(row.status))
        fail("INCURSION_CIVILIAN_DROP_STATE_INVALID");
      save(instance, journal); // Fence the exact plan before either inventory birth, including retries.
      let bornHull = grantProof(`${row.key}:hull`, 1, instance.solarSystemID, 0, 23, 1);
      if (bornHull) {
        if (row.hullID && (row.hullID !== bornHull.itemID || row.hullProof !== bornHull.proof)) fail("INCURSION_CIVILIAN_BIRTH_PROOF_INVALID");
        row.hullID = bornHull.itemID; row.hullProof = bornHull.proof;
      } else if (row.hullID || row.status === "born") fail("INCURSION_CIVILIAN_BIRTH_PROOF_MISSING");
      let stock = row.hullID && grantProof(`${row.key}:stock`, 1, row.hullID, items.ITEM_FLAGS.CARGO_HOLD, 3483, 15);
      if (stock) {
        if (row.stockID && (row.stockID !== stock.itemID || row.stockProof !== stock.proof)) fail("INCURSION_CIVILIAN_BIRTH_PROOF_INVALID");
        if (row.status === "cancelled") fail("INCURSION_CIVILIAN_BIRTH_PROOF_INVALID");
        row.stockID = stock.itemID; row.stockProof = stock.proof; row.status = "born";
      } else if (row.stockID || row.status === "born") fail("INCURSION_CIVILIAN_BIRTH_PROOF_MISSING");
      if (purge || clock.now() >= row.atMs + LIFETIME_MS || row.status === "cancelled" || !mayProduce && !stock) {
        if (!stock) row.status = "cancelled";
        save(instance, journal); removeHull(instance, row, scene); continue;
      }
      if (!stock && bornHull && !hull(instance, row)) { row.status = "cancelled"; save(instance, journal); continue; }
      if (!bornHull) {
        const spaceState = { systemID: instance.solarSystemID, position: structuredClone(row.position),
          dungeonSiteID: instance.metadata.siteID, dungeonSiteInstanceID: instance.instanceID, dungeonRoomKey: rule.roomKey,
          dungeonSiteContentKey: row.key, dungeonSiteContentRole: "incursion_civilian_drop", dungeonMaterializedSiteContent: true };
        checked(items.grantItemsToOwnerLocationIdempotent(1, instance.solarSystemID, 0, [{ itemType: 23, quantity: 1,
          options: { singleton: true, itemName: "Civilian evacuation cargo", createdAtMs: row.atMs, expiresAtMs: row.atMs + LIFETIME_MS, spaceState } }],
        { receiptKey: `${row.key}:hull`, grantedAtMs: row.atMs }));
        bornHull = grantProof(`${row.key}:hull`, 1, instance.solarSystemID, 0, 23, 1);
        if (!bornHull) fail("INCURSION_CIVILIAN_BIRTH_PROOF_MISSING");
        row.hullID = bornHull.itemID; row.hullProof = bornHull.proof; save(instance, journal);
      }
      if (!stock) {
        hull(instance, row);
        checked(items.grantItemsToOwnerLocationIdempotent(1, row.hullID, items.ITEM_FLAGS.CARGO_HOLD, [{ itemType: 3483, quantity: 15,
          options: { createdAtMs: row.atMs } }], { receiptKey: `${row.key}:stock`, grantedAtMs: row.atMs }));
        stock = grantProof(`${row.key}:stock`, 1, row.hullID, items.ITEM_FLAGS.CARGO_HOLD, 3483, 15);
        if (!stock) fail("INCURSION_CIVILIAN_BIRTH_PROOF_MISSING");
        row.stockID = stock.itemID; row.stockProof = stock.proof; row.status = "born";
      }
      save(instance, journal);
      if (scene && hull(instance, row)) {
        liveHull(instance, row, scene);
        checked(require("../../space/runtime").spawnDynamicInventoryEntity(instance.solarSystemID, row.hullID, { broadcast: true }));
      }
    }
  } finally { active.delete(instance.instanceID); }
}
function beforePurge(instance) {
  const journal = instance?.spawnState?.incursionCivilianDrops;
  if (!journal) return;
  const operation = require("./incursionRewardStore").getOperation(journal.operationID);
  if (!operation) fail("INCURSION_CIVILIAN_OPERATION_MISSING");
  reconcile(instance, operation, { closed: true, purge: true,
    scene: require.cache[require.resolve("../../space/runtime")]?.exports?.scenes?.get(instance.solarSystemID) || null });
}
module.exports = { VERSION, LIFETIME_MS, rules, reconcile, beforePurge };
