"use strict";
const gear = require("./crewEquipmentState");
function createCrewEquipmentEconomy({ mining, refining, hauling, manufacturing, selling, buying, industry, wallet }) {
  function states(id) { return { m: mining(id)?.mining, r: refining(id)?.refining, c: hauling(id)?.crew, f: manufacturing(id)?.manufacturing, s: selling(id)?.selling, b: buying(id)?.buying }; }
  function pending({ r, f, s, b }) { return Boolean(b?.job || s?.job || r?.job || (f?.job && f.job.phase !== "building")); }
  const productionStamp = ({ f, s }) => JSON.stringify([f?.stationID, f?.paused, f?.plan?.enabled, f?.plan?.orders, f?.job?.jobID,
    s?.stationID, s?.paused, s?.plan?.enabled, s?.plan?.orders]);
  return {
    funds(id) {
      const state = states(id), { r, f, s, b } = state;
      return { netSales: s?.netRevenue || 0, mineralSpent: b?.totalSpent || 0, refiningTax: r?.totalTaxPaid || 0, factoryFees: f?.totalFeesPaid || 0,
        walletBalance: wallet.getCharacterWallet(id)?.balance || 0, walletReserve: b?.plan?.walletReserve || 0, pending: pending(state) };
    },
    async assess(id, tiers) {
      let state = states(id), { m, r, c, f, s } = state;
      if (!f?.plan?.enabled || f.paused || !s?.plan.enabled || s.paused || f.stationID !== s.stationID) return { candidates: [], status: "waiting_for_factory" };
      if (pending(state)) return { candidates: [], status: "settlement_pending" };
      const acceptedProduction = productionStamp(state);
      const assessed = await Promise.all(f.plan.orders.map(order => industry.assess(id, f.stationID, order, {
        incomingQuantity: f.job?.summary.productTypeID === order.recipe.productTypeID ? f.job.summary.quantity : 0,
      })));
      // Quotes await market RPC. A different queue/job needs a new capital and
      // demand assessment; freshly idle or paused resource teams need no gear.
      state = states(id);
      if (productionStamp(state) !== acceptedProduction) return { candidates: [], status: "waiting_for_useful_work" };
      if (pending(state)) return { candidates: [], status: "settlement_pending" };
      ({ m, r, c, f, s } = state);
      const profitable = assessed.filter(row => row.profit?.allowed && row.profit.expectedProfit > 0 && row.summary?.timeSeconds > 0);
      if (!profitable.length) return { candidates: [], status: "waiting_for_profitable_demand" };
      const rate = Math.max(...profitable.map(row => row.profit.expectedProfit * 3600 / row.summary.timeSeconds));
      const active = {
        mining: Boolean(m?.plan.enabled && m.plan.followProduction && !m.paused && m.job && r?.plan.enabled && r.plan.followProduction && !r.paused && c?.standingOrder?.enabled && c.standingOrder.followProduction && !c.standingOrder.paused),
        hauling: Boolean(c?.standingOrder?.enabled && c.standingOrder.followProduction && !c.standingOrder.paused && c.job?.cargo),
        manufacturing: f.job?.phase === "building",
      };
      const completed = { mining: m?.completedDeliveries || 0, hauling: c?.standingOrder?.completedDeliveries || 0, manufacturing: f.completedBatches };
      const candidates = gear.ROLES.filter(role => tiers[role] < 3 && active[role] && completed[role] >= (tiers[role] + 1) * 10)
        .map(role => ({ role, incrementalProfitPerHour: rate * 0.05 }));
      // Retain three replacement batches in cash in addition to the policy reserve.
      const workingCapitalISK = Math.ceil(Math.max(...profitable.map(row => row.profit.totalCost)) * 3 * 100) / 100;
      return { candidates, workingCapitalISK, status: "waiting_for_useful_work" };
    },
  };
}
function createCrewEquipmentPayment() {
  return { async debit(id, job) {
    const result = await require("../account/walletState").adjustCharacterBalanceAsync(id, -job.cost, {
      idempotencyKey: `crew-equipment:${job.role}:${job.tier}`, minimumBalance: job.minimumBalance,
      reason: `${gear.CATALOG[job.role].name} tier ${job.tier}`, entryTypeID: 2,
    }, { source: "crew-equipment" });
    if (!result.success) return result;
    if (require("../../gameStore").flushTableSync("characters")?.success !== true) {
      const error = Error("Equipment payment awaits durable confirmation"); error.code = "CREW_CUSTODY_PENDING"; throw error;
    }
    return result;
  } };
}
module.exports = { createCrewEquipmentEconomy, createCrewEquipmentPayment };
