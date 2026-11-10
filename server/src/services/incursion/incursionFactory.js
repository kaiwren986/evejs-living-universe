"use strict";
const { fingerprint, fail } = require("./incursionLifecycleContract"), clock = require("./incursionClock");
const items = require("../inventory/itemStore"), custody = require("../inventory/incursionFactoryCustody");
const VERSION = "evejs.incursion-mtac-factory.v1", KEY = "incursion-factory:1011577", active = new Set();
const runtime = () => require("../dungeon/dungeonRuntime");
const positive = value => Number.isSafeInteger(value) && value > 0;
const checked = result => { if (!result?.success) fail(result?.errorMsg || "INCURSION_FACTORY_PENDING"); return result; };
function context(instance) {
  if (instance?.runtimeFlags?.incursionRuntime !== true || instance.sourceDungeonID !== 5175) return null;
  const policy = require("./incursionAdmission").admittedPolicy(instance);
  if (policy?.version !== 2) return null;
  const rule = policy.mechanics.objectives.find(row => row.key === "mtac-factory"), binding = policy.mechanics.objectBindings[rule?.nativeObjectID];
  if (rule?.typeID !== 3498 || rule.nativeObjectID !== 1011577 || rule.producesTypeID !== 3501 || rule.unitVolumeM3 !== 7500 ||
      rule.production?.firstUnit !== "on-room-activation" || rule.production.quantity !== 1 || rule.production.maximumAvailable !== 1 ||
      rule.production.refillAfterWithdrawalMs !== 60000 || binding?.typeID !== 3498) fail("INCURSION_FACTORY_POLICY_INVALID");
  return { policy, rule, binding };
}
function save(instanceID, journal) { return runtime().mergeSpawnState(instanceID, { incursionFactory: journal }, { durable: true, force: true }); }
function validate(instance, operation, journal) {
  if (instance.sourceDungeonID !== 5175 || operation.identity.instanceID !== instance.instanceID || operation.identity.dungeonID !== 5175 ||
      journal.version !== VERSION || journal.operationID !== operation.identity.operationID || journal.policyFingerprint !== operation.policyFingerprint ||
      !positive(journal.activatedAtMs) || journal.activatedAtMs > clock.now() || !Number.isSafeInteger(journal.serial) || journal.serial < 0 ||
      journal.serial > 65536 || Object.keys(journal.productions || {}).length !== journal.serial ||
      (journal.factoryID !== null && !positive(journal.factoryID)) || (journal.serial > 0 && !positive(journal.factoryID)) ||
      (journal.closedAtMs !== undefined && (!positive(journal.closedAtMs) || journal.closedAtMs > clock.now()))) fail("INCURSION_FACTORY_STATE_INVALID");
  for (const [key, row] of Object.entries(journal.productions)) if (key !== String(row.serial) || !positive(row.serial) || row.serial > journal.serial ||
      row.productionKey !== `incursion-mtac:${instance.instanceID}:${row.serial}` || !positive(row.atMs) || row.atMs < journal.activatedAtMs ||
      row.atMs > clock.now() || !["prepared", "born", "withdrawn"].includes(row.status)) fail("INCURSION_FACTORY_STATE_INVALID");
}
function open(instance, operation) {
  if (operation?.status !== "active" || instance.spawnState?.incursionFactory?.closedAtMs) return false;
  const lifecycle = require("./incursionLifecycle"), tale = lifecycle.getTale(operation.identity.taleID);
  if (!tale || tale.poolGroupID !== operation.identity.poolGroupID || tale.generation !== operation.identity.generation) fail("INCURSION_FACTORY_TALE_SCOPE_INVALID");
  if (tale.terminal || clock.now() >= tale.expiresAtMs) return false;
  // An unavailable owner or refused evidence fence must retry, not permanently
  // close an otherwise active factory as if the tale had actually ended.
  require("./incursionTerminalContract").assertCompletionOpen(operation.identity, clock.now());
  lifecycle.siteAdmission({ ...instance.metadata.incursionAdmission, instanceID: instance.instanceID,
    solarSystemID: instance.solarSystemID }, clock.now());
  return !require("./incursionStructures").getCommittedDeath(instance, "research-center");
}
function canWithdraw(parent) {
  if (!custody.isFactory(parent)) return false;
  const instance = runtime().getInstance(parent.spaceState.dungeonSiteInstanceID), ctx = context(instance);
  const operation = ctx && require("./incursionRewardStore").getOperation(require("./incursionAdmission").operationIdentity(instance).operationID);
  try { return Boolean(operation && open(instance, operation) && instance.spawnState?.incursionFactory?.factoryID === parent.itemID); }
  catch (_) { return false; }
}
function materialize(scene, instance, ctx, journal) {
  if (!scene) return;
  const existing = journal.factoryID && scene.getEntityByID(journal.factoryID);
  if (existing) {
    if (existing.typeID !== 3498 || existing.kind !== "container" || existing.dungeonSiteInstanceID !== instance.instanceID ||
        existing.dungeonSiteContentKey !== KEY) fail("INCURSION_FACTORY_ENTITY_COLLISION");
    return;
  }
  const sites = require("../dungeon/dungeonUniverseSiteService"), template = require("../dungeon/dungeonAuthority").getTemplateByID(instance.templateID);
  const binding = ctx.binding;
  const entity = sites.incursionStructurePorts.describe(instance, { key: KEY, exact: true, typeID: binding.typeID, roomKey: binding.roomKey,
    dunObjectID: binding.objectID, dunObjectNameID: binding.nameID, positionOffset: structuredClone(binding.positionOffset),
    ...(binding.dunRotation ? { dunRotation: structuredClone(binding.dunRotation) } : {}), legacyEnvironmentOrdinal: 800 });
  Object.assign(entity, { dungeonSiteContentKey: KEY, dungeonSiteContentRole: "incursion_mtac_factory",
    dungeonSiteContentPersistsAfterResponse: true, dungeonSourceObjectID: binding.objectID });
  if (!sites.homefrontPorts.materializeContainer(scene, instance, sites.buildSiteEntity(instance), template, {}, entity,
    { nowMs: journal.activatedAtMs, broadcast: true })) fail("INCURSION_FACTORY_HULL_PENDING");
}
function hullID(instance) { return runtime().getInstance(instance.instanceID)?.spawnState?.contentEntityRefsByKey?.[KEY]?.itemID || null; }
function stockProof(instance, journal, row) {
  const receipt = checked(items.getIdempotentGrantReceipt(row.productionKey, { requireDurable: true, reconcileWriteRefusal: true }));
  if (!receipt.found) return null;
  const ids = receipt.data.resultData?.itemIDs;
  if (!receipt.durable || receipt.data.ownerID !== 1 || receipt.data.locationID !== journal.factoryID || receipt.data.flagID !== items.ITEM_FLAGS.CARGO_HOLD ||
      !Array.isArray(ids) || ids.length !== 1 || !positive(ids[0])) fail("INCURSION_FACTORY_BIRTH_PROOF_INVALID");
  return { itemID: ids[0], proof: fingerprint(receipt.data) };
}
function publishStock(instance, journal, row, scene) {
  if (!row.notificationPending || !scene) return;
  const entity = scene.getEntityByID(journal.factoryID), item = items.findItemById(row.itemID);
  if (!entity || !item || item.locationID !== journal.factoryID || row.status !== "born") return;
  for (const session of scene.sessions?.values() || []) {
    const ship = scene.getShipEntityForSession?.(session);
    if (!ship || session.socket?.destroyed || !require("../../space/destiny/identity/interactionScope").canEntitiesInteractLocally(ship, entity)) continue;
    const distance = Math.hypot(...["x", "y", "z"].map(axis => Number(ship.position?.[axis]) - Number(entity.position?.[axis]))) -
      Math.max(0, Number(ship.radius) || 0) - Math.max(0, Number(entity.radius) || 0);
    if (!Number.isFinite(distance) || distance > 2500) continue;
    require("../character/characterState").emitItemsChangedBatchForSession(session,
      [{ removed: false, item, previousData: items.buildCreatedItemNotificationPreviousState(item) }]);
  }
  // Publication may repeat after a refused acknowledgement. It sends current
  // inventory state and never repeats production or a player custody move.
  row.notificationPending = false; save(instance.instanceID, journal);
}
function reconcile(instance, operation, { scene = null } = {}) {
  const ctx = context(instance);
  if (!ctx || active.has(instance.instanceID)) return;
  active.add(instance.instanceID);
  try {
    let journal = structuredClone(runtime().getInstance(instance.instanceID)?.spawnState?.incursionFactory || null);
    if (!open(instance, operation)) { if (journal) close(instance, operation, journal, scene); return; }
    const enteredAt = operation.mechanics?.roomEntries?.[ctx.binding.roomKey];
    if (!journal) {
      if (!positive(enteredAt) || !operation.policy.stages.some(stage => stage.roomKey === ctx.binding.roomKey && operation.stages[stage.key]?.active)) return;
      journal = { version: VERSION, operationID: operation.identity.operationID, policyFingerprint: operation.policyFingerprint,
        activatedAtMs: enteredAt, factoryID: null, serial: 0, productions: {} };
      save(instance.instanceID, journal);
    }
    validate(instance, operation, journal); save(instance.instanceID, journal);
    materialize(scene, instance, ctx, journal);
    if (!journal.factoryID) {
      journal.factoryID = hullID(instance);
      if (!journal.factoryID) return; // Offline activation waits for its native hull, not a fabricated location.
      save(instance.instanceID, journal);
    }
    const parent = items.findItemById(journal.factoryID);
    if (!custody.isFactory(parent) || parent.spaceState.dungeonSiteInstanceID !== instance.instanceID) fail("INCURSION_FACTORY_HULL_MISMATCH");
    let row = journal.productions[journal.serial];
    if (row) {
      const born = stockProof(instance, journal, row);
      if (born) {
        const needsNotification = row.status === "prepared";
        if (row.itemID && (row.itemID !== born.itemID || row.proof !== born.proof)) fail("INCURSION_FACTORY_BIRTH_PROOF_INVALID");
        row.itemID = born.itemID; row.proof = born.proof;
        const withdrawal = checked(items.getIncursionFactoryWithdrawal(row.productionKey));
        if (withdrawal.found) {
          const fact = withdrawal.data;
          if (fact.version !== custody.VERSION || fact.instanceID !== instance.instanceID || fact.productionKey !== row.productionKey ||
              fact.factoryID !== journal.factoryID || fact.itemID !== born.itemID || fact.operationID !== operation.identity.operationID ||
              fact.policyFingerprint !== operation.policyFingerprint || fact.serial !== row.serial || fact.quantity !== 1 ||
              fact.sourceOwnerID !== 1 || !(fact.destinationOwnerID > 1) || !positive(fact.destinationItemID) || !positive(fact.destinationLocationID) ||
              !positive(fact.atMs) || fact.atMs < row.atMs || fact.atMs > clock.now() ||
              (row.withdrawalProof && (row.withdrawalProof !== fingerprint(fact) || row.withdrawnAtMs !== fact.atMs))) fail("INCURSION_FACTORY_WITHDRAWAL_INVALID");
          row.status = "withdrawn"; row.withdrawnAtMs = fact.atMs; row.withdrawalProof = fingerprint(fact); row.notificationPending = false;
        } else {
          const stockItem = items.findItemById(born.itemID);
          if (!stockItem || stockItem.locationID !== journal.factoryID || stockItem.quantity !== 1 ||
              fingerprint(custody.stock(stockItem)) !== fingerprint({ version: custody.VERSION, instanceID: instance.instanceID,
                operationID: operation.identity.operationID, policyFingerprint: operation.policyFingerprint,
                factoryID: journal.factoryID, serial: row.serial, productionKey: row.productionKey })) fail("INCURSION_FACTORY_STOCK_MISSING");
          row.status = "born";
          if (needsNotification) row.notificationPending = true;
        }
        save(instance.instanceID, journal);
        publishStock(instance, journal, row, scene);
      } else if (row.status !== "prepared") fail("INCURSION_FACTORY_BIRTH_PROOF_MISSING");
    }
    const due = row ? row.status === "withdrawn" ? row.withdrawnAtMs + ctx.rule.production.refillAfterWithdrawalMs : null : journal.activatedAtMs;
    if (due !== null && due <= clock.now()) {
      if (journal.serial >= 65536) fail("INCURSION_FACTORY_GENERATION_LIMIT");
      row = { serial: ++journal.serial, productionKey: `incursion-mtac:${instance.instanceID}:${journal.serial}`, status: "prepared", atMs: due };
      journal.productions[row.serial] = row; save(instance.instanceID, journal);
    }
    if (row?.status === "prepared") {
      if (items.listContainerItems(null, journal.factoryID).length) fail("INCURSION_FACTORY_CAPACITY_CONFLICT");
      checked(items.grantItemsToOwnerLocationIdempotent(1, journal.factoryID, items.ITEM_FLAGS.CARGO_HOLD,
        [{ itemType: require("../inventory/itemTypeRegistry").resolveItemByTypeID(3501), quantity: 1,
          options: { createdAtMs: row.atMs, customInfo: JSON.stringify({ incursionMtac: { version: custody.VERSION,
            instanceID: instance.instanceID, operationID: operation.identity.operationID, policyFingerprint: operation.policyFingerprint,
            factoryID: journal.factoryID, serial: row.serial, productionKey: row.productionKey } }) } }],
        { receiptKey: row.productionKey, grantedAtMs: row.atMs }));
      const born = stockProof(instance, journal, row);
      if (!born) fail("INCURSION_FACTORY_BIRTH_PROOF_MISSING");
      Object.assign(row, born, { status: "born", notificationPending: true }); save(instance.instanceID, journal);
      publishStock(instance, journal, row, scene);
    }
  } finally { active.delete(instance.instanceID); }
}
function close(instance, operation, journal, scene) {
  validate(instance, operation, journal);
  journal.closedAtMs ||= clock.now();
  journal.factoryID ||= hullID(instance);
  if (!journal.factoryID) {
    const receipt = checked(items.getIdempotentGrantReceipt(`incursion-factory-content:${instance.instanceID}:${KEY}:0`, { requireDurable: true }));
    if (receipt.found) journal.factoryID = receipt.data.resultData?.itemIDs?.[0] || null;
  }
  save(instance.instanceID, journal);
  const parent = journal.factoryID && items.findItemById(journal.factoryID);
  if (parent) {
    if (!custody.isFactory(parent) || parent.spaceState.dungeonSiteInstanceID !== instance.instanceID) fail("INCURSION_FACTORY_HULL_MISMATCH");
    checked(items.removeInventoryItem(parent.itemID, { removeContents: true }));
  }
  checked(require("../../gameStore").flushTableSync("items"));
  const live = scene?.getEntityByID(journal.factoryID);
  if (live) {
    if (live.typeID !== 3498 || live.kind !== "container" || live.dungeonSiteInstanceID !== instance.instanceID ||
        live.dungeonSiteContentKey !== KEY) fail("INCURSION_FACTORY_ENTITY_COLLISION");
    checked(require("../../space/runtime").removeDynamicEntity(instance.solarSystemID,
      journal.factoryID, { allowSessionOwned: true, broadcast: true }));
  }
}
function beforePurge(instance) {
  const journal = instance?.spawnState?.incursionFactory;
  if (!journal) return;
  const operation = require("./incursionRewardStore").getOperation(journal.operationID);
  if (!operation) fail("INCURSION_FACTORY_OPERATION_MISSING");
  close(instance, operation, structuredClone(journal),
    require.cache[require.resolve("../../space/runtime")]?.exports?.scenes?.get(instance.solarSystemID) || null);
}
module.exports = { VERSION, reconcile, canWithdraw, beforePurge };
