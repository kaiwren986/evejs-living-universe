"use strict";

const { getActiveShipRecord, emitFittingTransactionForSession } = require("../../character/characterState");
const {
  ITEM_FLAGS, listContainerItems, getInventoryItemUnitVolume,
  moveItemsAndSetShipPackagingState,
} = require("../../inventory/itemStore");
const { resolveItemByName } = require("../../inventory/itemTypeRegistry");
const { listFittedItems, getRequiredSlotFamily, buildShipResourceState } = require("../../fitting/liveFittingState");
const { isDockedSession, getDockedLocationID } = require("../../structure/structureLocation");
const { handledResult } = require("./commandReplies");
const spaceRuntime = require("../../../space/runtime");

function handleUnfitCommand(session, argumentText, chatHub, options) {
  const reply = (message) => handledResult(chatHub, session, options, message);
  const match = /^(?:me|"me"|'me')\s+(.+)$/i.exec(String(argumentText || "").trim());
  if (!match) return reply("Usage: /unfit me <module name|typeID|itemID|all>");
  const characterID = Number(session && session.characterID) || 0;
  if (!characterID) return reply("Select a character before using /unfit me.");
  const ship = getActiveShipRecord(characterID);
  if (!ship || Number(ship.ownerID) !== characterID) return reply("Board a ship before using /unfit me.");
  const docked = isDockedSession(session);
  const scene = !docked && session._space ? spaceRuntime.getSceneForSession(session) : null;
  const entity = scene && scene.getShipEntityForSession(session);
  if (!docked && (!entity || Number(entity.itemID) !== Number(ship.itemID))) {
    return reply("Your active ship must be docked or present in space before using /unfit me.");
  }
  const query = match[1].replace(/^(["'])(.*)\1$/, "$2").trim();
  const stripAll = query.toLowerCase() === "all";
  const fitted = listFittedItems(characterID, ship.itemID);
  const modules = fitted.filter((item) => Number(item.categoryID) === 7 || Number(item.categoryID) === 32)
    .sort((a, b) => Number(a.flagID) - Number(b.flagID));
  let moduleItem = modules.find((item) => String(item.itemID) === query);
  if (!stripAll && !moduleItem) {
    const lookup = resolveItemByName(query);
    moduleItem = lookup.success && modules.find((item) => Number(item.typeID) === Number(lookup.match.typeID));
  }
  if (!stripAll && !moduleItem) return reply(`No fitted module matches ${query}.`);
  if (stripAll && fitted.length === 0) return reply("Your ship has no fitted items to remove.");
  const family = moduleItem && getRequiredSlotFamily(moduleItem.typeID);
  if (!stripAll && (family === "rig" || family === "subsystem")) {
    return reply("/unfit supports high, medium and low slot modules. Rigs and subsystems require their normal fitting controls.");
  }
  const charges = fitted.filter((item) => Number(item.categoryID) === 8 &&
    (stripAll || Number(item.flagID) === Number(moduleItem.flagID)));
  const moving = stripAll ? fitted : [moduleItem, ...charges];
  const movingIDs = new Set(moving.map((item) => item.itemID));
  if (!docked) {
    // Check capacity after removing the module, including lost cargo bonuses.
    const state = buildShipResourceState(characterID, ship, {
      fittedItems: fitted.filter((item) => !movingIDs.has(item.itemID)),
    });
    const volume = (item) => getInventoryItemUnitVolume(item) *
      (Number(item.singleton) === 1 ? 1 : Number(item.stacksize ?? item.quantity) || 0);
    const required = [...listContainerItems(null, ship.itemID, ITEM_FLAGS.CARGO_HOLD), ...moving]
      .reduce((total, item) => total + volume(item), 0);
    if (required > Number(state.cargoCapacity || 0) + 1e-7) {
      return reply("Not enough cargo space for the fitted items being removed. Free cargo space or dock first.");
    }
  }
  // Load lazily: dogma's command helpers also depend on chat commands.
  const DogmaService = require("../../dogma/dogmaService");
  const dogma = new DogmaService();
  for (const item of stripAll ? modules : [moduleItem]) {
    const offline = dogma._setModuleOnlineState(ship.itemID, item.itemID, false, session);
    if (!offline.success) return reply(`Could not offline module ${item.itemID}: ${offline.errorMsg}. No items were moved; earlier modules may already be offline.`);
  }
  const destinationLocationID = docked ? getDockedLocationID(session) : ship.itemID;
  const destinationFlagID = docked ? ITEM_FLAGS.HANGAR : ITEM_FLAGS.CARGO_HOLD;
  // Move module and loaded charges together; keep the active hull assembled.
  const result = moveItemsAndSetShipPackagingState(ship.itemID, moving.map((item) => ({
    itemID: item.itemID, destinationLocationID, destinationFlagID,
  })), false);
  if (!result.success) return reply(`Modules were offlined, but removal failed: ${result.errorMsg}.`);
  emitFittingTransactionForSession(session, ship.itemID, result.moveChanges);
  if (entity) {
    spaceRuntime.refreshShipDerivedState(session, { broadcast: true });
    scene.broadcastSlimItemChanges([entity]);
  }
  const destination = docked ? "hangar" : "ship's cargo hold";
  if (stripAll) return reply(`Unfitted all ${modules.length} modules and ${charges.length} charge stacks to your ${destination}.`);
  return reply(`Unfitted ${moduleItem.itemName || query} from slot ${moduleItem.flagID} to your ${destination}.${charges.length ? " Loaded charges were moved too." : ""}`);
}

module.exports = { handleUnfitCommand };
