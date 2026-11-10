"use strict";

// Chapter 2.2 verifies current inventory/market owners. Its window and local
// career-goal settings stay with the native client; they are not server goals.
const characters = require("../character/characterState");
const inventory = require("../inventory/itemStore");
const custody = require("../inventory/itemCustody");
const wallet = require("../account/walletState");
const marketEscrow = require("../market/marketEscrowState");
const { graphError } = require("../nodegraph/nodeGraphCompiler");
const { effectKey, checkCharacter } = require("../nodegraph/nodeGraphEffects");
const { cloneValue: clone } = require("../../common/clone");

function ok(result) {
  if (!result?.success) throw graphError("AIR_ECONOMY_ACTION_FAILED", result?.errorMsg);
  return result;
}
function save(characterID, economy, initialState = null) {
  ok(characters.updateCharacterRecord(characterID, record => ({ ...record,
    authoredAirTutorial: { ...(record.authoredAirTutorial || initialState), economy: clone(economy) },
  })));
  ok(require("../../gameStore").flushTableSync("characters"));
}
function prepare(session, state) {
  if (state.economy) return state;
  const record = characters.getCharacterRecord(state.characterID);
  const ship = characters.getActiveShipRecord(state.characterID);
  if (session._space || !record.stationID || ship?.ownerID !== state.characterID) throw graphError("AIR_ECONOMY_STATION_REQUIRED");
  const economy = {
    stationID: record.stationID, shipID: ship.itemID,
    previousTransactionIDs: wallet.getCharacterMarketTransactions(state.characterID).map(entry => entry.transactionID),
    previousOrderIDs: marketEscrow.listEscrowRecords().filter(entry => entry.ownerId === state.characterID).map(entry => entry.orderId),
    originalBoxIDs: [...new Set(state.miningSourceItemIDs || [])], retirements: {},
  };
  if (economy.previousOrderIDs.length > 8192 || economy.previousTransactionIDs.length > 8192 || economy.originalBoxIDs.length > 8 || economy.originalBoxIDs.some(id => !Number.isSafeInteger(id) || id <= 0)) throw graphError("AIR_ECONOMY_ITEM_ID_INVALID");
  save(state.characterID, economy, state);
  return characters.getCharacterRecord(state.characterID).authoredAirTutorial;
}
function quantity(characterID, locationID, flagID = null) {
  return inventory.listContainerItems(characterID, locationID)
    .filter(item => item.typeID === 60771 && (flagID === null || item.flagID === flagID))
    .reduce((sum, item) => sum + Number(item.stacksize ?? item.quantity), 0);
}
function evidence(session, task, state) {
  const record = characters.getCharacterRecord(state.characterID);
  const ship = characters.getActiveShipRecord(state.characterID);
  const economy = state.economy;
  if (!economy || ship?.ownerID !== state.characterID) return false;
  if (task === "2.2.05_undock") return Boolean(session._space && !record.stationID && !record.structureID && !inventory.isCapsuleTypeID(ship.typeID) && ship.locationID === Number(session.solarsystemid2 || session.solarsystemid));
  if (session._space || record.stationID !== economy.stationID) return false;
  if (task === "2.2.01_move_ore") return ship.itemID === economy.shipID && quantity(state.characterID, economy.stationID, inventory.ITEM_FLAGS.HANGAR) >= 114 && quantity(state.characterID, ship.itemID) === 0;
  if (task === "2.2.02_market_introduction") {
    const sold = wallet.getCharacterMarketTransactions(state.characterID)
      .filter(entry => !economy.previousTransactionIDs.includes(entry.transactionID) && entry.sellerID === state.characterID && entry.buyerID !== state.characterID && entry.typeID === 60771 && entry.stationID === economy.stationID && entry.quantity > 0 && entry.price > 0)
      .reduce((sum, entry) => sum + entry.quantity, 0);
    const listed = marketEscrow.listEscrowRecords()
      .filter(entry => !economy.previousOrderIDs.includes(entry.orderId) && entry.escrowType === "sell" && entry.escrowState === "active" && entry.ownerId === state.characterID && entry.sourceOwnerId === state.characterID && !entry.isCorp && entry.typeId === 60771 && entry.stationId === economy.stationID)
      .reduce((sum, entry) => sum + Math.min(entry.remainingQuantity, quantity(state.characterID, entry.escrowLocationID, inventory.ITEM_FLAGS.HANGAR)), 0);
    return sold + listed >= 114 && quantity(state.characterID, ship.itemID) === 0 && quantity(state.characterID, economy.stationID, inventory.ITEM_FLAGS.HANGAR) === 0;
  }
  return ["2.2.03_wallet_introduction", "2.2.04_acp_goal_introduction"].includes(task);
}
function retireBoxes(context) {
  const { root, instance, session, parameters: p } = context;
  checkCharacter(instance, p);
  const state = characters.getCharacterRecord(root.characterID)?.authoredAirTutorial;
  if (root.ownerKey !== "air" || root.graphID !== 712 || instance.graphID !== 712 || session?.characterID !== root.characterID || session.socket?.destroyed || !state?.economy || p.type_id !== 60784 || p.quantity_to_keep || p.quantity && p.quantity !== 1) throw graphError("AIR_ECONOMY_GRAPH_FORBIDDEN");
  const economy = clone(state.economy);
  for (const itemID of economy.originalBoxIDs) {
    let intent = economy.retirements[itemID];
    if (!intent) {
      const item = inventory.findItemById(itemID);
      if (!item || item.ownerID !== root.characterID) {
        economy.retirements[itemID] = { status: "relinquished" };
        save(root.characterID, economy);
        continue;
      }
      if (item.typeID !== 60784) throw graphError("AIR_ECONOMY_ITEM_TYPE_CHANGED");
      intent = economy.retirements[itemID] = {
        status: "prepared", key: `${effectKey(instance, context.node)}:box:${itemID}`,
        from: { ownerID: item.ownerID, locationID: item.locationID, flagID: item.flagID },
      };
    }
    if (intent.status !== "prepared") continue;
    // Retry the durability fence too: a failed journal flush leaves cache state.
    save(root.characterID, economy);
    const result = ok(custody.transfer({ items: [{ itemID, quantity: 1 }],
      from: custody.custodyRef.ownerLocation(intent.from.ownerID, intent.from.locationID, intent.from.flagID),
      to: custody.custodyRef.void(), actor: root.characterID,
      reason: custody.CUSTODY_REASON.AIR_TUTORIAL_CONSUME, idempotencyKey: intent.key,
    }));
    intent.status = "complete";
    save(root.characterID, economy);
    if (!result.duplicate) for (const change of result.data?.changes || []) {
      if (change.item) characters.syncInventoryItemForSession(session, change.item, change.previousData || change.previousState || {}, { emitCfgLocation: true });
    }
  }
  return {};
}
function register(graphs) {
  graphs.registerAtom(4, 419, context => context.root.graphID === 712
    ? retireBoxes(context)
    : require("./airMiningRuntime").retainOre(context),
  ({ graphID, ownerKey }) => ownerKey === "air" && [711, 737, 712].includes(graphID));
}
module.exports = { prepare, evidence, register };
