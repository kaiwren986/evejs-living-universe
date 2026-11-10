"use strict";

const {
  getActiveShipRecord,
  syncShipFittingStateForSession,
} = require("../../character/characterState");
const {
  grantItemToCharacterLocation, listContainerItems, ITEM_FLAGS,
  moveItemToLocation, updateInventoryItem,
  restoreInventoryItemChangesAtomic, findItemById,
} = require("../../inventory/itemStore");
const { resolveItemByName } = require("../../inventory/itemTypeRegistry");
const {
  getRequiredSlotFamily,
  listFittedItems,
  selectAutoFitFlagForType,
  validateFitForShip,
  resolveFitOnlineState,
  getFittedModuleByFlag, getLoadedChargeByFlag, isChargeCompatibleWithModule, getModuleChargeCapacity,
} = require("../../fitting/liveFittingState");
const { isDockedSession, getDockedLocationID } = require("../../structure/structureLocation");
const { handledResult } = require("./commandReplies");
const { formatSuggestions } = require("./commandSuggestions");
const { syncInventoryChangesToSession } = require("./commandInventorySync");
const spaceRuntime = require("../../../space/runtime");

function fitGmCharge(session, ship, match, chatHub, options) {
  const reply = (message) => handledResult(chatHub, session, options, message);
  if (!require("./commandAccess").hasStaffDebugRole(session)) return reply("Fitting generated charges requires a staff/admin role.");
  const [typeID, requestedQuantity, flagID] = match.slice(1).map(Number);
  let quantity = requestedQuantity;
  if (![typeID, quantity, flagID].every((value) => Number.isSafeInteger(value) && value > 0)) {
    return reply("Usage: /fit me <chargeTypeID> <quantity> flag=<slot>");
  }
  const lookup = resolveItemByName(String(typeID));
  const module = getFittedModuleByFlag(session.characterID, ship.itemID, flagID);
  if (!lookup.success || Number(lookup.match.categoryID) !== 8 || !module ||
      !isChargeCompatibleWithModule(module.typeID, typeID)) return reply("No compatible fitted module for that charge and slot.");
  const DogmaService = require("../../dogma/dogmaService");
  const dogma = new DogmaService();
  // menu_charge.py addresses a bank's master with the whole bank's quantity.
  // The /ammo macro addresses each slot separately. Prefer the named slot,
  // then spread any remaining quantity over its authoritative bank members.
  const bankIDs = dogma._expandGroupedModuleIDs(ship.itemID, [module.itemID]);
  const modules = [module, ...bankIDs.filter((itemID) => Number(itemID) !== Number(module.itemID))
    .map((itemID) => findItemById(itemID))];
  const slots = [];
  for (const member of modules) {
    if (!member || Number(member.ownerID) !== Number(session.characterID) ||
        Number(member.locationID) !== Number(ship.itemID) ||
        !isChargeCompatibleWithModule(member.typeID, typeID)) {
      return reply("No compatible fitted module for that charge and slot.");
    }
    const existing = getLoadedChargeByFlag(session.characterID, ship.itemID, member.flagID);
    if (existing && Number(existing.typeID) !== typeID) return reply("Clear the existing charges before fitting another type.");
    if (dogma._getPendingModuleReload(member.itemID) || spaceRuntime.getActiveModuleEffect(session, member.itemID)) {
      return reply("Stop the module and finish its reload before fitting generated charges.");
    }
    const existingQuantity = Number(existing?.stacksize ?? existing?.quantity ?? 0);
    const capacity = getModuleChargeCapacity(member.typeID, typeID);
    slots.push({ moduleItem: member, flagID: Number(member.flagID), capacity,
      remaining: Math.max(0, capacity - existingQuantity),
      previousChargeState: { typeID: Number(existing?.typeID) || 0, quantity: existingQuantity },
      previousChargeItem: existing });
  }
  const remainingCapacity = slots.reduce((total, slot) => total + slot.remaining, 0);
  if (quantity > remainingCapacity) {
    // The stock ChargeService.Fit selector subtracts only the master's loaded
    // quantity from full-bank capacity. Loaded slaves are therefore counted
    // twice in its demand. Recognize only that exact master request; ordinary
    // incremental requests and all other overcapacity requests keep their rules.
    const masterID = require("../../moduleGrouping/moduleGroupingRuntime")
      .getMasterModuleID(ship.itemID, module.itemID);
    const capacity = slots[0].capacity;
    const selectorDemand = capacity * slots.length - slots[0].previousChargeState.quantity;
    const nativeMasterTopUp = slots.length > 1 && remainingCapacity > 0 &&
      Number(masterID) === Number(module.itemID) &&
      slots.every((slot) => slot.capacity === capacity) &&
      slots.slice(1).some((slot) => slot.previousChargeState.quantity > 0) &&
      quantity === selectorDemand;
    if (!nativeMasterTopUp) return reply("Requested charges exceed the module's remaining capacity.");
    quantity = remainingCapacity;
  }
  const docked = isDockedSession(session);
  const sourceLocation = docked ? getDockedLocationID(session) : ship.itemID;
  const sourceFlag = docked ? ITEM_FLAGS.HANGAR : ITEM_FLAGS.CARGO_HOLD;
  const grant = grantItemToCharacterLocation(session.characterID, sourceLocation, sourceFlag, lookup.match, quantity);
  if (!grant.success) return reply(`Charge creation failed: ${grant.errorMsg}.`);
  const Broker = require("../../inventory/invBrokerService");
  const broker = new Broker();
  const allChanges = [...grant.data.changes];
  const loadChanges = [];
  const loadedSlots = [];
  let committed = false;
  try {
    syncInventoryChangesToSession(session, grant.data.changes);
    let remainingQuantity = quantity;
    for (const slot of slots) {
      let slotQuantity = Math.min(slot.remaining, remainingQuantity);
      if (!slotQuantity) continue;
      loadedSlots.push(slot);
      while (slotQuantity > 0) {
        // A grant can merge into a pre-existing stack or split at the stack
        // limit. Re-read its touched source rows after every custody move.
        const source = grant.data.items.map((item) => findItemById(item.itemID))
          .find((item) => item && Number(item.locationID) === Number(sourceLocation) &&
            Number(item.flagID) === Number(sourceFlag) && Number(item.typeID) === typeID &&
            Number(item.stacksize ?? item.quantity) > 0);
        if (!source) throw new Error("GENERATED_CHARGE_SOURCE_MISSING");
        const moving = Math.min(slotQuantity, Number(source.stacksize ?? source.quantity));
        const result = broker._tryLoadChargeFromInventoryAdd(session,
          broker._findTransferSourceItem(source.itemID, sourceLocation),
          { locationID: ship.itemID, flagID: slot.flagID }, moving);
        if (!result.handled || !result.success) throw new Error(result.errorMsg || "CHARGE_FIT_FAILED");
        const changes = result.data.changes || [];
        allChanges.push(...changes);
        loadChanges.push(...changes);
        const moved = Number(result.data.quantity) || 0;
        if (moved <= 0 || moved > moving) throw new Error("CHARGE_FIT_QUANTITY_MISMATCH");
        slotQuantity -= moved;
        remainingQuantity -= moved;
      }
    }
    if (remainingQuantity !== 0) throw new Error("CHARGE_FIT_QUANTITY_MISMATCH");
    committed = true;
    // Publish only after every bank member's custody succeeded, with one
    // transition from each slot's original tuple to its final quantity.
    loadedSlots.forEach((slot, index) => broker._emitFittedChargeLoadChanges(session,
      index === 0 ? loadChanges : [], { ...slot, charID: session.characterID, shipID: ship.itemID }));
    return reply(`Fitted ${quantity} ${lookup.match.name} charges to flag ${flagID}.`);
  } catch (error) {
    let message = `${committed ? "Charges were fitted, but client refresh failed" : "Charge fitting failed"}: ${error.message}.`;
    if (!committed) {
      // One compensation covers both the generated grant and any earlier
      // successful slots. Never leave a half-filled bank after a refusal.
      let rollback;
      try {
        rollback = restoreInventoryItemChangesAtomic(allChanges);
        if (!rollback.success) message += ` Rollback failed: ${rollback.errorMsg}.`;
      } catch (rollbackError) {
        message += ` Rollback failed: ${rollbackError.message}.`;
      }
      if (rollback?.success) {
        try {
          // The broker filters real fitted-charge rows; those are tuple-only
          // client identities, including when restoring a partially filled bank.
          broker._emitFittedChargeLoadChanges(session, rollback.data.changes);
        } catch (refreshError) {
          message += ` Inventory was restored, but client refresh failed: ${refreshError.message}.`;
        }
      }
    }
    return reply(message);
  }
}

function handleFitCommand(session, argumentText, chatHub, options) {
  const reply = (message) => handledResult(chatHub, session, options, message);
  // The client resolves module names to IDs and sends the target as "me".
  const match = /^(?:me|"me"|'me')\s+(.+)$/i.exec(String(argumentText || "").trim());
  if (!match) {
    return reply("Usage: /fit me <module name|typeID>");
  }
  const characterID = Number(session && session.characterID) || 0;
  if (!characterID) {
    return reply("Select a character before using /fit me.");
  }
  const ship = getActiveShipRecord(characterID);
  if (!ship || Number(ship.ownerID) !== characterID) {
    return reply("Board a ship before using /fit me.");
  }
  const docked = isDockedSession(session);
  const scene = !docked && session._space ? spaceRuntime.getSceneForSession(session) : null;
  const entity = scene && scene.getShipEntityForSession(session);
  if (!docked && (!entity || Number(entity.itemID) !== Number(ship.itemID))) {
    return reply("Your active ship must be docked or present in space before using /fit me.");
  }

  // The retail ammo macro sends a charge count and an explicit fitting flag.
  const chargeFit = /^(\d+)\s+(\d+)\s+flag=(\d+)$/i.exec(match[1]);
  if (chargeFit) return fitGmCharge(session, ship, chargeFit, chatHub, options);

  // Strip an optional pair of outer quotes, preserving apostrophes in names.
  const query = match[1].replace(/^(["'])(.*)\1$/, "$2").trim();
  const lookup = resolveItemByName(query);
  if (!lookup.success) {
    return reply(`Module lookup failed: ${query}.${formatSuggestions(lookup.suggestions)}`);
  }
  const type = lookup.match;
  const family = getRequiredSlotFamily(type.typeID);
  if (![7, 32].includes(Number(type.categoryID)) || !family) {
    return reply(`${type.name} is not a fittable module.`);
  }
  const fittedItems = listFittedItems(characterID, ship.itemID);
  const flagID = selectAutoFitFlagForType(ship, fittedItems, type.typeID);
  if (!flagID) {
    return reply(`No free compatible ${family} slot for ${type.name}.`);
  }
  const cargoModule = listContainerItems(characterID, ship.itemID, ITEM_FLAGS.CARGO_HOLD)
    .filter((item) => Number(item.typeID) === Number(type.typeID))
    .sort((a, b) => Number(a.itemID) - Number(b.itemID))[0];
  const candidate = {
    ...cargoModule,
    itemID: cargoModule ? cargoModule.itemID : -1,
    typeID: type.typeID,
    groupID: type.groupID,
    categoryID: type.categoryID,
    ownerID: characterID,
    locationID: ship.itemID,
    flagID,
    singleton: 1,
    stacksize: 1,
    moduleState: { ...(cargoModule && cargoModule.moduleState), online: true },
  };
  const validation = validateFitForShip(characterID, ship, candidate, flagID, fittedItems);
  if (!validation.success) {
    return reply(`Cannot fit ${type.name}: ${validation.errorMsg}.`);
  }
  const onlineState = resolveFitOnlineState(characterID, ship, candidate, fittedItems);
  // Validate before moving or creating anything; failed fits leave cargo intact.
  const grant = cargoModule
    ? moveItemToLocation(cargoModule.itemID, ship.itemID, flagID, 1)
    : grantItemToCharacterLocation(characterID, ship.itemID, flagID, type, 1, {
      singleton: 1,
      moduleState: { online: onlineState.online !== false },
    });
  if (!grant.success) {
    return reply(`Module fitting failed: ${grant.errorMsg}.`);
  }
  if (cargoModule && onlineState.online === false) {
    // Inventory moves auto-online modules. Apply the resource decision before
    // publishing the fitted row, including when one item was split from a stack.
    const moved = grant.data.changes.findLast((change) =>
      Number(change.item.locationID) === Number(ship.itemID) && Number(change.item.flagID) === flagID);
    const update = updateInventoryItem(moved.item.itemID, (item) => ({
      ...item, moduleState: { ...item.moduleState, online: false },
    }));
    if (!update.success) {
      syncInventoryChangesToSession(session, grant.data.changes);
      return reply(`Module was moved into its slot, but setting it offline failed: ${update.errorMsg}.`);
    }
    moved.item = update.data;
  }
  syncInventoryChangesToSession(session, grant.data.changes);
  syncShipFittingStateForSession(session, ship.itemID, {
    includeOfflineModules: true,
    includeCharges: true,
    emitOnlineEffects: true,
    suppressNoOpItemChanges: true,
  });
  if (entity) {
    spaceRuntime.refreshShipDerivedState(session, { broadcast: true });
    scene.broadcastSlimItemChanges([entity]);
  }
  const offline = onlineState.online === false
    ? ` Fitted offline: ${onlineState.reason}.`
    : "";
  return reply(`${cargoModule ? "Fitted from cargo:" : "Created and fitted"} ${type.name} to ${ship.itemName || "your ship"} (${family} slot, flag ${flagID}).${offline}`);
}

module.exports = { handleFitCommand };
