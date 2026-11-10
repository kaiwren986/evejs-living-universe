"use strict";

const {
  getActiveShipRecord,
  syncShipFittingStateForSession,
} = require("../../character/characterState");
const {
  grantItemToCharacterLocation, listContainerItems, ITEM_FLAGS,
  moveItemToLocation, updateInventoryItem,
} = require("../../inventory/itemStore");
const { resolveItemByName } = require("../../inventory/itemTypeRegistry");
const {
  getRequiredSlotFamily,
  listFittedItems,
  selectAutoFitFlagForType,
  validateFitForShip,
  resolveFitOnlineState,
} = require("../../fitting/liveFittingState");
const { isDockedSession } = require("../../structure/structureLocation");
const { handledResult } = require("./commandReplies");
const { formatSuggestions } = require("./commandSuggestions");
const { syncInventoryChangesToSession } = require("./commandInventorySync");
const spaceRuntime = require("../../../space/runtime");

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
