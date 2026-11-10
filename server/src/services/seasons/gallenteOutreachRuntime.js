"use strict";
const { getWallclockNowMs } = require("../../space/runtime/runtimeClock");

const { randomUUID } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const campaign = require("./campaignTrailCatalog");
const catalog = require("./gallenteOutreachCatalog");
const trading = require("./gallenteTradingCatalog");
const inventory = require("../inventory/itemStore");
const { resolveItemByTypeID } = require("../inventory/itemTypeRegistry");
const { buildDict } = require("../_shared/serviceHelpers");
const trail = () => require("./campaignTrailRuntime");
const fail = errorMsg => ({ success: false, errorMsg });
const units = item => item.singleton === 1 ? 1 : Number(item.stacksize ?? item.quantity);
const volume = typeID => Number(resolveItemByTypeID(typeID)?.volume);

function publishInventory(session, changes) {
  const { syncInventoryItemForSession } = require("../character/characterState");
  for (const change of changes || []) {
    // Recovery may happen after the pilot moved or traded an output. Publish
    // current custody, never a historical receipt snapshot as a live item.
    const previous = change.previousData || change.item;
    const current = inventory.findItemById(Number(change.item?.itemID || previous?.itemID));
    const item = current?.ownerID === trail().getCharacterID(session) ? current
      : inventory.buildRemovedItemNotificationState(previous);
    if (item) syncInventoryItemForSession(session, item,
      change.previousData || change.previousState || {}, { emitCfgLocation: true });
  }
}

// A pending activity is saved before inventory settlement. Only the matching
// durable inventory receipt can credit it; login and retries finish that work.
function reconcileProgress(session, state) {
  const pending = state.outreachPendingTrade;
  if (!pending) return { success: true, settled: false };
  const receipt = inventory.getIdempotentGrantReceipt(pending.receiptKey, { requireDurable: true });
  if (!receipt.success) return fail(receipt.errorMsg);
  if (receipt.found && (receipt.data.operation !== "exchange-inventory-item-stacks" ||
      !isDeepStrictEqual(receipt.data.fingerprint, pending.fingerprint))) return fail("OUTREACH_RECEIPT_MISMATCH");
  const step = trading.getActiveStep(state);
  const credited = receipt.found && pending.earningEligible !== false && step && step.challengeID === pending.challengeID && !state.trading?.readyAtMs;
  if (credited) {
    state.trading = { ...state.trading,
      count: Math.min(step.count, (state.trading?.count || 0) + pending.receivedQuantity) };
    // Legacy pending rows predate scheduling and were only staged while the
    // election was enabled. Preserve that entitlement when upgrading at end.
    if (state.trading.count >= step.count) state.trading.readyAtMs = pending.startedAtMs || Math.min(getWallclockNowMs(), campaign.END_TIME - 1);
  }
  delete state.outreachPendingTrade;
  trail().saveProgress(trail().getCharacterID(session), state);
  try {
    if (receipt.found) publishInventory(session, receipt.data.resultData?.changes);
    if (credited && typeof session.sendNotification === "function") {
      session.sendNotification("OnChallengeProgressUpdate", "charid", [step.challengeID, state.trading.count]);
      if (state.trading.readyAtMs) session.sendNotification("OnChallengeRewardsGranted", "charid", [step.challengeID]);
    }
  } catch (error) {
    require("../../utils/logger").warn(`[GallenteOutreach] Exchange committed; presentation will refresh on reconnect: ${error.message}`);
  }
  return { success: true, settled: receipt.found, pending };
}

function validateTrade(session, center, recipe, multiplier) {
  const runtime = require("../../space/runtime");
  const characterID = trail().getCharacterID(session);
  const scene = runtime.getSceneForSession(session);
  const shipID = Number(session?._space?.shipID);
  const ship = inventory.findItemById(shipID);
  const actor = scene?.getEntityByID(shipID);
  const target = scene?.getEntityByID(center.itemID);
  if (!session?._space?.initialStateSent || Number(scene?.systemID) !== catalog.SYSTEM_ID ||
      !actor || actor.session !== session || actor.mode === "WARP" || !target || target.typeID !== center.typeID ||
      !ship || ship.ownerID !== characterID || ship.locationID !== catalog.SYSTEM_ID || session.stationid || session.stationID) {
    return fail("OUTREACH_NOT_IN_SPACE");
  }
  const now = scene.getCurrentSimTimeMs();
  const a = scene.getPositionSnapshot(actor, { atSimTimeMs: now, reason: "outreach-trade" });
  const b = scene.getPositionSnapshot(target, { atSimTimeMs: now, reason: "outreach-trade-target" });
  const distance = a.available && b.available ? Math.hypot(...["x", "y", "z"].map(axis =>
    a.position[axis] - b.position[axis])) - a.radius - b.radius : NaN;
  if (!Number.isFinite(distance) || distance > center.interactionRange) return fail("OUTREACH_OUT_OF_RANGE");
  const cargo = inventory.listContainerItems(characterID, shipID, inventory.ITEM_FLAGS.CARGO_HOLD);
  const requests = [];
  for (const [type, amount] of Object.entries(recipe.inputItems)) {
    let remaining = amount * multiplier;
    for (const item of cargo.filter(row => row.typeID === Number(type) && !row.custodyReservation)) {
      if (remaining <= 0) break;
      const quantity = Math.min(remaining, units(item));
      requests.push({ itemID: item.itemID, quantity, expectedTypeID: Number(type),
        expectedOwnerID: characterID, expectedLocationID: shipID, expectedFlagID: inventory.ITEM_FLAGS.CARGO_HOLD,
        expectedQuantity: units(item) });
      remaining -= quantity;
    }
    if (remaining > 0) return fail("OUTREACH_MISSING_FAVORS");
  }
  const outputs = Object.entries(recipe.outputItems).map(([type, amount]) => ({
    typeID: Number(type), quantity: amount * multiplier, ownerID: characterID,
    locationID: shipID, flagID: inventory.ITEM_FLAGS.CARGO_HOLD,
  }));
  const used = cargo.reduce((sum, item) => sum + volume(item.typeID) * units(item), 0);
  const consumed = requests.reduce((sum, item) => sum + volume(item.expectedTypeID) * item.quantity, 0);
  const produced = outputs.reduce((sum, item) => sum + volume(item.typeID) * item.quantity, 0);
  const snapshot = require("../../_secondary/fitting/fittingRuntime").getShipFittingSnapshot(
    characterID, shipID, { shipItem: ship, reason: "outreach-trade" });
  const capacity = Number(snapshot?.resourceState?.cargoCapacity);
  if (!Number.isFinite(used + consumed + produced + capacity) || used - consumed + produced > capacity + 1e-8) {
    return fail("OUTREACH_CARGO_FULL");
  }
  return { success: true, characterID, shipID, requests, outputs };
}

function processTrade(session, itemID, args = {}) {
  const characterID = trail().getCharacterID(session);
  if (!campaign.canTrade() || !characterID) return fail("OUTREACH_DISABLED");
  if (!args || typeof args !== "object") return fail("OUTREACH_INVALID_RECIPE");
  const center = catalog.getCenter(itemID);
  const recipeID = Number(args.recipeID);
  const multiplier = Number(args.multiplier);
  const recipe = catalog.getRecipe(center, recipeID);
  if (!center || !recipe || !Number.isSafeInteger(multiplier) || multiplier < 1 || multiplier > 1000000 ||
      Number(args.inputISK) !== recipe.inputIsk * multiplier) return fail("OUTREACH_INVALID_RECIPE");
  const state = trail().getProgress(characterID);
  const recovered = reconcileProgress(session, state);
  if (!recovered.success) return recovered;
  if (recovered.settled && recovered.pending.fingerprint.centerID === center.itemID &&
      recovered.pending.fingerprint.recipeID === recipeID && recovered.pending.fingerprint.multiplier === multiplier) {
    return { success: true, recovered: true, outputs: Object.entries(recipe.outputItems).map(([id, amount]) => [Number(id), amount * multiplier]) };
  }
  const plan = validateTrade(session, center, recipe, multiplier);
  if (!plan.success) return plan;
  const fingerprint = { characterID, shipID: plan.shipID, centerID: center.itemID, recipeID, multiplier };
  const pending = { receiptKey: `outreach:${campaign.SEASON_ID}:${characterID}:${randomUUID()}`, fingerprint,
    earningEligible: campaign.isEnabled(), startedAtMs: getWallclockNowMs(),
    challengeID: trading.getActiveStep(state)?.challengeID || null,
    receivedQuantity: plan.outputs.reduce((sum, item) => sum + item.quantity, 0) };
  state.outreachPendingTrade = pending;
  trail().saveProgress(characterID, state);
  const result = inventory.exchangeInventoryItemStacksIdempotent(plan.requests, plan.outputs,
    { receiptKey: pending.receiptKey, fingerprint });
  if (!result.success) {
    if (!result.ambiguous) {
      delete state.outreachPendingTrade;
      trail().saveProgress(characterID, state);
    }
    return result;
  }
  const reconciled = reconcileProgress(session, state);
  if (!reconciled.success) return reconciled;
  return { success: true, outputs: plan.outputs.map(item => [item.typeID, item.quantity]) };
}

function processTradeFromClient(session, itemID, args) {
  const result = processTrade(session, itemID, args);
  if (!result.success) {
    const messages = { OUTREACH_DISABLED: "The Capsuleer Outreach Center is closed. Exchanges are available during the election and its trader grace period.",
      OUTREACH_OUT_OF_RANGE: "Approach the Capsuleer Outreach Center within 2,500 m.",
      OUTREACH_MISSING_FAVORS: "Carry the required favors in your ship's cargo hold.",
      OUTREACH_CARGO_FULL: "Your cargo hold does not have enough room for this exchange." };
    require("../../common/machoErrors").throwWrappedUserError("CustomNotify", {
      notify: messages[result.errorMsg] || "This outreach exchange could not be completed. Reopen the center and try again.",
    });
  }
  return [true, buildDict(result.outputs)];
}

module.exports = { processTrade, processTradeFromClient, reconcileProgress };
