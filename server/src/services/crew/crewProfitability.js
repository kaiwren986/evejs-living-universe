"use strict";

// Quotes only. Native trade/industry owners still settle every accepted effect.
function createCrewProfitability({ worldData, selling, items, now = Date.now } = {}) {
  const { marketDaemonClient } = require("../market/marketDaemonClient");
  const market = require("../market/marketProxyService");
  worldData ||= require("../../space/worldData");
  items ||= require("../inventory/itemStore");
  selling ||= id => require("./sellingCrewRuntime").getDefaultSellingCrewService().snapshot(id);
  const cents = value => Number.isFinite(value) && value >= 0 && Number.isSafeInteger(Math.round(value * 100)) ? Math.round(value * 100) : NaN;
  const positive = n => Number.isSafeInteger(n) && n > 0;
  function orders(book, side, stationID, typeID) {
    return (Array.isArray(book?.[side]) ? book[side] : []).filter(o => o.source === "seed" && o.bid === (side === "buys") &&
      Number(o.station_id) === stationID && Number(o.type_id) === typeID && /^\d+$/.test(String(o.order_id)) &&
      cents(o.price) > 0 && Math.abs(o.price * 100 - cents(o.price)) < 0.0001 && positive(o.vol_remaining) &&
      (o.min_volume == null || positive(o.min_volume)) && !market.isCrewQuoteOrderPending(o.order_id))
      .sort((a, b) => (side === "buys" ? b.price - a.price : a.price - b.price) || String(a.order_id).localeCompare(String(b.order_id))).slice(0, 256);
  }
  async function evaluate(ownerID, stationID, recipe, factoryFee, { targetStock, minimumMaterialPrice = {}, incomingQuantity = 0 } = {}) {
    const base = { productTypeID: recipe.productTypeID, name: recipe.name, quantity: recipe.quantity, checkedAtMs: now(), valuation: "local_replacement_cost" };
    const hold = (status, reason, details = {}) => ({ ...base, allowed: false, status, reason, ...details });
    const station = worldData.getStationByID(stationID), seller = selling(ownerID)?.selling;
    const rule = seller?.plan?.orders?.find(o => o.typeID === recipe.productTypeID);
    if (!seller?.plan?.enabled || seller.paused || seller.stationID !== stationID || !rule)
      return hold("waiting_for_sales_policy", "An active selling order at this factory is required.");
    if (targetStock != null && targetStock <= rule.reserve)
      return hold("selling_reserve_blocks_production", "The factory stock target must exceed the selling reserve.");
    if (!station || !positive(recipe.quantity) || !Array.isArray(recipe.materials) || !recipe.materials.length ||
        recipe.materials.some(m => !positive(m.typeID) || !positive(m.quantity)) || !Number.isFinite(cents(factoryFee)))
      return hold("waiting_for_market_prices", "The complete recipe and installation cost must be known.");
    try {
      const ids = [...new Set([recipe.productTypeID, ...recipe.materials.map(m => m.typeID)])];
      const books = new Map(await Promise.all(ids.map(async id => [id, await marketDaemonClient.call("GetOrders", { region_id: station.regionID, type_id: id })])));
      const finishedStock = items.listContainerItems(ownerID, stationID, 4).filter(i => i.typeID === recipe.productTypeID && i.singleton === 0 && !i.custodyReservation).reduce((n, i) => n + Math.max(0, i.quantity), 0);
      let committed = Math.max(0, finishedStock + incomingQuantity - rule.reserve);
      const committedSurplus = committed;
      let remaining = recipe.quantity, gross = 0, tax = 0;
      for (const bid of orders(books.get(recipe.productTypeID), "buys", stationID, recipe.productTypeID)) {
        if (bid.price < rule.minimumPrice) continue;
        const minimum = Math.min(bid.min_volume || 1, bid.vol_remaining), batch = rule.batchSize;
        if (batch < minimum || (targetStock != null && targetStock - rule.reserve < minimum)) continue;
        // Existing surplus gets first claim on the best bids. Price the next
        // batch against the remaining demand, not the same already-needed units.
        const allocated = Math.min(committed, bid.vol_remaining); committed -= allocated;
        const available = bid.vol_remaining - allocated;
        if (!available) continue;
        const quantity = Math.min(remaining, available), full = Math.floor(quantity / batch), tail = quantity % batch;
        const remainder = tail >= minimum ? tail : 0;
        const fullGross = cents(bid.price) * batch, tailGross = cents(bid.price) * remainder;
        const fullTax = full ? cents(market.quoteCrewSalesTax(ownerID, stationID, fullGross / 100)) : 0;
        const tailTax = remainder ? cents(market.quoteCrewSalesTax(ownerID, stationID, tailGross / 100)) : 0;
        gross += full * fullGross + tailGross; tax += full * fullTax + tailTax;
        remaining -= full * batch + remainder;
        if (!remaining) break;
      }
      if (remaining) return hold("waiting_for_profitable_demand", "Local bids above the selling floor cannot cover the full batch.");
      let materialCost = 0;
      const materials = [];
      for (const material of recipe.materials) {
        let needed = material.quantity, cost = 0;
        for (const ask of orders(books.get(material.typeID), "sells", stationID, material.typeID)) {
          const take = Math.min(needed, ask.vol_remaining);
          if (take < Math.min(ask.min_volume || 1, ask.vol_remaining)) continue;
          cost += take * Math.max(cents(ask.price), cents(minimumMaterialPrice[material.typeID] || 0)); needed -= take;
          if (!needed) break;
        }
        if (needed) return hold("waiting_for_market_prices", "Local mineral asks cannot price the full recipe.", { missingTypeID: material.typeID });
        materialCost += cost; materials.push({ typeID: material.typeID, quantity: material.quantity, replacementCost: cost / 100 });
      }
      const fee = cents(factoryFee), net = gross - tax, cost = materialCost + fee, profit = net - cost;
      if (![gross, tax, net, materialCost, fee, cost, profit].every(Number.isSafeInteger))
        return hold("waiting_for_market_prices", "The market quote exceeds supported precision.");
      const details = { grossRevenue: gross / 100, salesTax: tax / 100, netRevenue: net / 100, materialCost: materialCost / 100,
        factoryFee: fee / 100, totalCost: cost / 100, expectedProfit: profit / 100, committedSurplus, materials };
      // Require a positive cent after exact native tax rounding; break-even waits.
      return profit > 0 ? { ...base, ...details, allowed: true, status: "profitable" }
        : hold("unprofitable", "Net sales do not exceed replacement minerals and installation fees.", details);
    } catch {
      return hold("market_unavailable", "Profit cannot be confirmed while the market is unavailable.");
    }
  }
  return { evaluate };
}
module.exports = { createCrewProfitability };
