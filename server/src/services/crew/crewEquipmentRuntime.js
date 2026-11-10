"use strict";
let service;
function getDefaultCrewEquipmentService() {
  if (!service) {
    const { createCrewEquipmentEconomy, createCrewEquipmentPayment } = require("./crewEquipmentEconomy");
    const items = require("../inventory/itemStore"), worldData = require("../../space/worldData");
    service = require("./crewEquipmentService").createCrewEquipmentService({
      repo: require("../../gameStore/tableRepository").createTableRepository("service:crew-equipment"), enabled: require("../../config").crewOperationsEnabled === true,
      payment: createCrewEquipmentPayment(), economy: createCrewEquipmentEconomy({
        mining: id => require("./miningCrewRuntime").getDefaultMiningCrewService().snapshot(id), refining: id => require("./refiningCrewRuntime").getDefaultRefiningCrewService().snapshot(id),
        hauling: id => require("./crewRuntime").getDefaultCrewService().snapshot(id), manufacturing: id => require("./manufacturingCrewRuntime").getDefaultManufacturingCrewService().snapshot(id),
        selling: id => require("./sellingCrewRuntime").getDefaultSellingCrewService().snapshot(id), buying: id => require("./buyingCrewRuntime").getDefaultBuyingCrewService().snapshot(id),
        industry: require("./manufacturingCrewIndustry").createManufacturingCrewIndustry({ items, worldData }), wallet: require("../account/walletState"),
      }),
    });
  }
  return service;
}
async function drainCrewEquipment() { if (service) await service.drain(); }
module.exports = { getDefaultCrewEquipmentService, drainCrewEquipment };
