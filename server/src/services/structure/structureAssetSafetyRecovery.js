"use strict";

// The wallet/custody settlement of recovery, separate from safety's
// collection, timers and delivery. Only invbroker's checked destination adapter
// can start a withdrawal; persisted operations can resume after a restart.
const state = require("./structureAssetSafetyState");
const itemCustody = require("../inventory/itemCustody");
const { findItemById, listContainerItems } = require("../inventory/itemStore");
const { getAverageMarketPrices } = require("../_shared/averageMarketPrices");
const { getDockedLocationID } = require("./structureLocation");
const worldData = require("../../space/worldData");
const database = require("../../gameStore");
const log = require("../../utils/logger");
const { throwWrappedUserError } = require("../../common/machoErrors");
const { adjustCharacterBalanceAsync, getCharacterWallet, buildNotEnoughMoneyUserErrorValues,
  JOURNAL_ENTRY_TYPE } = require("../account/walletState");
const { isWalletAuthorityProcessEnabled } = require("../account/walletCommandAuthority");
const sessionRegistry = require("../chat/sessionRegistry");
const { getPersistedCorporationAuthority } = require("../corporation/corporationAuthority");
const { normalizeCorporationWalletKey, adjustCorporationWalletDivisionBalanceAsync,
  getCorporationWalletBalance } = require("../corporation/corpWalletState");

const queues = new Map();
let validateInventory = null;
let bootRecovery = null;
const clone = (value) => JSON.parse(JSON.stringify(value));
const quantityOf = (item) => Number(item.singleton) === 1 ? 1 : Number(item.stacksize ?? item.quantity);
const closed = (operation) => !operation || ["completed", "failed"].includes(operation.status);

function refuse(message) {
  throwWrappedUserError("CustomNotify", { notify: message });
}

function findSourceWrap(item) {
  const visited = new Set();
  let current = item;
  while (current) {
    const locationID = Number(current.locationID);
    if (!locationID || visited.has(locationID)) return null;
    visited.add(locationID);
    const wrap = state.getWrapByID(locationID, { refresh: false });
    if (wrap) return wrap;
    current = findItemById(locationID);
  }
  return null;
}

function fingerprintTree(itemID) {
  const rows = [];
  const pending = [Number(itemID)];
  const visited = new Set();
  while (pending.length) {
    const id = pending.shift();
    const item = findItemById(id);
    if (!item || visited.has(id)) refuse("The asset safety container tree is not valid.");
    visited.add(id);
    rows.push([id, Number(item.typeID), Number(item.ownerID), Number(item.locationID),
      Number(item.flagID), Number(item.singleton), quantityOf(item)]);
    pending.push(...listContainerItems(null, id, null).map((child) => Number(child.itemID)));
  }
  return JSON.stringify(rows.sort((a, b) => a[0] - b[0]));
}

function isOrdinarySourceContainer(item) {
  const { isCargoContainerType, isSecureCargoContainerType } = require("../ship/cargoContainerRuntime");
  return Number(item?.singleton) === 1 && isCargoContainerType(item) && !isSecureCargoContainerType(item);
}

function sourcePath(item, wrap) {
  if (!item || !wrap || Number(item.ownerID) !== Number(wrap.ownerID)) {
    refuse("This asset safety source is not available to you.");
  }
  const path = [];
  const seen = new Set([Number(item.itemID)]);
  let locationID = Number(item.locationID);
  while (locationID !== Number(wrap.assetWrapID)) {
    if (!Number.isSafeInteger(locationID) || locationID <= 0 || seen.has(locationID) || seen.size >= 64 ||
        state.getWrapByID(locationID, { refresh: false })) {
      refuse("The asset safety source ancestry is not valid.");
    }
    seen.add(locationID);
    const parent = findItemById(locationID);
    if (!parent || Number(parent.ownerID) !== Number(wrap.ownerID) || !isOrdinarySourceContainer(parent)) {
      refuse("Recovery through this source container is currently unavailable.");
    }
    path.push([Number(parent.itemID), Number(parent.typeID), Number(parent.ownerID),
      Number(parent.locationID), Number(parent.flagID), Number(parent.singleton), quantityOf(parent)]);
    locationID = Number(parent.locationID);
  }
  const rootFlag = path.length ? path[path.length - 1][4] : Number(item.flagID);
  if (wrap.ownerKind === "corp" && ![115, 116, 117, 118, 119, 120, 121, 184, 62, 187].includes(rootFlag)) {
    refuse("This corporation asset safety division is currently unavailable.");
  }
  return path;
}

function validateSourcePath(operation, leg) {
  const wrap = state.getWrapByID(operation.assetWrapID, { refresh: false });
  if (!wrap || !wrap.deliveredAt || wrap.deliverySaga?.deliveryMode !== "wrapped" ||
      Number(wrap.ownerID) !== Number(leg.sourceItem.ownerID)) {
    refuse("The original asset safety source is no longer available.");
  }
  if (Number(operation.schemaVersion) < 3) {
    // Old persisted operations were authorized only for direct wrap roots.
    if (Number(leg.sourceItem.locationID) !== Number(operation.assetWrapID)) {
      refuse("The original asset safety source needs inspection.");
    }
    return;
  }
  if (!Array.isArray(leg.sourcePath) ||
      Number(operation.sourceLocationID) !== Number(leg.sourceItem.locationID) ||
      JSON.stringify(sourcePath(leg.sourceItem, wrap)) !== JSON.stringify(leg.sourcePath)) {
    refuse("The asset safety source container changed while recovery was pending.");
  }
}

function expectedMovedTree(operation, leg) {
  const ownerID = Number(leg.destination.ownerID || operation.actorID);
  const sourceOwnerID = Number(leg.sourceItem.ownerID);
  const rows = JSON.parse(leg.treeFingerprint);
  for (const row of rows) {
    if (Number(row[0]) === Number(leg.sourceItem.itemID)) {
      row[0] = Number(leg.movedItem.itemID);
      row[2] = ownerID;
      row[3] = Number(leg.destination.locationID);
      row[4] = Number(leg.destination.flagID);
      row[6] = Number(leg.quantity);
    } else if (ownerID !== sourceOwnerID) {
      row[2] = ownerID;
    }
  }
  return JSON.stringify(rows.sort((a, b) => a[0] - b[0]));
}

function quote(assetWrapID, itemIDs, session, requestedQuantities = null) {
  const wrap = state.getWrapByID(assetWrapID, { refresh: false });
  const actorID = Number(session && (session.characterID || session.charid));
  let payer = { kind: "char", ownerID: actorID, accountKey: null };
  if (wrap?.ownerKind === "corp") {
    const authority = getPersistedCorporationAuthority(session);
    if (!authority || authority.corporationID !== wrap.ownerID || !(authority.isDirector || authority.isCEO)) {
      refuse("You do not have access to this corporation asset safety wrap.");
    }
    // User-approved emulator policy, not captured TQ payer parity: use the
    // server-owned active corporation division, just as account service does.
    payer = { kind: "corp", ownerID: wrap.ownerID,
      accountKey: normalizeCorporationWalletKey(session.corpAccountKey ?? session.corpaccountkey) };
  }
  if (!wrap || !actorID || (wrap.ownerKind === "char" && wrap.ownerID !== actorID) ||
      !wrap.deliveredAt || wrap.deliverySaga?.deliveryMode !== "wrapped" ||
      wrap.destinationID !== Number(getDockedLocationID(session))) {
    refuse("This asset safety wrap is not available at your current docked location.");
  }
  if (!Array.isArray(itemIDs) || itemIDs.length === 0 ||
      itemIDs.some((id) => !Number.isSafeInteger(Number(id)) || Number(id) <= 0)) {
    refuse("Select items in the delivered asset safety wrap to recover.");
  }
  const station = worldData.getStationByID(wrap.destinationID);
  const structure = station ? null : require("./structureState").getStructureByID(wrap.destinationID);
  const destinationSystemID = Number(station?.solarSystemID || structure?.solarSystemID);
  if (!destinationSystemID || !wrap.solarSystemID) refuse("The asset safety recovery location is not known.");
  const rate = destinationSystemID === wrap.solarSystemID ? 0.005 : 0.15;
  const roots = [];
  const selectedIDs = new Set(itemIDs.map(Number));
  const selectedTreeIDs = new Set();
  let sourceLocationID = null;
  const priced = new Set();
  let value = 0;
  const prices = getAverageMarketPrices();
  function addValue(item, quantity) {
    if (priced.has(Number(item.itemID))) return;
    priced.add(Number(item.itemID));
    if (Number(item.ownerID) !== wrap.ownerID || !(quantity > 0) || !Number.isSafeInteger(quantity)) {
      refuse("An item in this asset safety selection is no longer available to you.");
    }
    // These are the same average prices served by config.GetAverageMarketPrices.
    // That local authority currently uses SDE base prices. No rare-item estimate
    // or missing-price-as-zero rule is invented here.
    const price = Number(prices.get(Number(item.typeID))?.averagePrice);
    if (!(price > 0) || !Number.isFinite(price)) {
      refuse(`No recovery valuation is available for item type ${Number(item.typeID)}.`);
    }
    value += price * quantity;
    if (!Number.isFinite(value) || value > Number.MAX_SAFE_INTEGER / 100) {
      refuse("The asset safety selection is too large to price safely.");
    }
  }
  for (const id of [...new Set(itemIDs.map(Number))]) {
    const item = findItemById(id);
    const path = sourcePath(item, wrap);
    if (sourceLocationID !== null && sourceLocationID !== Number(item.locationID)) {
      refuse("Recover items from one source container at a time.");
    }
    sourceLocationID = Number(item.locationID);
    if (path.some(parent => selectedIDs.has(parent[0]))) {
      refuse("Select a container or its contents, rather than both.");
    }
    const available = quantityOf(item);
    const quantity = requestedQuantities ? Number(requestedQuantities[id]) : available;
    if (!Number.isSafeInteger(quantity) || quantity <= 0 || quantity > available) {
      refuse("The selected asset safety quantity is no longer available.");
    }
    const treeFingerprint = fingerprintTree(id);
    for (const row of JSON.parse(treeFingerprint)) {
      if (selectedTreeIDs.has(row[0])) refuse("The asset safety selections overlap.");
      selectedTreeIDs.add(row[0]);
    }
    roots.push({ item: clone(item), quantity, treeFingerprint, sourcePath: path });
    addValue(item, quantity);
    const pending = [id];
    const visited = new Set();
    while (pending.length) {
      const parentID = pending.shift();
      if (visited.has(parentID)) refuse("The asset safety container tree is not valid.");
      visited.add(parentID);
      for (const child of listContainerItems(null, parentID, null)) {
        if (quantity !== available) refuse("An item containing other items must be recovered whole.");
        addValue(child, quantityOf(child));
        pending.push(Number(child.itemID));
      }
    }
  }
  // Existing emulator ISK authority is cents. This is not captured TQ rounding.
  return { wrap: clone(wrap), actorID, payer, sourceLocationID, roots, value, rate, amount: Math.round(value * rate * 100) / 100 };
}

function save(wrapID, operation, nextGeneration) {
  const result = state.setWrapRecoveryState(wrapID, operation, nextGeneration);
  if (!result?.success) refuse("Asset safety recovery is awaiting a durable checkpoint. Retry after it finishes.");
  return result;
}

function validatePayer(operation, session) {
  if (operation.payer?.kind !== "corp") return;
  const payer = operation.payer;
  const wrap = state.getWrapByID(operation.assetWrapID, { refresh: false });
  const authority = getPersistedCorporationAuthority(session);
  if (!wrap || wrap.ownerKind !== "corp" || wrap.ownerID !== payer.ownerID ||
      operation.sourceOwnerID !== wrap.ownerID || !authority ||
      authority.characterID !== operation.actorID || authority.corporationID !== payer.ownerID ||
      !(authority.isDirector || authority.isCEO) ||
      !Number.isInteger(payer.accountKey) || payer.accountKey < 1000 || payer.accountKey > 1006 ||
      normalizeCorporationWalletKey(session.corpAccountKey ?? session.corpaccountkey) !== payer.accountKey) {
    refuse("Your corporation asset safety recovery authorization changed.");
  }
}

function flushWallet(operation) {
  if (isWalletAuthorityProcessEnabled()) return;
  const result = database.flushTableSync(operation.payer?.kind === "corp" ? "corporationRuntime" : "characters");
  if (!result?.success) refuse("Asset safety recovery is awaiting its wallet checkpoint.");
}

function walletOptions(operation, refund = false) {
  return {
    ownerID1: operation.payer?.ownerID || operation.actorID,
    // The exact TQ sink/counterparty envelope is not recorded. Use the existing
    // wallet sink representation; do not credit an invented corporation.
    ownerID2: 0,
    referenceID: operation.assetWrapID,
    entryTypeID: JOURNAL_ENTRY_TYPE.ASSET_SAFETY_TAX,
    description: `Asset safety ${refund ? "recovery refund" : "recovery"} ${operation.assetWrapID}`,
    idempotencyKey: `${operation.operationKey}:${refund ? "refund" : "debit"}`,
    ...(refund ? { requireExactCredit: true } : {}),
  };
}

async function walletLeg(operation, refund = false) {
  const options = walletOptions(operation, refund);
  let result;
  try {
    const metadata = {
      commandID: options.idempotencyKey,
      idempotencyKey: options.idempotencyKey,
      source: `assetSafety.recovery.${refund ? "refund" : "debit"}`,
    };
    const delta = (refund ? 1 : -1) * operation.amount;
    result = operation.payer?.kind === "corp"
      ? await adjustCorporationWalletDivisionBalanceAsync(operation.payer.ownerID,
        operation.payer.accountKey, delta, options, metadata)
      : await adjustCharacterBalanceAsync(operation.actorID, delta, options, metadata);
  } catch (error) {
    refuse(`The asset safety recovery ${refund ? "refund" : "charge"} is pending; retry after it finishes.`);
  }
  if (result?.pending || result?.ambiguous || result?.fingerprintMismatch ||
      result?.errorMsg === "IDEMPOTENCY_KEY_REUSED") {
    refuse(`The asset safety recovery ${refund ? "refund" : "charge"} is pending; retry after it finishes.`);
  }
  if (result?.success) flushWallet(operation);
  return result;
}

function moveLeg(operation, leg, rollback = false) {
  const source = rollback ? leg.movedItem : leg.sourceItem;
  const destination = rollback ? leg.sourceItem : leg.destination;
  const sourceOwnerID = Number(source.ownerID || operation.actorID);
  const destinationOwnerID = Number(destination.ownerID || operation.actorID);
  return itemCustody.transfer({
    items: { itemID: Number(source.itemID), quantity: leg.quantity },
    from: itemCustody.custodyRef.ownerLocation(sourceOwnerID, source.locationID, source.flagID),
    to: itemCustody.custodyRef.ownerLocation(destinationOwnerID, destination.locationID, destination.flagID),
    reason: sourceOwnerID === destinationOwnerID ? itemCustody.CUSTODY_REASON.ASSET_SAFETY_DELIVER
      : itemCustody.CUSTODY_REASON.INV_BROKER_OWNER_TRANSFER,
    actor: operation.actorID,
    idempotencyKey: `${operation.operationKey}:item:${leg.sourceItem.itemID}:${rollback ? "rollback" : "move"}`,
  });
}

function captureMove(operation, leg, data) {
  const changes = data?.changes || [];
  const moved = data?.item || changes.map((change) => change.item).find((item) => item &&
    Number(item.ownerID) === Number(leg.destination.ownerID || operation.actorID) && Number(item.locationID) === leg.destination.locationID &&
    Number(item.flagID) === leg.destination.flagID);
  if (!moved) refuse("The recovery custody receipt is incomplete; recovery remains pending.");
  leg.movedItem = clone(moved);
  leg.changes = clone(changes);
  leg.status = "committed";
}

function announce(operation, changes, success) {
  const session = sessionRegistry.findSessionByCharacterID(operation.actorID);
  const removedWrap = success && !state.getDeliveredWrapItem(operation.assetWrapID)
    ? [{ previousData: operation.wrapItem, item: {
      ...operation.wrapItem, singleton: 0, quantity: 0, stacksize: 0,
    } }] : [];
  const emit = require("../character/characterState").emitItemsChangedBatchForSession;
  if (session) emit(session, [...changes, ...removedWrap], { idType: "clientID", locationContext: null });
  if (operation.payer?.kind === "corp") {
    // Shared source-cache updates only to authorized local corporation readers.
    // This audience policy is not a captured TQ recovery notification envelope.
    for (const peer of sessionRegistry.getSessions()) {
      if (peer === session || Number(getDockedLocationID(peer)) !== Number(operation.wrapItem.locationID) ||
          !state.sessionCanManageCorporationSafety(peer, operation.payer.ownerID)) continue;
      const shared = changes.filter(change => Number(change.previousData?.ownerID) === operation.payer.ownerID ||
        Number(change.item?.ownerID) === operation.payer.ownerID);
      if (shared.length || removedWrap.length) {
        emit(peer, [...shared, ...removedWrap], { idType: "clientID", locationContext: null });
      }
    }
  }
}

async function compensate(operation) {
  operation.status = "compensating";
  save(operation.assetWrapID, operation);
  for (const leg of [...operation.itemLegs].reverse()) {
    if (leg.status !== "committed" || leg.rollbackStatus === "committed") continue;
    const rollbackReceipt = itemCustody.getCommittedReceipt(`${operation.operationKey}:item:${leg.sourceItem.itemID}:rollback`);
    if (!rollbackReceipt.success || rollbackReceipt.ambiguous) {
      refuse("Asset safety recovery rollback is awaiting its custody receipt.");
    }
    if (rollbackReceipt.committed) {
      leg.rollbackChanges = clone(rollbackReceipt.resultData?.changes || []);
      leg.rollbackStatus = "committed";
      save(operation.assetWrapID, operation);
      continue;
    }
    validateSourcePath(operation, leg);
    if (Number(operation.schemaVersion) >= 3 &&
        fingerprintTree(leg.movedItem.itemID) !== expectedMovedTree(operation, leg)) {
      refuse("The recovered items changed; their custody rollback remains pending.");
    }
    const result = moveLeg(operation, leg, true);
    if (!result?.success || result.pending || result.ambiguous) {
      refuse("Asset safety recovery rollback is pending; do not move these items again yet.");
    }
    let changes = result.data?.changes || [];
    if (changes.length === 0) {
      const receipt = itemCustody.getCommittedReceipt(`${operation.operationKey}:item:${leg.sourceItem.itemID}:rollback`);
      if (!receipt.success || receipt.ambiguous || !receipt.committed) {
        refuse("Asset safety recovery rollback is awaiting its custody receipt.");
      }
      changes = receipt.resultData?.changes || [];
    }
    leg.rollbackChanges = clone(changes);
    leg.rollbackStatus = "committed";
    save(operation.assetWrapID, operation);
  }
  if (operation.debitStatus === "committed" && operation.amount > 0 && operation.refundStatus !== "committed") {
    const result = await walletLeg(operation, true);
    if (!result?.success) refuse("The asset safety recovery refund is pending.");
    operation.refundStatus = "committed";
    save(operation.assetWrapID, operation);
  }
  operation.status = "failed";
  save(operation.assetWrapID, operation);
  announce(operation, operation.itemLegs.flatMap((leg) =>
    [...(leg.changes || []), ...(leg.rollbackChanges || [])]), false);
  refuse(operation.failure || "The recovery could not be completed; its charge was refunded.");
}

async function resume(operation) {
  if (operation.status === "compensating") return compensate(operation);
  // Resolve the move/checkpoint crash window from the durable custody receipt,
  // without moving a source that may already have left the wrap.
  for (const leg of operation.itemLegs) {
    if (leg.status === "committed") continue;
    const receipt = itemCustody.getCommittedReceipt(`${operation.operationKey}:item:${leg.sourceItem.itemID}:move`);
    if (!receipt.success || receipt.ambiguous) refuse("Asset safety recovery is awaiting its custody receipt.");
    if (receipt.committed) {
      captureMove(operation, leg, receipt.resultData);
      save(operation.assetWrapID, operation);
    }
  }
  const finish = () => {
    operation.status = "completed";
    save(operation.assetWrapID, operation);
    announce(operation, operation.itemLegs.flatMap((leg) => leg.changes || []), true);
    return { itemIDs: operation.itemLegs.map((leg) => Number(leg.movedItem.itemID)), amount: operation.amount };
  };
  // A completed debit and every durable move are already a completed recovery,
  // even if its last bookkeeping checkpoint was interrupted before undocking.
  if (operation.itemLegs.every((leg) => leg.status === "committed")) {
    if (operation.debitStatus !== "committed" && operation.debitAttempted && operation.amount > 0) {
      const charged = await walletLeg(operation);
      if (!charged?.success) refuse("The recovery charge is pending; retry after it finishes.");
      operation.debitStatus = "committed";
      save(operation.assetWrapID, operation);
    }
    if (operation.debitStatus === "committed") return finish();
  }
  if (!validateInventory) refuse("The asset safety inventory recovery service is not ready.");
  try {
    validateInventory(operation);
  } catch (error) {
    if (operation.debitStatus !== "committed" && operation.debitAttempted) {
      // The debit may have committed immediately before its checkpoint was
      // lost. Resolve that exact command before deciding whether to refund.
      if (operation.amount > 0) {
        const result = await walletLeg(operation);
        if (!result?.success && result?.errorMsg !== "INSUFFICIENT_FUNDS") {
          refuse("The recovery charge is pending; retry after it finishes.");
        }
        if (result?.success) operation.debitStatus = "committed";
      }
    }
    operation.failure = "The recovery source or destination changed; recovery was cancelled.";
    return compensate(operation);
  }
  if (operation.debitStatus !== "committed") {
    if (operation.amount > 0) {
      operation.debitAttempted = true;
      save(operation.assetWrapID, operation);
      const result = await walletLeg(operation);
      if (!result?.success) {
        if (result?.ambiguous || result?.pending) refuse("The recovery charge is pending; retry after it finishes.");
        operation.status = "failed";
        save(operation.assetWrapID, operation);
        if (result?.errorMsg === "INSUFFICIENT_FUNDS") {
          throwWrappedUserError("NotEnoughMoney", buildNotEnoughMoneyUserErrorValues(
            operation.amount, operation.payer?.kind === "corp"
              ? getCorporationWalletBalance(operation.payer.ownerID, operation.payer.accountKey)
              : getCharacterWallet(operation.actorID)?.balance || 0));
        }
        refuse("The asset safety recovery charge could not be completed.");
      }
    }
    operation.debitStatus = "committed";
    operation.status = "moving";
    save(operation.assetWrapID, operation);
  }
  // The wallet authority was awaited: repeat destination/access/capacity and
  // source snapshot checks before any inventory mutation.
  try { validateInventory(operation); }
  catch (error) {
    operation.failure = "The recovery source or destination changed; recovery was cancelled.";
    return compensate(operation);
  }
  for (const leg of operation.itemLegs) {
    if (leg.status === "committed") continue;
    const result = moveLeg(operation, leg);
    if (!result?.success || result?.ambiguous || result?.pending) {
      if (result?.ambiguous || result?.pending) refuse("The recovery item move is awaiting its custody receipt.");
      operation.failure = "The recovery item could not be moved; recovery was cancelled.";
      return compensate(operation);
    }
    captureMove(operation, leg, result.data);
    save(operation.assetWrapID, operation);
  }
  return finish();
}

function serialized(wrapID, work) {
  const prior = queues.get(wrapID) || Promise.resolve();
  const running = prior.catch(() => {}).then(work);
  const retained = running.catch(() => {});
  queues.set(wrapID, retained);
  return running.finally(() => { if (queues.get(wrapID) === retained) queues.delete(wrapID); });
}

function registerInventoryValidator(validator) { validateInventory = validator; }

function recoverPendingWithdrawals() {
  if (bootRecovery) return bootRecovery;
  bootRecovery = (async () => {
    for (const wrap of state.listWraps({ includeDelivered: true, refresh: false })) {
      if (closed(wrap.recoverySaga)) continue;
      try { await serialized(wrap.assetWrapID, () => resume(clone(wrap.recoverySaga))); }
      catch (error) { log.warn(`[AssetSafety] Recovery ${wrap.assetWrapID}: ${error.message}`); }
    }
  })().finally(() => { bootRecovery = null; });
  return bootRecovery;
}

async function withdraw(assetWrapID, itemIDs, session, plan, validateBeforeStart) {
  await (bootRecovery || Promise.resolve());
  return serialized(assetWrapID, async () => {
    const wrap = state.getWrapByID(assetWrapID, { refresh: false });
    if (!closed(wrap?.recoverySaga)) {
      await resume(clone(wrap.recoverySaga));
      refuse("The previous recovery has finished. Refresh the wrap before making another withdrawal.");
    }
    const priced = quote(assetWrapID, itemIDs, session, plan.quantities);
    if (Number(plan.sourceLocationID ?? assetWrapID) !== priced.sourceLocationID) {
      refuse("The asset safety source location changed. Refresh before recovering items.");
    }
    validateBeforeStart(priced);
    const generation = Number(wrap.nextRecoveryGeneration || 1);
    const operation = {
      schemaVersion: 3, assetWrapID: Number(assetWrapID), actorID: priced.actorID,
      sourceLocationID: priced.sourceLocationID,
      sourceOwnerID: priced.wrap.ownerID, payer: clone(priced.payer),
      operationKey: `asset-safety:${assetWrapID}:recovery:${generation}`,
      generation, status: "charging", debitStatus: "pending", debitAttempted: false, refundStatus: "pending",
      amount: priced.amount, value: priced.value, rate: priced.rate,
      priceAuthority: "config.GetAverageMarketPrices (SDE base price)",
      wrapItem: state.getDeliveredWrapItem(assetWrapID),
      boundContext: clone(plan.boundContext), requestedFlag: plan.requestedFlag,
      explicitFlagProvided: plan.explicitFlagProvided,
      itemLegs: priced.roots.map(({ item, quantity, treeFingerprint, sourcePath: path }) => ({
        sourceItem: item, quantity, treeFingerprint, sourcePath: clone(path), destination: clone(plan.destinations[item.itemID]),
        status: "pending", rollbackStatus: "pending", changes: [], rollbackChanges: [], movedItem: null,
      })),
    };
    save(assetWrapID, operation, generation + 1);
    return resume(operation);
  });
}

module.exports = { findSourceWrap, fingerprintTree, quote, withdraw, registerInventoryValidator, recoverPendingWithdrawals,
  validatePayer,
  sourcePath, validateSourcePath, isOrdinarySourceContainer,
  ready: () => bootRecovery || Promise.resolve() };
