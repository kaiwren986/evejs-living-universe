"use strict";

// The ordinary inventory moniker used by native DogmaLocation when a fitted
// module is dropped into PlayerTrade. Escrow remains owned by TradeMgr.
const BaseService = require("../../baseService");
const { throwWrappedUserError } = require("../../../common/machoErrors");

const METHODS = new Set(["GetSelfInvItem", "GetItem", "GetItemByID", "List", "ListByFlags", "Add", "MultiAdd"]);

module.exports = {
  _getTradeInventoryService() {
    return this.serviceManager?.lookup("trademgr") || null;
  },

  callMethod(method, args, session, kwargs, callContext = null) {
    const context = this._getBoundContext(session);
    if (context?.kind === "tradeInventory") {
      const tradeMgr = this._getTradeInventoryService();
      const trade = tradeMgr?.getInventoryTrade(context.inventoryID, session);
      if (!trade) throwWrappedUserError("FakeItemNotFound");
      const name = BaseService.normalizeMethodName(method);
      if (!METHODS.has(name)) {
        throwWrappedUserError("CustomNotify", { notify: "That action is not available on a trade inventory." });
      }
      // Run the normal service action gates/capture, then the ordinary handler
      // dispatches this checked view. Never swap the session's bound object.
    }
    return BaseService.prototype.callMethod.call(this, method, args, session, kwargs, callContext);
  },

  _dispatchTradeInventory(method, args, session, kwargs) {
    const context = this._getBoundContext(session);
    if (context?.kind !== "tradeInventory") return null;
    const tradeMgr = this._getTradeInventoryService();
    const trade = tradeMgr?.getInventoryTrade(context.inventoryID, session);
    if (!trade) throwWrappedUserError("FakeItemNotFound");
    if (method === "GetSelfInvItem" || method === "GetItem") {
      const itemID = args?.length ? this._normalizeInventoryId(args[0], 0) : trade.tradeContainerID;
      if (itemID !== trade.tradeContainerID) throwWrappedUserError("FakeItemNotFound");
      return this._buildInventoryPackedRow(tradeMgr.getInventoryTradeItem(trade, session));
    }
    if (method === "List" || method === "ListByFlags") {
      const raw = method === "ListByFlags"
        ? args?.[0] ?? this._extractKwarg(kwargs, "flags") ?? []
        : args?.[0] ?? this._extractKwarg(kwargs, "flag") ?? null;
      const flags = raw === null ? null : method === "ListByFlags"
        ? this._normalizeFlagList(raw) : [this._normalizeInventoryId(raw, 0)];
      const rows = tradeMgr._listTradeItems(trade).filter((item) => !flags || flags.includes(Number(item.flagID)));
      // invCacheContainer.List iterates rows, unlike trademgr.List's metadata Row.
      return this._buildInventoryRemoteList(rows.map((item) => this._buildInventoryItemOverrides(session, item)));
    }
    const itemIDs = method === "Add" ? [this._normalizeInventoryId(args?.[0], 0)]
      : this._normalizeItemIdList(args?.[0] || []);
    const sourceID = this._normalizeInventoryId(args?.[1], 0);
    const quantity = this._normalizeQuantityArg(this._extractKwarg(kwargs, "qty") ?? this._extractKwarg(kwargs, "quantity"));
    const flag = this._extractKwarg(kwargs, "flag");
    if (flag !== undefined && flag !== null && this._normalizeInventoryId(flag, -1) !== 4) {
      throwWrappedUserError("CustomNotify", { notify: "Trade items use the trade hangar flag." });
    }
    const result = tradeMgr.addInventoryTradeItems(trade.tradeContainerID, itemIDs, sourceID, quantity, session);
    // Same interface as ordinary inventory Add; the native fitted producer
    // ignores this value. Its exact fitted-Trade TQ reply is not recorded.
    return method === "Add" ? result.stagedRootItemIDs[0] : true;
  },
};
