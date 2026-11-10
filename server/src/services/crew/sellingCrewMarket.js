"use strict";
const { CrewError } = require("./crewService");
function createSellingCrewMarket({ items, worldData, productionTypes = () => [] }) {
  const native = require("../market/marketProxyService"), escrow = require("../market/marketEscrowState");
  const { marketDaemonClient } = require("../market/marketDaemonClient");
  function station(id) { return worldData.getStationByID(id); }
  function describe(typeID) {
    const type = items.getItemMetadata(typeID);
    if (!type || ![7, 8].includes(type.categoryID)) throw new CrewError("CREW_CARGO_INVALID", "Choose packaged ammo or modules.", 400);
    return { typeID, name: type.name, category: type.categoryID === 8 ? "Ammo" : "Module" };
  }
  function stock(ownerID, stationID, typeID) { return items.listContainerItems(ownerID, stationID, 4)
    .filter(i => i.typeID === typeID && i.singleton === 0 && !i.custodyReservation).reduce((sum, i) => sum + i.quantity, 0); }
  return { station, describe, stock,
    async catalog(ownerID, stationID) {
      const location = station(stationID); if (!location) throw new CrewError("CREW_STATION_INVALID", "Choose an NPC market station.", 400);
      const types = [...new Set([...productionTypes(ownerID), ...items.listContainerItems(ownerID, stationID, 4).filter(i => i.singleton === 0).map(i => i.typeID)])]
        .flatMap(id => { try { return [describe(id)]; } catch { return []; } }).slice(0, 20);
      return Promise.all(types.map(async type => {
        const book = await marketDaemonClient.call("GetOrders", { region_id: location.regionID, type_id: type.typeID });
        const bids = (book?.buys || []).filter(b => b.bid === true && b.source === "seed" && Number(b.station_id) === stationID && b.price > 0 && b.vol_remaining > 0).sort((a,b) => b.price-a.price);
        return { ...type, stock: stock(ownerID, stationID, type.typeID), bestPrice: bids[0]?.price || null,
          demand: bids.reduce((sum,b) => sum+b.vol_remaining,0) };
      }));
    },
    prepare: (id, stationID, order, tag) => native.prepareCrewSale(id, stationID, order, tag),
    settle: job => native.settleCrewSale(job.saga),
    acknowledge(job) { const result = escrow.acknowledgeCrewSale(job.saga.sellerCharacterID, job.saga.crewSale);
      if (!result.success) throw new CrewError("CREW_CUSTODY_PENDING", "Sale confirmation is pending. The saved sale will retry.", 503); },
  };
}
module.exports = { createSellingCrewMarket };
