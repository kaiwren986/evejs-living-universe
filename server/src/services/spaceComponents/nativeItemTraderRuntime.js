"use strict";

const { randomUUID } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const authority = require("./nativeItemTraderAuthority.json");
const inventory = require("../inventory/itemStore");
const characters = require("../character/characterState");
const sessionRegistry = require("../chat/sessionRegistry");
const authored = require("../../space/authoredSpaceProps");
const { resolveItemByTypeID } = require("../inventory/itemTypeRegistry");
const { canEntitiesInteractLocally } = require("../../space/destiny/identity/interactionScope");
const { isEntityCloaked } = require("../../space/runtime/shipCloak");
const { buildDict } = require("../_shared/serviceHelpers");
const fail = errorMsg => ({ success: false, errorMsg });
const units = item => item.singleton === 1 ? 1 : Number(item.stacksize ?? item.quantity);
const volume = typeID => Number(resolveItemByTypeID(typeID)?.volume);
// A failed/ambiguous intent write must be restored before another custody
// attempt. The durable prior value still owns recovery after a process restart.
const pendingRestores = new Map();

function isSupportedTarget(session, itemID) {
  const scene = require("../../space/runtime").getSceneForSession(session);
  return scene?.getEntityByID(itemID)?.typeID === authority.typeID ||
    characters.peekCharacterRecord(Number(session?.characterID))?.nativeItemTraderPending?.fingerprint.targetID === Number(itemID) ||
    pendingRestores.get(Number(session?.characterID))?.fingerprint?.targetID === Number(itemID);
}
function writePending(characterID, pending) {
  const result = characters.updateCharacterRecord(characterID, row => {
    if (pending) row.nativeItemTraderPending = structuredClone(pending);
    else delete row.nativeItemTraderPending;
    return row;
  });
  if (!result.success) throw new Error(`Native item trader intent: ${result.errorMsg}`);
  const flushed = require("../../gameStore").flushTableSync("characters");
  if (!flushed.success) throw new Error(`Native item trader intent flush: ${flushed.errorMsg}`);
}
function savePending(characterID, pending) {
  const previous = structuredClone(characters.peekCharacterRecord(characterID)?.nativeItemTraderPending || null);
  try { writePending(characterID, pending); }
  catch (error) {
    pendingRestores.set(characterID, previous);
    try { writePending(characterID, previous); pendingRestores.delete(characterID); }
    catch (_) { /* Admission remains fenced until the character owner can restore the prior intent. */ }
    throw error;
  }
}
function retryPendingRestore(characterID) {
  if (!pendingRestores.has(characterID)) return true;
  try { writePending(characterID, pendingRestores.get(characterID)); pendingRestores.delete(characterID); return true; }
  catch (_) { return false; }
}
function publish(session, changes) {
  for (const change of changes || []) {
    const previous = change.previousData || change.item;
    const current = inventory.findItemById(Number(change.item?.itemID || previous?.itemID));
    const item = Number(current?.ownerID) === Number(session.characterID) ? current : inventory.buildRemovedItemNotificationState(previous);
    if (item) characters.syncInventoryItemForSession(session, item, change.previousData || change.previousState || {}, { emitCfgLocation: true });
  }
}
function reconcile(session, pending) {
  const receipt = inventory.getIdempotentGrantReceipt(pending.receiptKey, { requireDurable: true });
  if (!receipt.success) return fail(receipt.errorMsg);
  if (receipt.found && (receipt.data.operation !== "exchange-inventory-item-stacks" ||
      !isDeepStrictEqual(receipt.data.fingerprint, pending.fingerprint))) return fail("ITEM_TRADER_RECEIPT_MISMATCH");
  savePending(Number(session.characterID), null);
  if (receipt.found) {
    try { publish(session, receipt.data.resultData?.changes); }
    catch (error) { require("../../utils/logger").warn(`[NativeItemTrader] Committed inventory presentation pending: ${error.message}`); }
  }
  return { success: true, settled: receipt.found, outputs: pending.outputs };
}
function recoverPendingTrade(session) {
  const characterID = Number(session?.characterID), character = characters.peekCharacterRecord(characterID);
  if (!character || !sessionRegistry.isRegisteredSession(session) || session.socket?.destroyed ||
      Number(character.accountId) !== Number(session.userid)) return fail("ITEM_TRADER_ACTING_PILOT_REQUIRED");
  if (!retryPendingRestore(characterID)) return fail("ITEM_TRADER_INTENT_PERSISTENCE_UNAVAILABLE");
  const pending = characters.peekCharacterRecord(characterID)?.nativeItemTraderPending;
  return pending ? reconcile(session, pending) : { success: true, settled: false };
}
function validate(session, itemID, multiplier) {
  const runtime = require("../../space/runtime");
  const scene = runtime.getSceneForSession(session), characterID = Number(session?.characterID);
  const character = characters.peekCharacterRecord(characterID);
  const actor = scene?.getShipEntityForSession(session), target = scene?.getEntityByID(itemID);
  const ship = actor && inventory.findItemById(actor.itemID);
  if (!character || character.deletedAt || character.isDeleted || !sessionRegistry.isRegisteredSession(session) ||
      session.socket?.destroyed || Number(character.accountId) !== Number(session.userid) ||
      !session._space?.initialStateSent || !scene || runtime.scenes.get(scene.sceneKey) !== scene ||
      scene.sessions.get(session.clientID) !== session || session.stationid || session.stationID ||
      !actor || actor.session !== session || actor.destroyed || Number(actor.ownerID) !== characterID ||
      Number(session._space.shipID) !== actor.itemID || Number(character.shipID) !== actor.itemID ||
      !ship || ship.ownerID !== characterID || ship.locationID !== scene.systemID || ship.typeID !== actor.typeID) return fail("ITEM_TRADER_ACTING_PILOT_REQUIRED");
  const configured = authority.admittedSystems.includes(Number(scene.systemID)) &&
    authored.getConfiguredStaticEntitiesForSystem(scene.systemID).find(row => row.itemID === Number(itemID) &&
      row.typeID === authority.typeID && Number(row.dungeonObjectID || row.dunObjectID) === authority.dungeonObjectID);
  if (!configured || target?.typeID !== authority.typeID || target.kind !== "authoredSpaceProp" || target.destroyed ||
      target.authoredSpacePropSourceItemID !== configured.authoredSpacePropSourceItemID ||
      !canEntitiesInteractLocally(actor, target)) return fail("ITEM_TRADER_NOT_ADMITTED");
  if (/WARP/i.test(String(actor.mode)) || isEntityCloaked(actor) || actor.structureTether?.active) return fail("ITEM_TRADER_MOVEMENT_CHANGED");
  const distance = scene.getEntitySurfaceDistance(actor, target);
  if (!Number.isFinite(distance) || distance > authority.interactionRange) return fail("ITEM_TRADER_OUT_OF_RANGE");
  const flags = [inventory.ITEM_FLAGS.CARGO_HOLD, inventory.ITEM_FLAGS.GENERAL_MINING_HOLD, inventory.ITEM_FLAGS.SPECIALIZED_ICE_HOLD];
  const cargo = flags.flatMap(flag => inventory.listContainerItems(characterID, actor.itemID, flag));
  const requests = [];
  for (const [typeID, amount] of Object.entries(authority.recipe.inputItems)) {
    let remaining = amount * multiplier;
    for (const item of cargo.filter(row => row.typeID === Number(typeID) && !row.custodyReservation && !row.careerBoundCharacterID).sort((a, b) => a.itemID - b.itemID)) {
      if (remaining <= 0) break;
      const quantity = Math.min(remaining, units(item));
      requests.push({ itemID: item.itemID, quantity, expectedTypeID: item.typeID,
        expectedOwnerID: characterID, expectedLocationID: actor.itemID, expectedFlagID: item.flagID, expectedQuantity: units(item) });
      remaining -= quantity;
    }
    if (remaining > 0) return fail("ITEM_TRADER_MISSING_INPUTS");
  }
  const outputs = Object.entries(authority.recipe.outputItems).map(([typeID, amount]) => ({
    typeID: Number(typeID), quantity: amount * multiplier, ownerID: characterID, locationID: actor.itemID, flagID: inventory.ITEM_FLAGS.CARGO_HOLD,
  }));
  const used = cargo.filter(row => row.flagID === inventory.ITEM_FLAGS.CARGO_HOLD).reduce((sum, row) => sum + volume(row.typeID) * units(row), 0);
  const consumed = requests.filter(row => row.expectedFlagID === inventory.ITEM_FLAGS.CARGO_HOLD).reduce((sum, row) => sum + volume(row.expectedTypeID) * row.quantity, 0);
  const produced = outputs.reduce((sum, row) => sum + volume(row.typeID) * row.quantity, 0);
  const capacity = Number(require("../../_secondary/fitting/fittingRuntime").getShipFittingSnapshot(characterID, actor.itemID,
    { shipItem: ship, reason: "native-item-trader" })?.resourceState?.cargoCapacity);
  if (!Number.isFinite(used + consumed + produced + capacity) || used - consumed + produced > capacity + 1e-8) return fail("ITEM_TRADER_CARGO_FULL");
  return { success: true, characterID, shipID: actor.itemID, requests, outputs };
}
function processTrade(session, itemID, args) {
  const characterID = Number(session?.characterID), multiplier = Number(args?.multiplier);
  const character = characters.peekCharacterRecord(characterID);
  if (!character || !sessionRegistry.isRegisteredSession(session) || session.socket?.destroyed ||
      Number(character.accountId) !== Number(session.userid)) return fail("ITEM_TRADER_ACTING_PILOT_REQUIRED");
  if (!retryPendingRestore(characterID)) return fail("ITEM_TRADER_INTENT_PERSISTENCE_UNAVAILABLE");
  if (Number(args?.recipeID) !== authority.recipe._key || Number(args?.inputISK) !== authority.recipe.inputIsk ||
      !Number.isSafeInteger(multiplier) || multiplier <= 0 || multiplier > 1000000) return fail("ITEM_TRADER_UNSUPPORTED_RECIPE");
  const pending = characters.peekCharacterRecord(characterID)?.nativeItemTraderPending;
  if (pending) {
    const recovered = recoverPendingTrade(session);
    if (!recovered.success) return recovered;
    if (recovered.settled && pending.fingerprint.targetID === Number(itemID) && pending.fingerprint.recipeID === Number(args.recipeID) &&
        pending.fingerprint.multiplier === multiplier) return { ...recovered, recovered: true };
  }
  const plan = validate(session, itemID, multiplier);
  if (!plan.success) return plan;
  const fingerprint = { characterID, shipID: plan.shipID, targetID: Number(itemID), recipeID: authority.recipe._key, multiplier,
    recipeResourceSHA256: authority.source.recipeResourceSHA256 };
  const intent = { receiptKey: `native-item-trader:${characterID}:${randomUUID()}`, fingerprint,
    outputs: plan.outputs.map(row => [row.typeID, row.quantity]) };
  savePending(characterID, intent);
  const result = inventory.exchangeInventoryItemStacksIdempotent(plan.requests, plan.outputs, { receiptKey: intent.receiptKey, fingerprint });
  if (!result.success) { if (!result.ambiguous) savePending(characterID, null); return result; }
  const reconciled = reconcile(session, intent);
  return reconciled.success ? { success: true, outputs: intent.outputs } : reconciled;
}
function processTradeFromClient(session, itemID, args) {
  const result = processTrade(session, itemID, args);
  if (!result.success) {
    const messages = {
      ITEM_TRADER_OUT_OF_RANGE: `Approach the Imperial Quartermaster within ${authority.interactionRange.toLocaleString("en-US")} m.`,
      ITEM_TRADER_MISSING_INPUTS: "Carry the required items in your ship's cargo hold.",
      ITEM_TRADER_CARGO_FULL: "Your cargo hold does not have enough room for this exchange.",
      ITEM_TRADER_UNSUPPORTED_RECIPE: "That exchange is not available from this trader.",
      ITEM_TRADER_NOT_ADMITTED: "That trader is not available here. Reopen the trader window and try again.",
      ITEM_TRADER_MOVEMENT_CHANGED: "You cannot trade while warping, cloaked, or tethered.",
      ITEM_TRADER_ACTING_PILOT_REQUIRED: "Your ship could not be verified for this exchange. Reopen the trader window and try again.",
    };
    require("../../utils/logger").warn(`[NativeItemTrader] Refused character=${Number(session?.characterID) || 0} target=${itemID} reason=${result.errorMsg}`);
    require("../../common/machoErrors").throwWrappedUserError("CustomNotify", {
      notify: messages[result.errorMsg] || "This exchange could not be verified. Reopen the trader window and try again.",
    });
  }
  return [true, buildDict(result.outputs)];
}
module.exports = { isSupportedTarget, processTrade, processTradeFromClient, recoverPendingTrade };
